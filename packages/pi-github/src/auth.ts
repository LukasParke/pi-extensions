import { execFile } from "node:child_process";
import {
	noCredentialMessage,
	type ResolvedCredential,
	resolveCredential,
} from "@parke.dev/pi-integration-auth";

export const GITHUB_AUTH_REF = "github.default";
export const GITHUB_ENV_NAMES = ["GITHUB_TOKEN", "GH_TOKEN"] as const;

export type { ResolvedCredential as ResolvedToken };
export type TokenSource = ResolvedCredential["source"];

export interface AuthOptions {
	env?: Record<string, string | undefined>;
	ghToken?: () => Promise<string | null>;
	store?: ConstructorParameters<typeof import("@parke.dev/pi-integration-auth").PiAuthStore> extends never
		? never
		: import("@parke.dev/pi-integration-auth").PiAuthStore;
}

export async function ghCliToken(): Promise<string | null> {
	return await new Promise((resolve) => {
		const child = execFile("gh", ["auth", "token"], { timeout: 5000 }, (err, stdout) => {
			if (err !== null) {
				resolve(null);
				return;
			}
			const token = stdout.trim();
			resolve(token === "" ? null : token);
		});
		child.on("error", () => resolve(null));
	});
}

export async function resolveToken(opts: AuthOptions = {}): Promise<ResolvedCredential | null> {
	return await resolveCredential({
		envNames: GITHUB_ENV_NAMES,
		authRef: GITHUB_AUTH_REF,
		cli: {
			describe: "`gh auth token` (the GitHub CLI keyring)",
			read: opts.ghToken ?? ghCliToken,
		},
		...(opts.env !== undefined ? { env: opts.env } : {}),
		...(opts.store !== undefined ? { store: opts.store } : {}),
	});
}

export const NO_TOKEN_MESSAGE = noCredentialMessage({
	provider: "GitHub",
	envNames: GITHUB_ENV_NAMES,
	connectCommand: "github-login",
	scopeHint: "needs `repo` scope for private repositories",
	cliHint: "`gh auth login` — the GitHub CLI keyring, read directly and never copied",
});
