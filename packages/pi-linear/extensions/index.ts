import { HttpError } from "@parke.dev/pi-integration-http";
import { PiAuthStore, registerCredentialCommand } from "@parke.dev/pi-integration-auth";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { LINEAR_AUTH_REF, NO_KEY_MESSAGE, resolveKey } from "../src/auth.ts";
import { LinearClient } from "../src/client.ts";
import { LINEAR_DESCRIPTION } from "../src/describe.ts";
import { renderIssues, renderToolCall } from "../src/tui.ts";
import { type IssueRow, toIssueDetail, toIssueRow } from "../src/viewmodel.ts";

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
		const provider = e.providerMessage === null ? "" : ` Linear said: ${e.providerMessage}`;
		const wait = e.retryAfterSec === null ? "" : ` Retry in about ${String(e.retryAfterSec)}s.`;
		const remedy =
			e.code === "reauthorize"
				? " Reconnect with `linear_connect` — a key from Linear → Settings → API."
				: "";
		return `${e.message}.${provider}${wait}${remedy}`;
	}
	return e instanceof Error ? e.message : String(e);
}

async function client(): Promise<{ linear: LinearClient } | { error: string }> {
	const resolved = await resolveKey();
	if (resolved === null) return { error: NO_KEY_MESSAGE };
	return { linear: new LinearClient({ key: resolved.token }) };
}

async function confirmWrite(
	ctx: ExtensionContext,
	title: string,
	detail: string,
	forcible: { yes: boolean } | { yes: false; noEscape: true },
): Promise<{ allowed: true } | { allowed: false; why: string }> {
	if (forcible.yes) return { allowed: true };
	if (!ctx.hasUI) {
		const hint =
			"noEscape" in forcible
				? "This can only be done in an interactive session — there is deliberately no flag to skip it."
				: "Pass `yes: true` to proceed without asking, or run in an interactive session.";
		return {
			allowed: false,
			why: `This writes to Linear and nobody can be asked to confirm in this mode. ${hint}`,
		};
	}
	const answer = await ctx.ui.confirm(title, detail);
	return answer === true
		? { allowed: true }
		: { allowed: false, why: "The user declined. Nothing was posted." };
}

function renderRows(rows: IssueRow[]): string {
	if (rows.length === 0) return "No matching issues.";
	return rows
		.map((r) => `${r.identifier} ${r.title} (${r.state}; ${r.priority}; ${r.assignee}; ${r.team})`)
		.join("\n");
}

export default function linear(pi: ExtensionAPI): void {
	registerCredentialCommand(pi, {
		id: "linear-login",
		label: "Linear",
		authRef: LINEAR_AUTH_REF,
		envNames: ["LINEAR_API_KEY", "LINEAR_TOKEN"],
		prompt: "Paste a Linear personal API key",
		store: new PiAuthStore(),
		validate: async (key) => (await new LinearClient({ key }).viewer()).data.name,
	});

	pi.registerTool({
		name: "linear_issues",
		label: "Linear issues",
		description:
			"List or search Linear issues. Defaults to assigned-to-you and not-done — the set you act on. Pass mine:false for " +
			"the whole workspace. Priority is reported as a word (urgent, high, medium, low), not a number.",
		parameters: Type.Object({
			search: Type.Optional(Type.String({ description: "Match against the title, case-insensitive." })),
			mine: Type.Optional(Type.Boolean({ description: "Default true. false searches the whole workspace." })),
			state: Type.Optional(
				Type.String({ description: 'Exact state name, e.g. "In Review". Omit for not-done.' }),
			),
			team: Type.Optional(Type.String({ description: 'Team key, e.g. "DEV".' })),
			limit: Type.Optional(Type.Number()),
		}),
		async execute(_id, params) {
			const p = params as {
				search?: string;
				mine?: boolean;
				state?: string;
				team?: string;
				limit?: number;
			};
			const c = await client();
			if ("error" in c) return refuse(c.error);
			try {
				const res = await c.linear.issues({
					limit: Math.min(p.limit ?? 25, MAX_LIMIT),
					...(p.mine !== undefined ? { mine: p.mine } : {}),
					...(p.state !== undefined ? { state: p.state } : {}),
					...(p.search !== undefined ? { search: p.search } : {}),
					...(p.team !== undefined ? { team: p.team } : {}),
				});
				const rows = res.data.map(toIssueRow);
				return ok(renderRows(rows), { segment: "issues", rows, rate: res.rate });
			} catch (e) {
				return refuse(explain(e));
			}
		},
		renderCall: (args: unknown) => renderToolCall("linear_issues", (args ?? {}) as Record<string, unknown>),
		renderResult: (result: unknown) => {
			const d = (result as { details?: { rows?: IssueRow[] } }).details;
			return renderIssues(d?.rows ?? []);
		},
	});

	pi.registerTool({
		name: "linear_issue",
		label: "Linear issue",
		description:
			"One issue in full, with its description and every comment. This is the tool for understanding a ticket — it returns " +
			"the discussion, so no follow-up call is needed.",
		parameters: Type.Object({
			issue: Type.String({ description: 'The issue id, or its identifier like "DEV-412".' }),
		}),
		async execute(_id, params) {
			const p = params as { issue: string };
			const c = await client();
			if ("error" in c) return refuse(c.error);
			try {
				const res = await c.linear.issue(p.issue);
				const detail = toIssueDetail(res.data.issue, res.data.comments);
				const lines = [
					`${detail.identifier} ${detail.title}`,
					`${detail.state} · ${detail.priority} · ${detail.assignee} · ${detail.team}`,
					detail.url,
					"",
					detail.description.trim() === "" ? "(no description)" : detail.description.trim(),
				];
				if (detail.comments.length > 0) {
					lines.push("", `${String(detail.comments.length)} comment(s):`);
					for (const cm of detail.comments) {
						lines.push(`  ${cm.author}: ${cm.body.replace(/\n+/g, " ").slice(0, 500)}`);
					}
				}
				return ok(lines.join("\n"), {
					segment: "issue",
					block: "issue",
					issue: detail,
					rate: res.rate,
				});
			} catch (e) {
				return refuse(explain(e));
			}
		},
		renderCall: (args: unknown) => renderToolCall("linear_issue", (args ?? {}) as Record<string, unknown>),
	});

	pi.registerTool({
		name: "linear_states",
		label: "Linear states",
		description:
			"The workflow states a team has. Read this before moving an issue: it turns a state name from a guess into a choice.",
		parameters: Type.Object({
			team: Type.Optional(
				Type.String({ description: 'Team key, e.g. "DEV". Omit for every team\'s states.' }),
			),
		}),
		async execute(_id, params) {
			const p = params as { team?: string };
			const c = await client();
			if ("error" in c) return refuse(c.error);
			try {
				const res = await c.linear.states(p.team);
				const lines = res.data.map((s) => `${s.name} (${s.type})`);
				return ok(lines.join("\n") || "No states.", {
					segment: "states",
					rows: res.data,
					rate: res.rate,
				});
			} catch (e) {
				return refuse(explain(e));
			}
		},
		renderCall: (args: unknown) => renderToolCall("linear_states", (args ?? {}) as Record<string, unknown>),
	});

	/* -------------------------------- writes -------------------------------- */

	pi.registerTool({
		name: "linear_comment",
		label: "Linear comment",
		description:
			"Post a comment on an issue. The user is asked to confirm and sees the full text first; nothing is posted if they " +
			"decline.",
		parameters: Type.Object({
			issue: Type.String({ description: "The issue id or identifier." }),
			body: Type.String({ description: "The comment, as markdown." }),
			yes: Type.Optional(
				Type.Boolean({ description: "Skip the confirmation. Only for non-interactive use." }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as { issue: string; body: string; yes?: boolean };
			const c = await client();
			if ("error" in c) return refuse(c.error);

			const preview =
				p.body.length > 2000
					? `${p.body.slice(0, 2000)}\n… (${String(p.body.length)} characters total)`
					: p.body;
			const decision = await confirmWrite(ctx, `Comment on ${p.issue}?`, preview, {
				yes: p.yes === true,
			});
			if (!decision.allowed) return refuse(decision.why);

			try {
				const res = await c.linear.comment(p.issue, p.body);
				return ok(`Posted${res.data.url === null ? "" : `: ${res.data.url}`}`, {
					posted: true,
					...res.data,
					rate: res.rate,
				});
			} catch (e) {
				return refuse(explain(e));
			}
		},
	});

	pi.registerTool({
		name: "linear_transition",
		label: "Linear transition",
		description:
			"Move an issue to a different workflow state, by name. The user confirms. If the name is wrong the error lists the " +
			"valid ones, but calling linear_states first saves a round trip.",
		parameters: Type.Object({
			issue: Type.String(),
			state: Type.String({ description: 'The target state name, e.g. "In Review".' }),
			yes: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as { issue: string; state: string; yes?: boolean };
			const c = await client();
			if ("error" in c) return refuse(c.error);

			const decision = await confirmWrite(
				ctx,
				`Move ${p.issue} to "${p.state}"?`,
				"This changes the issue's state for everyone on the team.",
				{ yes: p.yes === true },
			);
			if (!decision.allowed) return refuse(decision.why);

			try {
				const res = await c.linear.transition(p.issue, p.state);
				return ok(`Moved ${p.issue} to ${res.data.state}.`, {
					posted: true,
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
		name: "linear_status",
		label: "Linear status",
		description:
			"Report whether Linear is reachable, which credential is in use and where it came from, and what this extension " +
			"can and cannot do. Call this first when something is not working.",
		parameters: Type.Object({}),
		async execute() {
			const resolved = await resolveKey();
			if (resolved === null) return refuse(NO_KEY_MESSAGE, { connected: false });
			try {
				const who = await new LinearClient({ key: resolved.token }).viewer();
				const lines = [
					`Connected to Linear as ${who.data.name}${who.data.email === null ? "" : ` (${who.data.email})`}.`,
					`Credential: ${resolved.detail}.`,
					`Reads: ${LINEAR_DESCRIPTION.segments.map((s) => s.id).join(", ")}.`,
					`Writes: ${LINEAR_DESCRIPTION.actions.map((a) => a.id).join(", ")} (each asks first).`,
					`Deliberately not available: ${LINEAR_DESCRIPTION.refuses.map((r) => r.id).join(", ")}.`,
				];
				return ok(lines.join("\n"), {
					connected: true,
					who: who.data,
					source: resolved.source,
					describe: LINEAR_DESCRIPTION,
				});
			} catch (e) {
				return refuse(`Found a credential (${resolved.detail}) but Linear rejected it. ${explain(e)}`, {
					connected: false,
					source: resolved.source,
				});
			}
		},
	});

	pi.registerTool({
		name: "linear_connect",
		label: "Connect Linear",
		description:
			"Store a Linear API key for this extension. Get one from Linear → Settings → API. Call linear_status first — " +
			"$LINEAR_API_KEY may already be set.",
		parameters: Type.Object({
			key: Type.String({ description: "A personal API key." }),
			label: Type.Optional(Type.String({ description: "Which account, when you have more than one." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as { key: string; label?: string };
			const key = p.key.trim();
			if (key === "") return refuse("Refusing to store an empty key.");

			const decision = await confirmWrite(
				ctx,
				"Store a Linear credential?",
				`A key beginning "${key.slice(0, 8)}…" (${String(key.length)} characters) will be written to disk and used for ` +
					"every Linear call from this machine.\n\n" +
					"If you did not just paste this key yourself, decline: content in a repository can ask an agent to do this.",
				{ yes: false, noEscape: true },
			);
			if (!decision.allowed) return refuse(`${decision.why} No credential was stored.`);

			let name: string;
			try {
				name = (await new LinearClient({ key }).viewer()).data.name;
			} catch (e) {
				return refuse(`That key did not work, so nothing was stored. ${explain(e)}`);
			}

			const store = new PiAuthStore();
			await store.setCredential(LINEAR_AUTH_REF, {
				type: "api_key",
				key,
				...(p.label !== undefined ? { label: p.label } : {}),
			});
			return ok(
				`Connected as ${name}. The key is stored in ${store.describe()}.\n` +
					"A bare `pi` session and Pi extensions read this same file, so you only connect once.",
				{ connected: true, who: name },
			);
		},
	});

	pi.registerTool({
		name: "linear_disconnect",
		label: "Disconnect Linear",
		description: "Remove the stored Linear key. Does not touch your environment.",
		parameters: Type.Object({}),
		async execute() {
			const store = new PiAuthStore();
			const had = (await store.get(LINEAR_AUTH_REF)) !== null;
			await store.delete(LINEAR_AUTH_REF);
			return ok(
				(had ? "Removed the stored Linear key." : "There was no stored key to remove.") +
					"\nNote: $LINEAR_API_KEY is not affected — if it is set, this extension will still find a credential.",
				{ disconnected: true, hadStoredKey: had },
			);
		},
	});
}
