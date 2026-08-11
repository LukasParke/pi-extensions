import {
	noCredentialMessage,
	type ResolvedCredential,
	resolveCredential,
} from "@parke.dev/pi-integration-auth";

export const NOTION_AUTH_REF = "notion.default";
export const NOTION_ENV_NAMES = ["NOTION_TOKEN", "NOTION_API_KEY"] as const;

export type { ResolvedCredential };

export interface AuthOptions {
	env?: Record<string, string | undefined>;
	store?: import("@parke.dev/pi-integration-auth").PiAuthStore;
}

export async function resolveKey(opts: AuthOptions = {}): Promise<ResolvedCredential | null> {
	return await resolveCredential({
		envNames: NOTION_ENV_NAMES,
		authRef: NOTION_AUTH_REF,
		...(opts.env !== undefined ? { env: opts.env } : {}),
		...(opts.store !== undefined ? { store: opts.store } : {}),
	});
}

export const NO_KEY_MESSAGE = noCredentialMessage({
	provider: "Notion",
	envNames: NOTION_ENV_NAMES,
	connectCommand: "notion-login",
	scopeHint:
		"an internal integration token from Notion → Settings → Connections → Develop or manage integrations",
});
