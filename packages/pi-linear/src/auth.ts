import {
	noCredentialMessage,
	type ResolvedCredential,
	resolveCredential,
} from "@parke.dev/pi-integration-auth";

export const LINEAR_AUTH_REF = "linear.default";
export const LINEAR_ENV_NAMES = ["LINEAR_API_KEY", "LINEAR_TOKEN"] as const;

export type { ResolvedCredential };

export interface AuthOptions {
	env?: Record<string, string | undefined>;
	store?: import("@parke.dev/pi-integration-auth").PiAuthStore;
}

export async function resolveKey(opts: AuthOptions = {}): Promise<ResolvedCredential | null> {
	return await resolveCredential({
		envNames: LINEAR_ENV_NAMES,
		authRef: LINEAR_AUTH_REF,
		...(opts.env !== undefined ? { env: opts.env } : {}),
		...(opts.store !== undefined ? { store: opts.store } : {}),
	});
}

export const NO_KEY_MESSAGE = noCredentialMessage({
	provider: "Linear",
	envNames: LINEAR_ENV_NAMES,
	connectCommand: "linear-login",
	scopeHint: "a personal API key from Linear → Settings → API",
});
