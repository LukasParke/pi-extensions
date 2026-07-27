/**
 * Steel stateful browser session tools.
 *
 * The stateless `steel_scrape` / `steel_screenshot` tools each get a fresh page,
 * which means anything behind a login is unreachable. These tools give the model
 * one persistent browser it can drive across turns:
 *
 *   steel_session   action: start | status | end   (lifecycle + session viewer)
 *   steel_navigate  go to a URL, return the settled page as markdown-ish text
 *   steel_act       click / type / press / select / scroll / wait
 *   steel_read      read the current page (text, links, forms, or a selector)
 *   steel_look      screenshot the current page and return it as an image
 *
 * Design decisions worth knowing:
 *
 * - **One session per Pi session, not per tool call.** A browser is expensive
 *   and stateful; the point is continuity. The id is held in module state and
 *   released on `session_shutdown` so a crashed or closed Pi does not leak a
 *   live Chromium on the host running Steel.
 * - **Actions go over CDP, not REST.** Steel's API has no click/type endpoint
 *   (verified against its OpenAPI document) so anything interactive must use the
 *   DevTools protocol. See src/cdp.ts for the dependency-free client.
 * - **CDP is a privileged port.** It is effectively remote code execution with
 *   no per-request auth, so do not expose it to the public internet. Steel's own
 *   docs say the same. Keep it on localhost or behind a private network.
 * - **Read returns structured text, not raw HTML.** Raw DOM burns context for no
 *   benefit; the model wants visible text plus actionable elements.
 *
 * Configuration lives in ~/.pi/steel.json or STEEL_* env vars; see src/config.ts.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CdpSession, jsString, waitForIdle } from "../src/cdp.ts";
import { headers } from "../src/client.ts";
import { cdpBase, type SteelConfig, steelConfig } from "../src/config.ts";

/** Uniform detail shape for steel_session so every branch types identically. */
interface LookDetails {
	url?: string;
	bytes: number;
	file?: string;
	fullPage: boolean;
}

interface SessionDetails {
	action: "start" | "status" | "end";
	live?: boolean;
	id?: string;
	url?: string;
	released?: string | null;
	viewerUrl?: string | null;
}

/** Module-scoped live session. One browser per Pi session. */
interface LiveSession {
	id: string;
	startedAt: number;
	viewerUrl?: string;
	lastUrl?: string;
	cdp?: CdpSession;
}
let live: LiveSession | undefined;

async function api(
	config: SteelConfig,
	route: string,
	init: RequestInit & { timeoutMs?: number } = {},
): Promise<any> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 45_000);
	timer.unref?.();
	try {
		const response = await fetch(`${config.baseUrl}${route}`, {
			...init,
			headers: { ...headers(config), ...(init.headers as Record<string, string> | undefined) },
			signal: controller.signal,
		});
		const text = await response.text();
		if (!response.ok) {
			let detail = text.slice(0, 400);
			try {
				const parsed = JSON.parse(text);
				if (parsed?.message) detail = String(parsed.message);
			} catch {
				/* keep raw */
			}
			throw new Error(`Steel ${route} returned ${response.status}: ${detail}`);
		}
		return text ? JSON.parse(text) : {};
	} finally {
		clearTimeout(timer);
	}
}

/** Ensure a live Steel session plus an attached CDP page. */
async function ensureSession(config: SteelConfig, signal?: AbortSignal): Promise<LiveSession> {
	if (live?.cdp) return live;
	if (!live) {
		const created = await api(config, "/v1/sessions", {
			method: "POST",
			body: JSON.stringify({
				blockAds: true,
				timeout: config.sessionTimeoutMs,
				dimensions: { width: 1280, height: 800 },
			}),
		});
		live = {
			id: created.id,
			startedAt: Date.now(),
			viewerUrl: created.sessionViewerUrl,
		};
	}
	try {
		live.cdp = await CdpSession.attach(cdpBase(config), signal);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Started Steel session ${live.id} but could not attach to its browser over CDP: ${message}`,
		);
	}
	return live;
}

async function releaseSession(config: SteelConfig): Promise<string | undefined> {
	if (!live) return undefined;
	const id = live.id;
	live.cdp?.close();
	try {
		await api(config, `/v1/sessions/${id}/release`, { method: "POST", timeoutMs: 20_000 });
	} catch {
		// Best effort: a released-or-gone session must not block cleanup.
	}
	live = undefined;
	return id;
}

async function capped(text: string, label: string): Promise<string> {
	const result = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!result.truncated) return result.content;
	return `${result.content}\n\n[truncated ${label}; use steel_read with a selector to narrow it down]`;
}

/**
 * Page reader. Runs entirely inside the page so only the distilled result
 * crosses the wire.
 */
const READ_SCRIPT = (mode: string, selector: string | undefined) => `(() => {
  const clamp = (s, n) => (s || "").replace(/\\s+/g, " ").trim().slice(0, n);
  const root = ${selector ? `document.querySelector(${jsString(selector)})` : "document.body"};
  if (!root) return { error: "selector matched nothing" };
  const out = { url: location.href, title: document.title };
  const mode = ${jsString(mode)};
  if (mode === "text" || mode === "all") {
    out.text = clamp(root.innerText, 40000);
  }
  if (mode === "links" || mode === "all") {
    out.links = [...root.querySelectorAll("a[href]")].slice(0, 300).map((a) => ({
      text: clamp(a.innerText, 120), href: a.href,
    })).filter((l) => l.text || l.href);
  }
  if (mode === "forms" || mode === "all") {
    // Actionable elements with a selector the model can feed back to steel_act.
    // Always produce SOME usable selector. id/name are best, but plenty of
    // real buttons have neither (a bare <button>Submit</button>), and returning
    // null there forces the caller to guess a structural selector. Fall back to
    // a :nth-of-type path anchored at the nearest id, then to text matching.
    const structural = (el) => {
      const parts = [];
      let node = el;
      while (node && node !== document.body && parts.length < 6) {
        const tag = node.tagName.toLowerCase();
        if (node.id) { parts.unshift("#" + CSS.escape(node.id)); break; }
        const parent = node.parentElement;
        if (!parent) { parts.unshift(tag); break; }
        const sameTag = [...parent.children].filter((c) => c.tagName === node.tagName);
        parts.unshift(sameTag.length > 1 ? tag + ":nth-of-type(" + (sameTag.indexOf(node) + 1) + ")" : tag);
        node = parent;
      }
      return parts.join(" > ");
    };
    const describe = (el) => {
      const id = el.id ? "#" + CSS.escape(el.id) : null;
      const name = el.name ? el.tagName.toLowerCase() + "[name=" + JSON.stringify(el.name) + "]" : null;
      const selector = id || name || structural(el);
      let unique = false;
      try { unique = document.querySelectorAll(selector).length === 1; } catch { unique = false; }
      return {
        selector,
        unique,
        tag: el.tagName.toLowerCase(),
        type: el.type || null,
        label: clamp(el.labels?.[0]?.innerText || el.getAttribute("aria-label") || el.placeholder || el.value || el.innerText, 80),
        required: !!el.required,
      };
    };
    out.fields = [...root.querySelectorAll("input:not([type=hidden]), textarea, select")].slice(0, 100).map(describe);
    out.buttons = [...root.querySelectorAll("button, input[type=submit], [role=button]")].slice(0, 60).map(describe);
  }
  return out;
})()`;

function renderRead(data: any): string {
	if (data?.error) return `Read failed: ${data.error}`;
	const lines: string[] = [`url: ${data.url}`, data.title ? `title: ${data.title}` : ""].filter(Boolean);
	if (data.text) lines.push("", "## text", data.text);
	if (Array.isArray(data.links) && data.links.length) {
		lines.push("", `## links (${data.links.length})`);
		for (const link of data.links) lines.push(`- ${link.text || "(no text)"} -> ${link.href}`);
	}
	if (Array.isArray(data.fields) && data.fields.length) {
		lines.push("", `## fields (${data.fields.length})`);
		for (const field of data.fields) {
			lines.push(
				`- ${field.selector}${field.unique ? "" : " (NOT unique — refine)"} ${field.tag}${field.type ? `[${field.type}]` : ""}${
					field.required ? " required" : ""
				}${field.label ? ` — ${field.label}` : ""}`,
			);
		}
	}
	if (Array.isArray(data.buttons) && data.buttons.length) {
		lines.push("", `## buttons (${data.buttons.length})`);
		for (const button of data.buttons) {
			lines.push(
				`- ${button.selector}${button.unique ? "" : " (NOT unique — refine)"} ${button.tag}${button.label ? ` — ${button.label}` : ""}`,
			);
		}
	}
	return lines.join("\n");
}

function imageMime(bytes: Buffer): string {
	if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
	if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
	return "image/png";
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "steel_session",
		label: "Steel Session",
		description:
			"Manage the persistent Steel browser session used by steel_navigate / steel_act / steel_read / steel_look. Start one to keep cookies and login state across steps; end it when done to free the browser. Only one session is live at a time.",
		parameters: Type.Object(
			{
				action: StringEnum(["start", "status", "end"], {
					description: "start a session (no-op if one is live), report status, or release it.",
				}),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params: any, signal) {
			const config = await steelConfig();
			if (params.action === "end") {
				const id = await releaseSession(config);
				return {
					content: [{ type: "text" as const, text: id ? `Released Steel session ${id}.` : "No live Steel session." }],
					details: { action: "end", released: id ?? null } as SessionDetails,
				};
			}
			if (params.action === "status") {
				if (!live) {
					return {
						content: [{ type: "text" as const, text: "No live Steel session. Use action:'start' to open one." }],
						details: { action: "status", live: false } as SessionDetails,
					};
				}
				const age = Math.round((Date.now() - live.startedAt) / 1000);
				const url = live.cdp ? await live.cdp.evaluate<string>("location.href").catch(() => live?.lastUrl) : live.lastUrl;
				return {
					content: [
						{
							type: "text" as const,
							text: [
								`Steel session ${live.id} (${age}s old)`,
								`current url: ${url ?? "about:blank"}`,
								live.viewerUrl ? `viewer: ${live.viewerUrl}` : "",
							]
								.filter(Boolean)
								.join("\n"),
						},
					],
					details: { action: "status", live: true, id: live.id, url } as SessionDetails,
				};
			}
			const session = await ensureSession(config, signal);
			return {
				content: [
					{
						type: "text" as const,
						text: [
							`Steel session ${session.id} is live (timeout ${Math.round(config.sessionTimeoutMs / 60_000)}m).`,
							`Cookies and storage persist across steel_navigate / steel_act / steel_read calls.`,
							session.viewerUrl ? `Watch it: ${session.viewerUrl}` : "",
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
				details: { action: "start", id: session.id, viewerUrl: session.viewerUrl ?? null } as SessionDetails,
			};
		},
	});

	pi.registerTool({
		name: "steel_navigate",
		label: "Steel Navigate",
		description:
			"Navigate the persistent Steel browser to a URL and return the settled page's visible text. Starts a session automatically if none is live. Cookies and login state from earlier steps are kept.",
		parameters: Type.Object(
			{
				url: Type.String({ description: "Absolute URL to open." }),
				waitMs: Type.Optional(
					Type.Number({ minimum: 0, maximum: 30_000, description: "Extra settle time after load, for late-hydrating apps." }),
				),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params: any, signal) {
			const config = await steelConfig();
			const session = await ensureSession(config, signal);
			const cdp = session.cdp!;
			await cdp.send("Page.navigate", { url: params.url });
			await waitForIdle(cdp);
			if (params.waitMs) await new Promise((resolve) => setTimeout(resolve, params.waitMs));
			session.lastUrl = params.url;
			const data = await cdp.evaluate<any>(READ_SCRIPT("text", undefined));
			return {
				content: [{ type: "text" as const, text: await capped(renderRead(data), "page text") }],
				details: { url: data?.url ?? params.url, title: data?.title, sessionId: session.id },
			};
		},
	});

	pi.registerTool({
		name: "steel_act",
		label: "Steel Act",
		description:
			"Interact with the current page in the persistent Steel browser: click an element, type into a field, press a key, select an option, or scroll. Use steel_read with mode:'forms' first to discover selectors. This is what makes logins and multi-step flows possible.",
		parameters: Type.Object(
			{
				action: StringEnum(["click", "type", "press", "select", "scroll", "wait"], {
					description:
						"click: click a selector. type: focus a selector and enter text. press: send a key (e.g. Enter). select: choose an option value. scroll: scroll the page. wait: just settle.",
				}),
				selector: Type.Optional(Type.String({ description: "CSS selector for click / type / select." })),
				text: Type.Optional(Type.String({ description: "Text to type, key to press, or option value to select." })),
				clear: Type.Optional(Type.Boolean({ description: "Clear the field before typing. Defaults to true for type." })),
				waitMs: Type.Optional(
					Type.Number({ minimum: 0, maximum: 30_000, description: "Settle time after the action. Defaults to 1000." }),
				),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params: any, signal) {
			const config = await steelConfig();
			const session = await ensureSession(config, signal);
			const cdp = session.cdp!;
			const needsSelector = ["click", "type", "select"].includes(params.action);
			if (needsSelector && !params.selector) {
				throw new Error(`steel_act action:'${params.action}' requires a selector.`);
			}
			const settle = params.waitMs ?? 1000;
			let summary: string;

			switch (params.action) {
				case "click": {
					// Scroll into view, then dispatch a real click so React-style
					// handlers and anchors both work.
					const ok = await cdp.evaluate<boolean>(`(() => {
            const el = document.querySelector(${jsString(params.selector)});
            if (!el) return false;
            el.scrollIntoView({ block: "center" });
            el.click();
            return true;
          })()`);
					if (!ok) throw new Error(`No element matched ${params.selector}`);
					summary = `Clicked ${params.selector}`;
					break;
				}
				case "type": {
					if (params.text === undefined) throw new Error("steel_act action:'type' requires text.");
					// Focus via the DOM, then use CDP key events so the page sees real
					// input (value assignment alone misses most framework listeners).
					const focused = await cdp.evaluate<boolean>(`(() => {
            const el = document.querySelector(${jsString(params.selector)});
            if (!el) return false;
            el.scrollIntoView({ block: "center" });
            el.focus();
            ${params.clear === false ? "" : 'if ("value" in el) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); }'}
            return true;
          })()`);
					if (!focused) throw new Error(`No element matched ${params.selector}`);
					await cdp.send("Input.insertText", { text: params.text });
					// Fire input/change so validation and controlled components update.
					await cdp.evaluate(`(() => {
            const el = document.querySelector(${jsString(params.selector)});
            if (el) { el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }
          })()`);
					summary = `Typed ${params.text.length} chars into ${params.selector}`;
					break;
				}
				case "press": {
					const key = params.text || "Enter";
					const code = key === "Enter" ? 13 : key === "Tab" ? 9 : key === "Escape" ? 27 : 0;
					await cdp.send("Input.dispatchKeyEvent", {
						type: "keyDown",
						key,
						code: key,
						windowsVirtualKeyCode: code,
						nativeVirtualKeyCode: code,
						text: key === "Enter" ? "\r" : undefined,
					});
					await cdp.send("Input.dispatchKeyEvent", {
						type: "keyUp",
						key,
						code: key,
						windowsVirtualKeyCode: code,
						nativeVirtualKeyCode: code,
					});
					summary = `Pressed ${key}`;
					break;
				}
				case "select": {
					if (params.text === undefined) throw new Error("steel_act action:'select' requires text (the option value).");
					const ok = await cdp.evaluate<boolean>(`(() => {
            const el = document.querySelector(${jsString(params.selector)});
            if (!el) return false;
            el.value = ${jsString(params.text)};
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
          })()`);
					if (!ok) throw new Error(`No element matched ${params.selector}`);
					summary = `Selected ${params.text} in ${params.selector}`;
					break;
				}
				case "scroll": {
					await cdp.evaluate(
						params.selector
							? `document.querySelector(${jsString(params.selector)})?.scrollIntoView({ block: "center" })`
							: `window.scrollBy(0, window.innerHeight * 0.9)`,
					);
					summary = params.selector ? `Scrolled ${params.selector} into view` : "Scrolled down one viewport";
					break;
				}
				default:
					summary = "Waited";
			}

			if (settle) await new Promise((resolve) => setTimeout(resolve, settle));
			await waitForIdle(cdp, 5000);
			const url = await cdp.evaluate<string>("location.href").catch(() => undefined);
			if (url) session.lastUrl = url;
			return {
				content: [{ type: "text" as const, text: `${summary}. Now at ${url ?? "unknown url"}.` }],
				details: { action: params.action, selector: params.selector ?? null, url },
			};
		},
	});

	pi.registerTool({
		name: "steel_read",
		label: "Steel Read",
		description:
			"Read the current page in the persistent Steel browser. mode:'text' for visible text, 'links' for anchors, 'forms' to discover input/button selectors for steel_act, 'all' for everything. Pass a selector to scope it.",
		parameters: Type.Object(
			{
				mode: Type.Optional(
					StringEnum(["text", "links", "forms", "all"], { description: "What to extract. Defaults to 'text'." }),
				),
				selector: Type.Optional(Type.String({ description: "Scope extraction to this CSS selector." })),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params: any, signal) {
			const config = await steelConfig();
			const session = await ensureSession(config, signal);
			const data = await session.cdp!.evaluate<any>(READ_SCRIPT(params.mode ?? "text", params.selector));
			return {
				content: [{ type: "text" as const, text: await capped(renderRead(data), "page content") }],
				details: { mode: params.mode ?? "text", url: data?.url, sessionId: session.id },
			};
		},
	});

	pi.registerTool({
		name: "steel_look",
		label: "Steel Look",
		description:
			"Screenshot the current page in the persistent Steel browser and return it as an image, so you can see the rendered state mid-flow. Use to verify a click worked or to read something only visible after rendering.",
		parameters: Type.Object(
			{
				fullPage: Type.Optional(Type.Boolean({ description: "Capture the whole scrollable page, not just the viewport." })),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params: any, signal) {
			const config = await steelConfig();
			const session = await ensureSession(config, signal);
			const shot = await session.cdp!.send("Page.captureScreenshot", {
				format: "png",
				captureBeyondViewport: params.fullPage === true,
			});
			const bytes = Buffer.from(shot.data, "base64");
			const mimeType = imageMime(bytes);
			const url = await session.cdp!.evaluate<string>("location.href").catch(() => session.lastUrl);
			if (bytes.length > config.maxInlineImageBytes) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Screenshot is ${formatSize(bytes.length)}, too large to inline. Try fullPage:false or scope with steel_read.`,
						},
					],
					details: { url, bytes: bytes.length, fullPage: params.fullPage === true } as LookDetails,
				};
			}
			return {
				content: [
					{ type: "text" as const, text: `Current page: ${url ?? "unknown"} (${formatSize(bytes.length)})` },
					{ type: "image" as const, data: bytes.toString("base64"), mimeType },
				],
				details: { url, bytes: bytes.length, fullPage: params.fullPage === true } as LookDetails,
			};
		},
	});

	// A live Chromium must not outlive the Pi session that opened it. Release on
	// shutdown; best-effort, never blocks exit for long.
	pi.on("session_shutdown", async () => {
		if (!live) return;
		const config = await steelConfig();
		await Promise.race([releaseSession(config), new Promise((resolve) => setTimeout(resolve, 5000))]);
	});

	pi.registerCommand("steel-session", {
		description: "Show or release the live Steel browser session",
		handler: async (args: string, ctx: ExtensionContext) => {
			if (args.trim() === "end") {
				const config = await steelConfig();
				const id = await releaseSession(config);
				return ctx.ui.notify(id ? `Released Steel session ${id}` : "No live Steel session", "info");
			}
			if (!live) return ctx.ui.notify("No live Steel session", "info");
			const url = live.cdp ? await live.cdp.evaluate<string>("location.href").catch(() => live?.lastUrl) : live.lastUrl;
			ctx.ui.notify(
				[`session ${live.id}`, `url: ${url ?? "about:blank"}`, live.viewerUrl ? `viewer: ${live.viewerUrl}` : ""]
					.filter(Boolean)
					.join("\n"),
				"info",
			);
		},
	});
}
