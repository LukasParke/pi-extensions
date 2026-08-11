import {
	HttpClient,
	HttpError,
	type HttpRequest,
	type HttpResponse,
	headerSeconds,
	type MapContext,
	type RateInfo,
} from "@parke.dev/pi-integration-http";

export const PUBLIC_API = "https://api.github.com";

export type { HttpRequest as ApiRequest, HttpResponse as ApiResponse };
export { HttpError, type RateInfo };

export interface ApiOptions {
	token: string;
	baseUrl?: string;
	timeoutMs?: number;
	maxRetries?: number;
	sleep?: (ms: number) => Promise<void>;
	fetchImpl?: typeof fetch;
}

export function mapGitHubStatus(res: Response, ctx: MapContext): HttpError {
	const { providerMessage, rate } = ctx;
	const opts = { provider: "GitHub", providerMessage };

	if (res.status === 401) {
		return new HttpError("reauthorize", "GitHub rejected the credential", {
			...opts,
			retriable: false,
		});
	}

	if (res.status === 403 || res.status === 429) {
		const retryAfter = headerSeconds(res.headers.get("retry-after"));
		if (res.status === 429 || rate.remaining === 0 || retryAfter !== null) {
			return new HttpError("rate_limited", "GitHub rate limit reached", {
				...opts,
				retryAfterSec: retryAfter ?? resetInSec(rate),
			});
		}
		return new HttpError("forbidden", "the credential lacks the scope for this request", {
			...opts,
			retriable: false,
		});
	}

	if (res.status === 404) {
		return new HttpError("not_found", "not found, or the credential cannot see it", {
			...opts,
			retriable: false,
		});
	}

	if (res.status === 422) {
		return new HttpError("invalid_request", "GitHub rejected the request as invalid", {
			...opts,
			retriable: false,
		});
	}

	return new HttpError("provider_error", `GitHub returned ${String(res.status)}`, {
		...opts,
		retriable: res.status >= 500,
	});
}

export function githubApi(opts: ApiOptions): HttpClient {
	return new HttpClient({
		provider: "GitHub",
		token: opts.token,
		baseUrl: opts.baseUrl ?? PUBLIC_API,
		mapStatus: mapGitHubStatus,
		defaultHeaders: {
			accept: "application/vnd.github+json",
			"x-github-api-version": "2022-11-28",
			"user-agent": "pi-github-extension",
		},
		...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
		...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
		...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
		...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
	});
}

function resetInSec(rate: RateInfo): number | null {
	if (rate.resetAt === null) return null;
	const secs = Math.ceil(rate.resetAt - Date.now() / 1000);
	return secs > 0 ? secs : null;
}
