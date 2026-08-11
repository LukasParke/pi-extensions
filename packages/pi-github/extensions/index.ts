import { PiAuthStore, registerCredentialCommand } from "@parke.dev/pi-integration-auth";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { HttpError } from "../src/api.ts";
import { GITHUB_AUTH_REF, NO_TOKEN_MESSAGE, resolveToken } from "../src/auth.ts";
import { withBlockedSignal } from "./blocked.ts";
import { GitHubClient } from "../src/client.ts";
import { GITHUB_DESCRIPTION } from "../src/describe.ts";
import { NO_REPO_MESSAGE, type RepoRef, resolveRepo } from "../src/repo.ts";
import { renderCheckRows, renderIssueRows, renderPullRows, renderToolCall } from "../src/tui.ts";
import {
	type CheckRow,
	checksRollup,
	type IssueRow,
	type PullDetail,
	type PullRow,
} from "../src/viewmodel.ts";

const MAX_LIMIT = 50;

interface ToolResult {
	content: { type: "text"; text: string }[];
	details: unknown;
}

function ok(text: string, details: unknown = {}): ToolResult {
	return { content: [{ type: "text", text }], details };
}

function refuse(text: string, details?: unknown): ToolResult {
	return ok(text, {
		refused: true,
		...(typeof details === "object" && details !== null ? details : {}),
	});
}

function explain(e: unknown): string {
	if (e instanceof HttpError) {
		const provider = e.providerMessage === null ? "" : ` GitHub said: ${e.providerMessage}`;
		const wait = e.retryAfterSec === null ? "" : ` Retry in about ${String(e.retryAfterSec)}s.`;
		const remedy =
			e.code === "reauthorize"
				? " Reconnect with `github_connect`, or run `gh auth login`."
				: e.code === "forbidden"
					? " The token needs the `repo` scope for private repositories."
					: "";
		return `${e.message}.${provider}${wait}${remedy}`;
	}
	return e instanceof Error ? e.message : String(e);
}

async function context(
	repoArg: string | undefined,
	ctx: ExtensionContext,
): Promise<{ client: GitHubClient; repo: RepoRef } | { error: string }> {
	const resolved = await resolveToken();
	if (resolved === null) return { error: NO_TOKEN_MESSAGE };
	const repo = await resolveRepo(repoArg, { cwd: ctx.cwd });
	if (repo === null) return { error: NO_REPO_MESSAGE };
	return { client: new GitHubClient({ token: resolved.token }), repo };
}

async function confirmWrite(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	label: string,
	title: string,
	detail: string,
	forcible: { yes: boolean } | { yes: false; noEscape: true },
	signal?: AbortSignal,
): Promise<{ allowed: true } | { allowed: false; why: string }> {
	if (forcible.yes) return { allowed: true };
	if (!ctx.hasUI) {
		const hint =
			"noEscape" in forcible
				? "This can only be done in an interactive session — there is deliberately no flag to skip it."
				: "Pass `yes: true` to proceed without asking, or run in an interactive session.";
		return {
			allowed: false,
			why: `This writes to GitHub and nobody can be asked to confirm in this mode. ${hint}`,
		};
	}
	const answer = await withBlockedSignal(pi, label, () => ctx.ui.confirm(title, detail, { signal }));
	return answer === true
		? { allowed: true }
		: { allowed: false, why: "The user declined. Nothing was posted." };
}

function rateLine(rate: { remaining: number | null; limit: number | null }): string {
	if (rate.remaining === null) return "";
	const of = rate.limit === null ? "" : `/${String(rate.limit)}`;
	return `\n(${String(rate.remaining)}${of} API calls left this hour)`;
}

/* --------------------------------- rendering --------------------------------- */

function renderPulls(repo: RepoRef, rows: PullRow[], truncated: boolean): string {
	if (rows.length === 0) return `No open pull requests in ${repo.slug}.`;
	const lines = rows.map((r) => {
		const flags = [r.state === "open" ? null : r.state, r.review, r.checks].filter(Boolean).join(", ");
		const blocked = r.mergeable === null ? "" : ` — ${r.mergeable}`;
		return `#${String(r.number)} ${r.title} (${r.author}; ${flags})${blocked}`;
	});
	return `${String(rows.length)} pull request(s) in ${repo.slug}${truncated ? " (more available)" : ""}:\n${lines.join("\n")}`;
}

function renderIssues(repo: RepoRef, rows: IssueRow[], truncated: boolean): string {
	if (rows.length === 0) return `No matching issues in ${repo.slug}.`;
	const lines = rows.map((r) => {
		const labels = r.labels.length === 0 ? "" : ` [${r.labels.join(", ")}]`;
		const who = r.assignees.length === 0 ? "unassigned" : r.assignees.join(", ");
		return `#${String(r.number)} ${r.title}${labels} (${who}; ${String(r.comments)} comments)`;
	});
	return `${String(rows.length)} issue(s) in ${repo.slug}${truncated ? " (more available)" : ""}:\n${lines.join("\n")}`;
}

function renderChecks(rows: CheckRow[]): string {
	if (rows.length === 0) return "No check runs for this ref.";
	const lines = rows.map((c) => {
		const dur = c.durationSec === null ? "" : ` in ${String(c.durationSec)}s`;
		const sum = c.summary === null ? "" : ` — ${c.summary}`;
		return `${c.status}: ${c.name}${dur}${sum}`;
	});
	return `${checksRollup(rows)} (${String(rows.length)} checks):\n${lines.join("\n")}`;
}

function renderPull(repo: RepoRef, p: PullDetail): string {
	const head: string[] = [
		`#${String(p.number)} ${p.title}`,
		`${repo.slug} · ${p.author} · ${p.state} · ${p.branch} → ${p.baseBranch}`,
		`+${String(p.additions)}/-${String(p.deletions)} across ${String(p.changedFiles)} file(s)`,
		`checks: ${checksRollup(p.checks)}`,
	];
	if (p.mergeable !== null) head.push(`cannot merge: ${p.mergeable}`);
	if (p.reviews.length > 0) {
		head.push(`reviews: ${p.reviews.map((r) => `${r.author} ${r.state}`).join("; ")}`);
	}
	head.push("", p.body.trim() === "" ? "(no description)" : p.body.trim());

	const failing = p.checks.filter((c) => c.status === "failing");
	if (failing.length > 0) {
		head.push("", `failing checks: ${failing.map((c) => c.name).join(", ")}`);
	}

	const files = p.files.map((f) => {
		const rename = f.previousPath === null ? "" : ` (was ${f.previousPath})`;
		const header = `--- ${f.path}${rename} [${f.status} +${String(f.additions)}/-${String(f.deletions)}]`;
		if (f.patch === null) return `${header}\n(patch omitted: ${f.patchOmitted ?? "unknown reason"})`;
		return `${header}\n${f.patch}`;
	});
	if (p.filesTruncated) {
		files.push(`(file list truncated — ${String(p.changedFiles)} files changed in total; see ${p.url})`);
	}

	return `${head.join("\n")}\n\n${files.join("\n\n")}`;
}

/* ------------------------------- the extension ------------------------------- */

export default function github(pi: ExtensionAPI): void {
	registerCredentialCommand(pi, {
		id: "github-login",
		label: "GitHub",
		authRef: GITHUB_AUTH_REF,
		envNames: ["GITHUB_TOKEN", "GH_TOKEN"],
		prompt: "Paste a GitHub personal access token",
		store: new PiAuthStore(),
		validate: async (token) => (await new GitHubClient({ token }).viewer()).data.login,
	});

	const repoParam = (): ReturnType<typeof Type.Optional<ReturnType<typeof Type.String>>> =>
		Type.Optional(
			Type.String({
				description: 'Repository as "owner/name". Omit to use the current checkout\'s origin remote.',
			}),
		);

	pi.registerTool({
		name: "github_prs",
		label: "GitHub PRs",
		description:
			"List pull requests in a GitHub repository with their review state and check status. " +
			'Use this to answer "what is open", "what is failing", or "what needs review".',
		parameters: Type.Object({
			repo: repoParam(),
			state: Type.Optional(StringEnum(["open", "closed", "all"] as const)),
			limit: Type.Optional(Type.Number({ description: `Rows to return, up to ${String(MAX_LIMIT)}.` })),
			search: Type.Optional(
				Type.String({
					description: 'Free text, or GitHub search qualifiers such as "author:me" or "review:required".',
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as {
				repo?: string;
				state?: "open" | "closed" | "all";
				limit?: number;
				search?: string;
			};
			const c = await context(p.repo, ctx);
			if ("error" in c) return refuse(c.error);
			try {
				if (p.search !== undefined && p.search.trim() !== "") {
					const res = await c.client.search(c.repo, p.search, "pr", Math.min(p.limit ?? 20, MAX_LIMIT));
					return ok(renderIssues(c.repo, res.data, false) + rateLine(res.rate), {
						repo: c.repo.slug,
						segment: "prs",
						rows: res.data,
						rate: res.rate,
					});
				}
				const res = await c.client.pulls(c.repo, {
					limit: Math.min(p.limit ?? 20, MAX_LIMIT),
					...(p.state !== undefined ? { state: p.state } : {}),
				});
				return ok(renderPulls(c.repo, res.data, res.truncated === true) + rateLine(res.rate), {
					repo: c.repo.slug,
					segment: "prs",
					rows: res.data,
					rate: res.rate,
					truncated: res.truncated === true,
				});
			} catch (e) {
				return refuse(explain(e));
			}
		},
		renderCall: (args: unknown) => renderToolCall("github_prs", (args ?? {}) as Record<string, unknown>),
		renderResult: (result: unknown) => {
			const d = (result as { details?: { rows?: PullRow[] } }).details;
			return renderPullRows(d?.rows ?? []);
		},
	});

	pi.registerTool({
		name: "github_pr",
		label: "GitHub PR",
		description:
			"Read one pull request in full: description, changed files with patches, check runs and reviews. " +
			"This is the tool for reviewing a PR — it returns the diff, so no follow-up call is needed.",
		parameters: Type.Object({
			number: Type.Number({ description: "The pull request number." }),
			repo: repoParam(),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as { number: number; repo?: string };
			const c = await context(p.repo, ctx);
			if ("error" in c) return refuse(c.error);
			try {
				const res = await c.client.pull(c.repo, p.number);
				return ok(renderPull(c.repo, res.data) + rateLine(res.rate), {
					repo: c.repo.slug,
					segment: "pr",
					block: "pr",
					pr: res.data,
					rate: res.rate,
				});
			} catch (e) {
				return refuse(explain(e));
			}
		},
	});

	pi.registerTool({
		name: "github_issues",
		label: "GitHub issues",
		description:
			"List or search issues in a GitHub repository. Pull requests are excluded even though GitHub returns them " +
			"from the same endpoint.",
		parameters: Type.Object({
			repo: repoParam(),
			state: Type.Optional(StringEnum(["open", "closed", "all"] as const)),
			labels: Type.Optional(Type.String({ description: "Comma-separated label names." })),
			assignee: Type.Optional(Type.String({ description: 'A login, or "none" for unassigned.' })),
			search: Type.Optional(Type.String({ description: "Free text, or GitHub search qualifiers." })),
			limit: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as {
				repo?: string;
				state?: "open" | "closed" | "all";
				labels?: string;
				assignee?: string;
				search?: string;
				limit?: number;
			};
			const c = await context(p.repo, ctx);
			if ("error" in c) return refuse(c.error);
			const limit = Math.min(p.limit ?? 20, MAX_LIMIT);
			try {
				const res =
					p.search !== undefined && p.search.trim() !== ""
						? await c.client.search(c.repo, p.search, "issue", limit)
						: await c.client.issues(c.repo, {
								limit,
								...(p.state !== undefined ? { state: p.state } : {}),
								...(p.labels !== undefined ? { labels: p.labels } : {}),
								...(p.assignee !== undefined ? { assignee: p.assignee } : {}),
							});
				return ok(renderIssues(c.repo, res.data, res.truncated === true) + rateLine(res.rate), {
					repo: c.repo.slug,
					segment: "issues",
					rows: res.data,
					rate: res.rate,
				});
			} catch (e) {
				return refuse(explain(e));
			}
		},
		renderCall: (args: unknown) => renderToolCall("github_issues", (args ?? {}) as Record<string, unknown>),
		renderResult: (result: unknown) => {
			const d = (result as { details?: { rows?: IssueRow[] } }).details;
			return renderIssueRows(d?.rows ?? []);
		},
	});

	pi.registerTool({
		name: "github_checks",
		label: "GitHub checks",
		description:
			"Check runs for a branch, tag or commit SHA, each with its conclusion and duration. " +
			"Use this to find out why CI is red.",
		parameters: Type.Object({
			ref: Type.String({ description: "A branch name, tag, or commit SHA." }),
			repo: repoParam(),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as { ref: string; repo?: string };
			const c = await context(p.repo, ctx);
			if ("error" in c) return refuse(c.error);
			try {
				const res = await c.client.checks(c.repo, p.ref);
				return ok(renderChecks(res.data) + rateLine(res.rate), {
					repo: c.repo.slug,
					segment: "checks",
					ref: p.ref,
					rows: res.data,
					rollup: checksRollup(res.data),
					rate: res.rate,
				});
			} catch (e) {
				return refuse(explain(e));
			}
		},
		renderCall: (args: unknown) => renderToolCall("github_checks", (args ?? {}) as Record<string, unknown>),
		renderResult: (result: unknown) => {
			const d = (result as { details?: { rows?: CheckRow[] } }).details;
			return renderCheckRows(d?.rows ?? []);
		},
	});

	/* ------------------------------- writes ------------------------------- */

	pi.registerTool({
		name: "github_comment",
		label: "GitHub comment",
		description:
			"Post a comment on a pull request or issue. The user is asked to confirm first, and nothing is posted if they " +
			"decline. Works for both PRs and issues.",
		parameters: Type.Object({
			number: Type.Number({ description: "The pull request or issue number." }),
			body: Type.String({ description: "The comment, as markdown." }),
			repo: repoParam(),
			yes: Type.Optional(
				Type.Boolean({
					description:
						"Skip the confirmation. Only for non-interactive use where the human has already decided.",
				}),
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const p = params as { number: number; body: string; repo?: string; yes?: boolean };
			const c = await context(p.repo, ctx);
			if ("error" in c) return refuse(c.error);

			const preview =
				p.body.length > 2000
					? `${p.body.slice(0, 2000)}\n… (${String(p.body.length)} characters total)`
					: p.body;
			const decision = await confirmWrite(
				pi,
				ctx,
				`confirm: comment on ${c.repo.slug}#${String(p.number)}`,
				`Post a comment on ${c.repo.slug}#${String(p.number)}?`,
				preview,
				{ yes: p.yes === true },
				signal,
			);
			if (!decision.allowed) return refuse(decision.why);

			try {
				const res = await c.client.comment(c.repo, p.number, p.body);
				return ok(`Posted: ${res.data.url}${rateLine(res.rate)}`, {
					repo: c.repo.slug,
					posted: true,
					url: res.data.url,
					rate: res.rate,
				});
			} catch (e) {
				return refuse(explain(e));
			}
		},
	});

	pi.registerTool({
		name: "github_review",
		label: "GitHub review",
		description:
			"Submit a review on a pull request: comment, approve, or request changes. The user is asked to confirm first. " +
			"Requesting changes needs a body. Merging is deliberately not available.",
		parameters: Type.Object({
			number: Type.Number(),
			event: StringEnum(["comment", "approve", "request_changes"] as const),
			body: Type.Optional(Type.String({ description: "Review text. Required unless approving." })),
			repo: repoParam(),
			yes: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const p = params as {
				number: number;
				event: "comment" | "approve" | "request_changes";
				body?: string;
				repo?: string;
				yes?: boolean;
			};
			const c = await context(p.repo, ctx);
			if ("error" in c) return refuse(c.error);

			const body = p.body ?? "";
			const event =
				p.event === "approve" ? "APPROVE" : p.event === "request_changes" ? "REQUEST_CHANGES" : "COMMENT";
			const word =
				p.event === "approve"
					? "Approve"
					: p.event === "request_changes"
						? "Request changes on"
						: "Comment on";
			const decision = await confirmWrite(
				pi,
				ctx,
				`confirm: review ${c.repo.slug}#${String(p.number)}`,
				`${word} ${c.repo.slug}#${String(p.number)}?`,
				body.trim() === "" ? "(no message)" : body.slice(0, 2000),
				{ yes: p.yes === true },
				signal,
			);
			if (!decision.allowed) return refuse(decision.why);

			try {
				const res = await c.client.review(c.repo, p.number, event, body);
				return ok(`Review submitted (${res.data.state}): ${res.data.url}${rateLine(res.rate)}`, {
					repo: c.repo.slug,
					posted: true,
					url: res.data.url,
					state: res.data.state,
					rate: res.rate,
				});
			} catch (e) {
				return refuse(explain(e));
			}
		},
	});

	/* ------------------------------ credential ------------------------------ */

	pi.registerTool({
		name: "github_status",
		label: "GitHub status",
		description:
			"Report whether GitHub is reachable, which credential is in use and where it came from, and what this " +
			"extension can and cannot do. Call this first when something is not working.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const resolved = await resolveToken();
			if (resolved === null) {
				return refuse(NO_TOKEN_MESSAGE, { connected: false });
			}
			const repo = await resolveRepo(undefined, { cwd: ctx.cwd });
			try {
				const who = await new GitHubClient({ token: resolved.token }).viewer();
				const lines = [
					`Connected to GitHub as ${who.data.login}${who.data.name === null ? "" : ` (${who.data.name})`}.`,
					`Credential: ${resolved.detail}.`,
					repo === null
						? "No repository inferred from the current directory — pass `repo` explicitly."
						: `Current repository: ${repo.slug}.`,
					`Reads: ${GITHUB_DESCRIPTION.segments.map((s) => s.id).join(", ")}.`,
					`Writes: ${GITHUB_DESCRIPTION.actions.map((a) => a.id).join(", ")} (each asks first).`,
					`Deliberately not available: ${GITHUB_DESCRIPTION.refuses.map((r) => r.id).join(", ")}.`,
				];
				return ok(lines.join("\n") + rateLine(who.rate), {
					connected: true,
					login: who.data.login,
					source: resolved.source,
					repo: repo?.slug ?? null,
					rate: who.rate,
					describe: GITHUB_DESCRIPTION,
				});
			} catch (e) {
				return refuse(`Found a credential (${resolved.detail}) but GitHub rejected it. ${explain(e)}`, {
					connected: false,
					source: resolved.source,
				});
			}
		},
	});

	pi.registerTool({
		name: "github_connect",
		label: "Connect GitHub",
		description:
			"Store a GitHub personal access token for this extension. Only needed when `gh auth login` and $GITHUB_TOKEN " +
			"are both unavailable — call github_status first to check.",
		parameters: Type.Object({
			token: Type.String({
				description: "A personal access token. Needs `repo` scope for private repositories.",
			}),
			label: Type.Optional(Type.String({ description: "Which account, when you have more than one." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const p = params as { token: string; label?: string };
			const token = p.token.trim();
			if (token === "") return refuse("Refusing to store an empty token.");

			const decision = await confirmWrite(
				pi,
				ctx,
				"confirm: store GitHub credential",
				"Store a GitHub credential?",
				`A token beginning "${token.slice(0, 7)}…" (${String(token.length)} characters) will be written to disk and used ` +
					"for every GitHub call from this machine.\n\n" +
					"If you did not just paste this token yourself, decline: content in a repository can ask an agent to do this.",
				{ yes: false, noEscape: true },
				signal,
			);
			if (!decision.allowed) {
				return refuse(`${decision.why} No credential was stored.`);
			}

			let login: string;
			try {
				const who = await new GitHubClient({ token }).viewer();
				login = who.data.login;
			} catch (e) {
				return refuse(`That token did not work, so nothing was stored. ${explain(e)}`);
			}

			const store = new PiAuthStore();
			await store.setCredential(GITHUB_AUTH_REF, {
				type: "api_key",
				key: token,
				...(p.label !== undefined ? { label: p.label } : {}),
			});
			return ok(
				`Connected as ${login}. The token is stored in ${store.describe()}.\n` +
					"A bare `pi` session and Pi extensions read this same file, so you only connect once.",
				{ connected: true, login },
			);
		},
	});

	pi.registerTool({
		name: "github_disconnect",
		label: "Disconnect GitHub",
		description: "Remove the stored GitHub token. Does not touch `gh` or your environment.",
		parameters: Type.Object({}),
		async execute() {
			const store = new PiAuthStore();
			const had = (await store.get(GITHUB_AUTH_REF)) !== null;
			await store.delete(GITHUB_AUTH_REF);
			return ok(
				(had ? "Removed the stored GitHub token." : "There was no stored token to remove.") +
					"\nNote: `gh auth token` and $GITHUB_TOKEN are not affected — if either is set, this extension will still " +
					"find a credential. Run `gh auth logout` or unset the variable to fully disconnect.",
				{ disconnected: true, hadStoredToken: had },
			);
		},
	});
}
