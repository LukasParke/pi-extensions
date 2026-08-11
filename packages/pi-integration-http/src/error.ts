export type HttpErrorCode =
	| "no_credential"
	| "reauthorize"
	| "forbidden"
	| "not_found"
	| "rate_limited"
	| "timeout"
	| "provider_error"
	| "invalid_request"
	| "not_supported";

const RETRIABLE: readonly HttpErrorCode[] = ["rate_limited", "timeout", "provider_error"];

export class HttpError extends Error {
	readonly code: HttpErrorCode;
	readonly retriable: boolean;
	readonly retryAfterSec: number | null;
	readonly providerMessage: string | null;
	readonly provider: string;

	constructor(
		code: HttpErrorCode,
		message: string,
		opts: {
			provider?: string;
			retriable?: boolean;
			retryAfterSec?: number | null;
			providerMessage?: string | null;
		} = {},
	) {
		super(message);
		this.name = "HttpError";
		this.code = code;
		this.provider = opts.provider ?? "the provider";
		this.retriable = opts.retriable ?? RETRIABLE.includes(code);
		this.retryAfterSec = opts.retryAfterSec ?? null;
		this.providerMessage = opts.providerMessage ?? null;
	}

	toJSON(): {
		code: HttpErrorCode;
		message: string;
		provider: string;
		retriable: boolean;
		retry_after_sec: number | null;
		provider_message: string | null;
	} {
		return {
			code: this.code,
			message: this.message,
			provider: this.provider,
			retriable: this.retriable,
			retry_after_sec: this.retryAfterSec,
			provider_message: this.providerMessage,
		};
	}
}

export function notSupported(provider: string, op: string): HttpError {
	return new HttpError("not_supported", `${provider} does not support ${op}`, {
		provider,
		retriable: false,
	});
}

export function headerSeconds(v: string | null | undefined): number | null {
	if (v === null || v === undefined || v.trim() === "") return null;
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : null;
}
