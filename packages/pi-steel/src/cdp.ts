/**
 * Minimal Chrome DevTools Protocol client for the Steel browser.
 *
 * Deliberately dependency-free: Node 22+ ships a global `WebSocket`, and the
 * subset of CDP needed to drive a page (attach, navigate, evaluate, input,
 * screenshot) is small. Pulling in Playwright would add ~300 MB and a browser
 * download to a setup whose whole point is that the browser lives on the
 * cluster.
 *
 * Two host quirks this file exists to paper over, both of which bite when Steel
 * is behind a reverse proxy rather than on localhost:
 *
 * 1. Chromium refuses DevTools HTTP requests whose Host header is neither an IP
 *    nor localhost. Steel's bundled nginx forwards Host verbatim, so CDP through
 *    a proxy fails with "Host header is specified and is not an IP address or
 *    localhost" unless the proxy rewrites Host to `localhost`. If you expose
 *    Steel remotely, configure that rewrite (see the package README).
 * 2. Where that rewrite is in place, `webSocketDebuggerUrl` comes back as
 *    `ws://localhost/...`, so the authority must be swapped back to the real
 *    host before connecting. That is what `attach` does below, which also makes
 *    the direct-to-localhost case a no-op.
 */

const CONNECT_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 45_000;

interface Pending {
	resolve: (value: any) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

/** One attached page session. Commands are serialized over a single socket. */
export class CdpSession {
	private nextId = 0;
	private readonly pending = new Map<number, Pending>();
	private closed = false;

	private constructor(
		private readonly ws: WebSocket,
		readonly sessionId: string,
		readonly targetId: string,
	) {}

	/**
	 * Connect to the browser, attach to an existing page target (Steel always
	 * opens one), and return a ready session. Never creates a second page: the
	 * extra tab would be invisible to the session viewer and leak.
	 */
	static async attach(base: string, signal?: AbortSignal): Promise<CdpSession> {
		const version = await fetchJson(`${base}/json/version`, signal);
		const advertised: string = version.webSocketDebuggerUrl;
		if (!advertised) throw new Error(`CDP endpoint ${base} did not advertise a webSocketDebuggerUrl`);
		// Advertised authority is localhost (gateway rewrite); use the real host.
		const wsUrl = advertised.replace(
			/^wss?:\/\/[^/]+/,
			base.replace(/^https/, "wss").replace(/^http:/, "ws:"),
		);

		const ws = await openSocket(wsUrl);
		const partial = new CdpSession(ws, "", "");
		ws.onmessage = (event: MessageEvent) => partial.handleMessage(String(event.data));
		ws.onclose = () => partial.failAll(new Error("CDP socket closed"));

		const { targetInfos } = await partial.send("Target.getTargets");
		const page = (targetInfos as any[]).find((target) => target.type === "page");
		if (!page) {
			ws.close();
			throw new Error("Steel session has no page target to attach to");
		}
		const { sessionId } = await partial.send("Target.attachToTarget", {
			targetId: page.targetId,
			flatten: true,
		});
		const session = new CdpSession(ws, sessionId, page.targetId);
		// Re-point socket handlers at the real session object.
		ws.onmessage = (event: MessageEvent) => session.handleMessage(String(event.data));
		ws.onclose = () => session.failAll(new Error("CDP socket closed"));
		await session.send("Page.enable");
		await session.send("Runtime.enable");
		return session;
	}

	private handleMessage(raw: string): void {
		let message: any;
		try {
			message = JSON.parse(raw);
		} catch {
			return;
		}
		if (typeof message.id !== "number") return; // event, not a command reply
		const entry = this.pending.get(message.id);
		if (!entry) return;
		this.pending.delete(message.id);
		clearTimeout(entry.timer);
		if (message.error) entry.reject(new Error(`CDP ${message.error.message ?? "error"}`));
		else entry.resolve(message.result ?? {});
	}

	private failAll(error: Error): void {
		this.closed = true;
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
		this.pending.clear();
	}

	/** Send a CDP command. Session-scoped once attached. */
	send(method: string, params: Record<string, unknown> = {}): Promise<any> {
		if (this.closed) return Promise.reject(new Error("CDP session is closed"));
		const id = ++this.nextId;
		const payload: Record<string, unknown> = { id, method, params };
		if (this.sessionId) payload.sessionId = this.sessionId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`CDP ${method} timed out after ${COMMAND_TIMEOUT_MS}ms`));
			}, COMMAND_TIMEOUT_MS);
			timer.unref?.();
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.ws.send(JSON.stringify(payload));
			} catch (error) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	/** Evaluate an expression in the page and return it by value. */
	async evaluate<T = unknown>(expression: string): Promise<T> {
		const result = await this.send("Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: true,
		});
		if (result.exceptionDetails) {
			const text =
				result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "evaluation failed";
			throw new Error(`Page evaluation failed: ${String(text).split("\n")[0]}`);
		}
		return result.result?.value as T;
	}

	close(): void {
		this.closed = true;
		try {
			this.ws.close();
		} catch {
			/* already gone */
		}
	}
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<any> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
	timer.unref?.();
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok) throw new Error(`${url} returned ${response.status} ${response.statusText}`);
		return await response.json();
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

function openSocket(url: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		let socket: WebSocket;
		try {
			socket = new WebSocket(url);
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		const timer = setTimeout(() => {
			try {
				socket.close();
			} catch {
				/* noop */
			}
			reject(new Error(`CDP WebSocket connect timed out (${url})`));
		}, CONNECT_TIMEOUT_MS);
		timer.unref?.();
		socket.onopen = () => {
			clearTimeout(timer);
			resolve(socket);
		};
		socket.onerror = () => {
			clearTimeout(timer);
			reject(
				new Error(
					`CDP WebSocket failed to connect to ${url}. The CDP endpoint is internal-only — check you are on the home network or VPN.`,
				),
			);
		};
	});
}

/** Wait for the page to settle after a navigation or click. */
export async function waitForIdle(session: CdpSession, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	// Poll readyState rather than relying on lifecycle events, which are easy to
	// miss when the navigation started before we subscribed.
	while (Date.now() < deadline) {
		const state = await session.evaluate<string>("document.readyState").catch(() => "loading");
		if (state === "complete") return;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

/** CSS-escape a selector for embedding in an evaluated expression. */
export function jsString(value: string): string {
	return JSON.stringify(value);
}
