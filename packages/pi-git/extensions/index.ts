import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { checklist } from "../src/checklist.ts";
import { summarizeDiff } from "../src/diff.ts";
import { isRepository, LocalGitExec, repositoryRoot } from "../src/exec.ts";
import { branches, commitsBetween, diff, isSafeRevisionSpec, status, worktrees } from "../src/repo.ts";
import { renderBranches, renderChecklist, renderDiff, renderStatus, renderToolCall } from "../src/tui.ts";

const MAX_LIMIT = 200;

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

const exec = new LocalGitExec();

async function repoDir(
	pathArg: string | undefined,
	ctx: ExtensionContext,
): Promise<{ cwd: string } | { error: string }> {
	const start = pathArg !== undefined && pathArg.trim() !== "" ? pathArg : ctx.cwd;
	if (!(await isRepository(exec, start))) {
		return {
			error:
				`${start} is not inside a git repository. ` +
				"Pass `path` to point at one, or run this from a checkout.",
		};
	}
	const root = await repositoryRoot(exec, start);
	return { cwd: root ?? start };
}

export default function git(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "git_status",
		label: "Git status",
		description:
			"Parsed working-tree status: branch, upstream position, and every changed file with its state as a WORD " +
			"(modified, added, untracked, renamed). Prefer this over running `git status` yourself — porcelain output is easy " +
			"to misread, and this reports conflicts and detached HEAD explicitly.",
		parameters: Type.Object({
			path: Type.Optional(
				Type.String({
					description: "A directory inside the repository. Defaults to the current one.",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as { path?: string };
			const r = await repoDir(p.path, ctx);
			if ("error" in r) return refuse(r.error);
			try {
				const st = await status(exec, r.cwd);
				const lines = [
					st.detached ? "HEAD is detached" : `on ${st.branch ?? "(unknown)"}`,
					st.upstream === null
						? "no upstream"
						: `tracking ${st.upstream}${st.ahead > 0 ? `, ahead ${String(st.ahead)}` : ""}${st.behind > 0 ? `, behind ${String(st.behind)}` : ""}`,
					st.conflicted
						? `CONFLICTS unresolved: ${st.conflictPaths.join(", ")}`
						: `${String(st.files.length)} change(s)`,
				];
				for (const f of st.files.slice(0, MAX_LIMIT)) {
					lines.push(`  ${f.status}${f.staged ? "" : " (unstaged)"}: ${f.path}`);
				}
				if (st.files.length > MAX_LIMIT) {
					lines.push(`  … and ${String(st.files.length - MAX_LIMIT)} more`);
				}
				return ok(lines.join("\n"), { cwd: r.cwd, status: st });
			} catch (e) {
				return refuse(explain(e));
			}
		},
		renderCall: (args: unknown) => renderToolCall("git_status", (args ?? {}) as Record<string, unknown>),
		renderResult: (result: unknown) => {
			const d = (result as { details?: { status?: Parameters<typeof renderStatus>[0] } }).details;
			return renderStatus(d?.status ?? { branch: null, ahead: 0, behind: 0, files: [], conflicted: false });
		},
	});

	pi.registerTool({
		name: "git_diff",
		label: "Git diff",
		description:
			"A parsed diff: per-file additions, deletions and hunks. Use `ref` for a revision or range " +
			'("HEAD~3", "main...HEAD"), or omit it for uncommitted changes. Returns the patch, so no follow-up call is needed.',
		parameters: Type.Object({
			ref: Type.Optional(
				Type.String({
					description: 'A revision or range. Omit for the working tree, "--staged" for the index.',
				}),
			),
			file: Type.Optional(Type.String({ description: "Limit to one path." })),
			path: Type.Optional(Type.String({ description: "A directory inside the repository." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as { ref?: string; file?: string; path?: string };
			const r = await repoDir(p.path, ctx);
			if ("error" in r) return refuse(r.error);

			const ref = p.ref?.trim();
			if (ref !== undefined && ref !== "" && ref !== "--staged" && !isSafeRevisionSpec(ref)) {
				return refuse(
					`"${ref}" is not a revision this tool will pass to git. Use a branch, tag, SHA, or a range like "main...HEAD".`,
				);
			}

			try {
				const target =
					ref === "--staged"
						? ({ kind: "staged" } as const)
						: ref !== undefined && ref !== ""
							? ({
									kind: "range",
									spec: ref,
									...(p.file !== undefined ? { path: p.file } : {}),
								} as const)
							: p.file !== undefined
								? ({ kind: "file", path: p.file } as const)
								: ({ kind: "worktree" } as const);

				const parsed = await diff(exec, r.cwd, target);
				const summary = summarizeDiff(parsed);
				const text =
					parsed.files.length === 0
						? "No changes."
						: `${summary}\n\n${parsed.files
								.map((f) => {
									const head = `--- ${f.oldPath !== null && f.oldPath !== f.path ? `${f.oldPath} → ` : ""}${f.path} [${f.status} +${String(f.additions)}/-${String(f.deletions)}]`;
									if (f.binary) return `${head}\n(binary)`;
									const body = f.hunks
										.map((h) => [h.header, ...h.lines.map((l) => l.text)].join("\n"))
										.join("\n");
									const note = f.noNewlineAtEof ? "\n(no newline at end of file)" : "";
									return `${head}\n${body}${note}`;
								})
								.join("\n\n")}`;
				return ok(text, { cwd: r.cwd, summary, diff: parsed });
			} catch (e) {
				return refuse(explain(e));
			}
		},
		renderCall: (args: unknown) => renderToolCall("git_diff", (args ?? {}) as Record<string, unknown>),
		renderResult: (result: unknown) => {
			const d = (result as { details?: { diff?: { files?: Parameters<typeof renderDiff>[0] } } }).details;
			return renderDiff(d?.diff?.files ?? []);
		},
	});

	pi.registerTool({
		name: "git_branches",
		label: "Git branches",
		description:
			"Local branches with their upstream, how far ahead or behind each is, and its last commit subject — so a branch " +
			"list is scannable without a second call per branch.",
		parameters: Type.Object({
			path: Type.Optional(Type.String()),
			include_worktrees: Type.Optional(
				Type.Boolean({
					description: "Also list linked worktrees and which branch each has checked out.",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as { path?: string; include_worktrees?: boolean };
			const r = await repoDir(p.path, ctx);
			if ("error" in r) return refuse(r.error);
			try {
				const rows = await branches(exec, r.cwd);
				const trees = p.include_worktrees === true ? await worktrees(exec, r.cwd) : [];
				const lines = rows.map(
					(b) =>
						`${b.current ? "* " : "  "}${b.name}  ${b.upstream ?? "no upstream"}` +
						`${b.ahead > 0 ? ` ahead ${String(b.ahead)}` : ""}${b.behind > 0 ? ` behind ${String(b.behind)}` : ""}` +
						`${b.subject === null ? "" : ` — ${b.subject}`}`,
				);
				if (trees.length > 0) {
					lines.push("", "worktrees:");
					for (const t of trees) lines.push(`  ${t.path}${t.branch === null ? "" : ` (${t.branch})`}`);
				}
				return ok(lines.join("\n") || "No branches.", {
					cwd: r.cwd,
					branches: rows,
					worktrees: trees,
				});
			} catch (e) {
				return refuse(explain(e));
			}
		},
		renderCall: (args: unknown) => renderToolCall("git_branches", (args ?? {}) as Record<string, unknown>),
		renderResult: (result: unknown) => {
			const d = (result as { details?: { branches?: Parameters<typeof renderBranches>[0] } }).details;
			return renderBranches(d?.branches ?? []);
		},
	});

	pi.registerTool({
		name: "git_checklist",
		label: "Git checklist",
		description:
			'Answers "can I open a pull request?" in one call: conflicts, working-tree cleanliness, and any verification ' +
			"commands you pass. An UNCONFIGURED check does not pass — a green checklist with nothing set up is worse than none.",
		parameters: Type.Object({
			path: Type.Optional(Type.String()),
			commands: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: 'Verification commands by name, e.g. {"tests": "pnpm vitest run"}.',
				}),
			),
			expect: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Which checks must exist. Defaults to tests, typecheck, lint. Unconfigured ones block.",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as { path?: string; commands?: Record<string, string>; expect?: string[] };
			const r = await repoDir(p.path, ctx);
			if ("error" in r) return refuse(r.error);
			try {
				const result = await checklist(exec, r.cwd, {
					...(p.commands !== undefined ? { commands: p.commands } : {}),
					...(p.expect !== undefined ? { expect: p.expect } : {}),
					configHint: (n) => `pass commands.${n} to run this`,
				});
				const lines = [
					result.ready ? "READY" : "NOT READY",
					...result.checks.map((c) => `  ${c.state}: ${c.name}${c.detail === null ? "" : ` — ${c.detail}`}`),
				];
				return ok(lines.join("\n"), { cwd: r.cwd, ...result });
			} catch (e) {
				return refuse(explain(e));
			}
		},
		renderCall: (args: unknown) => renderToolCall("git_checklist", (args ?? {}) as Record<string, unknown>),
		renderResult: (result: unknown) => {
			const d = (
				result as {
					details?: {
						ready?: boolean;
						checks?: { name: string; state: string; detail: string | null }[];
					};
				}
			).details;
			return renderChecklist({ ready: d?.ready ?? false, checks: d?.checks ?? [] });
		},
	});

	pi.registerTool({
		name: "git_log",
		label: "Git log",
		description:
			"Commits on a branch or between two revisions, newest first, with author and subject. Use this to summarise what " +
			"changed rather than reading a diff.",
		parameters: Type.Object({
			from: Type.Optional(
				Type.String({
					description: "The older revision. With `to`, lists what is in `to` and not `from`.",
				}),
			),
			to: Type.Optional(Type.String({ description: "The newer revision. Defaults to HEAD." })),
			limit: Type.Optional(Type.Number()),
			path: Type.Optional(Type.String()),
			format: Type.Optional(StringEnum(["short", "full"] as const)),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as {
				from?: string;
				to?: string;
				limit?: number;
				path?: string;
				format?: "short" | "full";
			};
			const r = await repoDir(p.path, ctx);
			if ("error" in r) return refuse(r.error);

			for (const [name, v] of [
				["from", p.from],
				["to", p.to],
			] as const) {
				if (v !== undefined && v.trim() !== "" && !isSafeRevisionSpec(v)) {
					return refuse(`"${v}" is not a revision this tool will pass to git (\`${name}\`).`);
				}
			}

			try {
				const range = p.from === undefined ? (p.to ?? "HEAD") : `${p.from}..${p.to ?? "HEAD"}`;
				const commits = await commitsBetween(exec, r.cwd, range, Math.min(p.limit ?? 50, MAX_LIMIT));
				const shown = commits;
				const lines = shown.map((c) =>
					p.format === "full"
						? `${c.sha.slice(0, 8)}\n    ${c.subject}`
						: `${c.sha.slice(0, 8)} ${c.subject}`,
				);
				return ok(shown.length === 0 ? "No commits in that range." : lines.join("\n"), {
					cwd: r.cwd,
					commits: shown,
				});
			} catch (e) {
				return refuse(explain(e));
			}
		},
		renderCall: (args: unknown) => renderToolCall("git_log", (args ?? {}) as Record<string, unknown>),
	});
}

function explain(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
