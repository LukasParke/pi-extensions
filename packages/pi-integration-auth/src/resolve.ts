import { PiAuthStore } from "./pi-auth.ts";

export type CredentialSource = "env" | "integration-auth" | "cli";

export interface ResolvedCredential {
	token: string;
	source: CredentialSource;
	detail: string;
}

export interface ResolveOptions {
	envNames: readonly string[];
	authRef: string;
	cli?: {
		describe: string;
		read: () => Promise<string | null>;
	};
	env?: Record<string, string | undefined>;
	store?: PiAuthStore;
}

export async function resolveCredential(options: ResolveOptions) {
	const env = options.env ?? process.env;
	const store = options.store ?? new PiAuthStore();

	for (const name of options.envNames) {
		const token = env[name]?.trim();
		if (token) return { token, source: "env", detail: `from $${name}` } satisfies ResolvedCredential;
	}

	const stored = await store.get(options.authRef);
	if (stored) {
		return {
			token: stored,
			source: "integration-auth",
			detail: `from ${store.describe()}`,
		} satisfies ResolvedCredential;
	}

	if (options.cli) {
		const token = (await options.cli.read())?.trim();
		if (token) {
			return {
				token,
				source: "cli",
				detail: `from ${options.cli.describe} — not stored by this extension`,
			} satisfies ResolvedCredential;
		}
	}

	return null;
}

export function noCredentialMessage(options: {
	provider: string;
	envNames: readonly string[];
	connectCommand: string;
	scopeHint?: string;
	cliHint?: string;
}) {
	const choices = [];
	if (options.cliHint) choices.push(options.cliHint);
	choices.push(
		`/${options.connectCommand}${options.scopeHint ? ` (${options.scopeHint})` : ""}`,
		`set ${options.envNames.map((name) => `$${name}`).join(" or ")}`,
	);
	return `No ${options.provider} credential found. Use ${choices.join(", or ")}.`;
}
