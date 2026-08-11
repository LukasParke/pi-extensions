import { HttpError, headerSeconds } from "./error.ts";

export interface HttpClientOptions {
	provider: string;
	token: string | (() => string | Promise<string>);
	baseUrl: string;
	timeoutMs?: number;
	maxRetries?: number;
	defaultHeaders?: Record<string, string>;
	sleep?: (ms: number) => Promise<void>;
	fetchImpl?: typeof fetch;
	mapStatus?: (res: Response, ctx: MapContext) => Promise<HttpError> | HttpError;
	authScheme?: "bearer" | "token" | "none";
}

export interface MapContext {
	provider: string;
	providerMessage: string | null;
	rate: RateInfo;
}

export interface HttpRequest {
	method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
	path: string;
	body?: unknown;
	headers?: Record<string, string>;
	idempotencyKey?: string;
	absoluteUrl?: string;
}

export interface RateInfo {
	remaining: number | null;
	limit: number | null;
	resetAt: number | null;
}

export interface HttpResponse<T> {
	data: T;
	rate: RateInfo;
	nextUrl: string | null;
	status: number;
}

export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_RETRIES = 2;

export class HttpClient {
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly doFetch: typeof fetch;
	private readonly baseUrl: string;

	constructor(private readonly opts: HttpClientOptions) {
		this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		this.doFetch = opts.fetchImpl ?? ((...a) => fetch(...a));
		this.baseUrl = opts.baseUrl.replace(/\/$/, "");
	}

	async request<T>(req: HttpRequest): Promise<HttpResponse<T>> {
		const url = req.absoluteUrl ?? `${this.baseUrl}${req.path}`;
		const maxRetries = this.opts.maxRetries ?? DEFAULT_MAX_RETRIES;
		const isWrite = req.method !== "GET";
		const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

		let lastError: HttpError | null = null;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			if (attempt > 0) {
				const backoff = Math.min(8000, 250 * 2 ** (attempt - 1));
				await this.sleep(Math.floor(backoff * Math.random()) + 50);
			}

			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);

			try {
				const res = await this.doFetch(url, {
					method: req.method,
					signal: controller.signal,
					headers: {
						...(await this.authHeader()),
						accept: "application/json",
						...(req.body !== undefined ? { "content-type": "application/json" } : {}),
						...(req.idempotencyKey !== undefined ? { "idempotency-key": req.idempotencyKey } : {}),
						...(this.opts.defaultHeaders ?? {}),
						...(req.headers ?? {}),
					},
					...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
				});

				const rate = readRate(res.headers);

				if (res.ok) {
					const text = res.status === 204 ? "" : await res.text();
					if (text.trim() === "") {
						return {
							data: null as T,
							rate,
							nextUrl: nextLink(res.headers.get("link")),
							status: res.status,
						};
					}
					try {
						return {
							data: JSON.parse(text) as T,
							rate,
							nextUrl: nextLink(res.headers.get("link")),
							status: res.status,
						};
					} catch {
						throw new HttpError(
							"provider_error",
							`${this.opts.provider} returned a response that is not JSON`,
							{
								provider: this.opts.provider,
								providerMessage: text.slice(0, 500),
								retriable: false,
							},
						);
					}
				}

				const providerMessage = await providerWords(res);
				const ctx: MapContext = { provider: this.opts.provider, providerMessage, rate };
				const mapped = await (this.opts.mapStatus ?? defaultMapStatus)(res, ctx);

				if (!mapped.retriable) throw mapped;
				if (isWrite) throw mapped;

				lastError = mapped;
				if (attempt === maxRetries) throw mapped;
				if (mapped.retryAfterSec !== null) {
					await this.sleep(Math.min(30_000, mapped.retryAfterSec * 1000));
				}
			} catch (e) {
				if (e instanceof HttpError) {
					if (!e.retriable || isWrite || attempt === maxRetries) throw e;
					lastError = e;
					continue;
				}

				const aborted = (e as { name?: string }).name === "AbortError";
				const wrapped = new HttpError(
					aborted ? "timeout" : "provider_error",
					aborted
						? `${this.opts.provider} did not respond within ${String(timeoutMs)}ms`
						: `could not reach ${this.opts.provider}`,
					{
						provider: this.opts.provider,
						retriable: true,
						providerMessage: e instanceof Error ? e.message : String(e),
					},
				);
				if (attempt === maxRetries) throw wrapped;
				lastError = wrapped;
			} finally {
				clearTimeout(timer);
			}
		}

		throw (
			lastError ??
			new HttpError("provider_error", `${this.opts.provider} failed after retries`, {
				provider: this.opts.provider,
			})
		);
	}

	async paginate<T>(
		req: HttpRequest,
		opts: { maxPages?: number; limit?: number; itemsOf?: (page: unknown) => T[] } = {},
	): Promise<{ items: T[]; rate: RateInfo; truncated: boolean }> {
		const maxPages = opts.maxPages ?? 3;
		const limit = opts.limit ?? Number.POSITIVE_INFINITY;
		const itemsOf = opts.itemsOf ?? ((page: unknown) => (Array.isArray(page) ? (page as T[]) : []));

		const items: T[] = [];
		let url: string | undefined;
		let rate: RateInfo = { remaining: null, limit: null, resetAt: null };
		let pages = 0;
		let more = false;

		for (;;) {
			const res = await this.request<unknown>(
				url === undefined ? req : { method: "GET", path: "", absoluteUrl: url },
			);
			rate = res.rate;
			items.push(...itemsOf(res.data));
			pages++;

			if (items.length >= limit) {
				more = res.nextUrl !== null || items.length > limit;
				break;
			}
			if (res.nextUrl === null) break;
			if (pages >= maxPages) {
				more = true;
				break;
			}
			url = res.nextUrl;
		}

		return {
			items: limit === Number.POSITIVE_INFINITY ? items : items.slice(0, limit),
			rate,
			truncated: more,
		};
	}

	private async authHeader(): Promise<Record<string, string>> {
		const scheme = this.opts.authScheme ?? "bearer";
		if (scheme === "none") return {};
		const token = typeof this.opts.token === "string" ? this.opts.token : await this.opts.token();
		return { authorization: scheme === "token" ? `token ${token}` : `Bearer ${token}` };
	}
}

export async function defaultMapStatus(res: Response, ctx: MapContext): Promise<HttpError> {
	const { provider, providerMessage, rate } = ctx;
	const opts = { provider, providerMessage };

	if (res.status === 401) {
		return new HttpError("reauthorize", `${provider} rejected the credential`, {
			...opts,
			retriable: false,
		});
	}

	if (res.status === 403 || res.status === 429) {
		const retryAfter = headerSeconds(res.headers.get("retry-after"));
		if (res.status === 429 || rate.remaining === 0 || retryAfter !== null) {
			return new HttpError("rate_limited", `${provider} rate limit reached`, {
				...opts,
				retryAfterSec: retryAfter ?? resetInSec(rate),
			});
		}
		return new HttpError("forbidden", `the credential lacks the permission for this ${provider} request`, {
			...opts,
			retriable: false,
		});
	}

	if (res.status === 404) {
		return new HttpError("not_found", `not found on ${provider}, or the credential cannot see it`, {
			...opts,
			retriable: false,
		});
	}

	if (res.status === 400 || res.status === 422) {
		return new HttpError("invalid_request", `${provider} rejected the request as invalid`, {
			...opts,
			retriable: false,
		});
	}

	return new HttpError("provider_error", `${provider} returned ${String(res.status)}`, {
		...opts,
		retriable: res.status >= 500,
	});
}

export function readRate(h: Headers): RateInfo {
	const num = (...names: string[]): number | null => {
		for (const n of names) {
			const v = h.get(n);
			if (v === null) continue;
			const parsed = Number(v);
			if (Number.isFinite(parsed)) return parsed;
		}
		return null;
	};
	return {
		remaining: num("x-ratelimit-remaining", "ratelimit-remaining"),
		limit: num("x-ratelimit-limit", "ratelimit-limit"),
		resetAt: num("x-ratelimit-reset", "ratelimit-reset"),
	};
}

export function nextLink(header: string | null): string | null {
	if (header === null) return null;
	const m = /<([^>]{1,2000})>;\s*rel="next"/.exec(header);
	return m?.[1] ?? null;
}

export async function providerWords(res: Response): Promise<string | null> {
	let text: string;
	try {
		text = (await res.text()).slice(0, 4000);
	} catch {
		return null;
	}
	if (text.trim() === "") return null;

	let parsed: { message?: unknown; error?: unknown; errors?: unknown };
	try {
		parsed = JSON.parse(text) as typeof parsed;
	} catch {
		return text.trim().slice(0, 300);
	}

	const nested =
		Array.isArray(parsed.errors) && parsed.errors.length > 0
			? (parsed.errors[0] as { message?: unknown; field?: unknown })
			: null;
	const nestedWords =
		nested === null
			? null
			: typeof nested.message === "string"
				? nested.message
				: typeof nested.field === "string"
					? `field: ${nested.field}`
					: null;

	const primary =
		typeof parsed.message === "string"
			? parsed.message
			: typeof parsed.error === "string"
				? parsed.error
				: null;

	if (primary === null) return nestedWords;
	return nestedWords === null ? primary : `${primary} (${nestedWords})`;
}

function resetInSec(rate: RateInfo): number | null {
	if (rate.resetAt === null) return null;
	const secs = Math.ceil(rate.resetAt - Date.now() / 1000);
	return secs > 0 ? secs : null;
}
