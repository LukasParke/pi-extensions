import {
	noCredentialMessage,
	type ResolvedCredential,
	resolveCredential,
} from "@parke.dev/pi-integration-auth";

export const SLACK_AUTH_REF = "slack.default";
export const SLACK_ENV_NAMES = ["SLACK_BOT_TOKEN", "SLACK_TOKEN"] as const;

export type { ResolvedCredential };

export interface AuthOptions {
	env?: Record<string, string | undefined>;
	store?: import("@parke.dev/pi-integration-auth").PiAuthStore;
}

export async function resolveToken(opts: AuthOptions = {}): Promise<ResolvedCredential | null> {
	return await resolveCredential({
		envNames: SLACK_ENV_NAMES,
		authRef: SLACK_AUTH_REF,
		...(opts.env !== undefined ? { env: opts.env } : {}),
		...(opts.store !== undefined ? { store: opts.store } : {}),
	});
}

export const NO_TOKEN_MESSAGE = noCredentialMessage({
	provider: "Slack",
	envNames: SLACK_ENV_NAMES,
	connectCommand: "slack-login",
	scopeHint:
		"a bot token (xoxb-…) with channels:read, channels:history, groups:read, groups:history, chat:write, users:read — " +
		"and search:read on a user token if you want slack_search",
});
