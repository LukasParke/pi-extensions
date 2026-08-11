import { HttpError } from "@parke.dev/pi-integration-http";
import { PiAuthStore, registerCredentialCommand } from "@parke.dev/pi-integration-auth";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { NO_TOKEN_MESSAGE, resolveToken, SLACK_AUTH_REF } from "../src/auth.ts";
import { withBlockedSignal } from "./blocked.ts";
import { SlackClient } from "../src/client.ts";
import { SLACK_DESCRIPTION } from "../src/describe.ts";
import { renderChannels, renderMessages, renderSearch, renderToolCall } from "../src/tui.ts";
import {
	type ChannelRow,
	type MessageRow,
	type SearchRow,
	toChannelRow,
	toSearchRow,
	toThreadDetail,
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
		const provider = e.providerMessage === null ? "" : ` Slack said: ${e.providerMessage}`;
		const wait = e.retryAfterSec === null ? "" : ` Retry in about ${String(e.retryAfterSec)}s.`;
		const remedy =
			e.code === "reauthorize"
				? " Reconnect with `slack_connect` — a bot token (xoxb-…) from Slack → Your Apps → OAuth."
				: "";
		return `${e.message}.${provider}${wait}${remedy}`;
	}
	return e instanceof Error ? e.message : String(e);
}

async function client(): Promise<{ slack: SlackClient } | { error: string }> {
	const resolved = await resolveToken();
	if (resolved === null) return { error: NO_TOKEN_MESSAGE };
	return { slack: new SlackClient({ token: resolved.token }) };
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
			why: `This writes to Slack and nobody can be asked to confirm in this mode. ${hint}`,
		};
	}
	const answer = await withBlockedSignal(pi, label, () => ctx.ui.confirm(title, detail, { signal }));
	return answer === true
		? { allowed: true }
		: { allowed: false, why: "The user declined. Nothing was posted." };
}

function renderChannelText(rows: ChannelRow[], truncated: boolean): string {
	if (rows.length === 0) return "No matching channels.";
	const lines = rows.map((r) => {
		const replies =
			r.replyCount > 0 ? `; ${String(r.replyCount)} ${r.replyCount === 1 ? "reply" : "replies"}` : "";
		const members = r.memberCount === null ? "" : `; ${String(r.memberCount)} members`;
		return `#${r.name} (${r.privacy}${members}${replies}) ${r.latestText.replace(/\s+/g, " ").slice(0, 160)}`;
	});
	if (truncated) {
		lines.push(
			"",
			"List truncated — pass an explicit `channels` array to name the ones that matter, rather than walking the workspace.",
		);
	}
	return lines.join("\n");
}

function splitThreadRef(ref: string): { channel: string; ts: string } {
	const i = ref.lastIndexOf("/");
	if (i === -1) return { channel: ref, ts: "" };
	return { channel: ref.slice(0, i), ts: ref.slice(i + 1) };
}

export default function slack(pi: ExtensionAPI): void {
	registerCredentialCommand(pi, {
		id: "slack-login",
		label: "Slack",
		authRef: SLACK_AUTH_REF,
		envNames: ["SLACK_BOT_TOKEN", "SLACK_TOKEN"],
		prompt: "Paste a Slack bot or user token",
		store: new PiAuthStore(),
		validate: async (token) => {
			const result = await new SlackClient({ token }).authTest();
			return `${result.data.user} on ${result.data.team}`;
		},
	});

	pi.registerTool({
		name: "slack_channels",
		label: "Slack channels",
		description:
			"List channels with their latest message. Prefer passing `channels` (ids or names) for the ones that matter — " +
			"walking an entire workspace with conversations.list burns rate budget and is bounded, with truncation reported. " +
			"Privacy is a word (private/public).",
		parameters: Type.Object({
			channels: Type.Optional(
				Type.Array(Type.String(), {
					description: "Channel ids (C…) or names. When omitted, falls back to a bounded conversations.list.",
				}),
			),
			limit: Type.Optional(Type.Number()),
		}),
		async execute(_id, params) {
			const p = params as { channels?: string[]; limit?: number };
			const c = await client();
			if ("error" in c) return refuse(c.error);
			try {
				const res = await c.slack.channels({
					...(p.channels !== undefined ? { channels: p.channels } : {}),
					limit: Math.min(p.limit ?? 25, MAX_LIMIT),
				});
				const rows = res.data.map((r) => toChannelRow(r.channel, r.latest));
				return ok(renderChannelText(rows, res.truncated === true), {
					segment: "channels",
					rows,
					truncated: res.truncated === true,
					rate: res.rate,
				});
			} catch (e) {
				return refuse(explain(e));
			}
		},
		renderCall: (args: unknown) => renderToolCall("slack_channels", (args ?? {}) as Record<string, unknown>),
		renderResult: (result: unknown) => {
			const d = (result as { details?: { rows?: ChannelRow[] } }).details;
			return renderChannels(d?.rows ?? []);
		},
	});

	pi.registerTool({
		name: "slack_thread",
		label: "Slack thread",
		description:
			"Read a whole thread in one call: every reply, authors resolved to names, and a permalink when available. This is " +
			"the main read — pass `channel` + `ts`, or a single `ref` as `channel/ts`.",
		parameters: Type.Object({
			channel: Type.Optional(
				Type.String({ description: "Channel id or name. Required unless `ref` is set." }),
			),
			ts: Type.Optional(
				Type.String({ description: "Parent message timestamp. Required unless `ref` is set." }),
			),
			ref: Type.Optional(
				Type.String({
					description: "Combined `channel/ts`. Alternative to the two separate fields.",
				}),
			),
		}),
		async execute(_id, params) {
			const p = params as { channel?: string; ts?: string; ref?: string };
			let channel = p.channel ?? "";
			let ts = p.ts ?? "";
			if (p.ref !== undefined && p.ref !== "") {
				const split = splitThreadRef(p.ref);
				if (channel === "") channel = split.channel;
				if (ts === "") ts = split.ts;
			}
			if (channel === "" || ts === "") {
				return refuse("slack_thread needs `channel` and `ts` (or a `ref` as channel/ts).");
			}

			const c = await client();
			if ("error" in c) return refuse(c.error);
			try {
				const res = await c.slack.thread(channel, ts);
				const detail = await toThreadDetail(c.slack, {
					channel: res.data.channel,
					ts: res.data.ts,
					messages: res.data.messages,
					permalink: res.data.permalink,
					truncated: res.truncated === true,
					channelName: channel.replace(/^#/, ""),
				});
				const lines = [
					`Thread in #${detail.channelName} (${String(detail.messages.length)} messages` +
						`${detail.truncated ? ", truncated" : ""})`,
					detail.permalink === "" ? "" : detail.permalink,
					"",
					...detail.messages.map((m: MessageRow) => {
						const tag = m.root ? " (root)" : "";
						return `${m.author}${tag}: ${m.text.replace(/\n+/g, " ").slice(0, 500)}`;
					}),
				].filter((l, i, arr) => !(l === "" && arr[i - 1] === ""));
				return ok(lines.join("\n"), {
					segment: "thread",
					block: "thread",
					thread: detail,
					rate: res.rate,
				});
			} catch (e) {
				return refuse(explain(e));
			}
		},
		renderCall: (args: unknown) => renderToolCall("slack_thread", (args ?? {}) as Record<string, unknown>),
		renderResult: (result: unknown) => {
			const d = (result as { details?: { thread?: { messages?: MessageRow[] } } }).details;
			return renderMessages(d?.thread?.messages ?? []);
		},
	});

	pi.registerTool({
		name: "slack_search",
		label: "Slack search",
		description:
			"Search messages (`search.messages`). Requires a user token with `search:read` — a bot token is rejected by Slack. " +
			"Results are newest first.",
		parameters: Type.Object({
			query: Type.String({
				description: 'Slack search query, e.g. "in:#eng after:2026-01-01 deploy".',
			}),
			limit: Type.Optional(Type.Number()),
		}),
		async execute(_id, params) {
			const p = params as { query: string; limit?: number };
			const c = await client();
			if ("error" in c) return refuse(c.error);
			try {
				const res = await c.slack.search(p.query, { limit: Math.min(p.limit ?? 20, MAX_LIMIT) });
				const rows: SearchRow[] = [];
				for (const m of res.data) rows.push(await toSearchRow(c.slack, m));
				if (rows.length === 0) {
					return ok("No matching messages.", {
						segment: "search",
						rows,
						truncated: false,
						rate: res.rate,
					});
				}
				const lines = rows.map(
					(r) =>
						`#${r.channelName} ${r.author}: ${r.text.replace(/\s+/g, " ").slice(0, 200)}` +
						(r.permalink === "" ? "" : `\n  ${r.permalink}`),
				);
				if (res.truncated === true) lines.push("", "Results truncated.");
				return ok(lines.join("\n"), {
					segment: "search",
					rows,
					truncated: res.truncated === true,
					rate: res.rate,
				});
			} catch (e) {
				return refuse(explain(e));
			}
		},
		renderCall: (args: unknown) => renderToolCall("slack_search", (args ?? {}) as Record<string, unknown>),
		renderResult: (result: unknown) => {
			const d = (result as { details?: { rows?: SearchRow[] } }).details;
			return renderSearch(d?.rows ?? []);
		},
	});

	/* -------------------------------- writes -------------------------------- */

	pi.registerTool({
		name: "slack_post",
		label: "Slack post",
		description:
			"Post a message to a channel, or reply in a thread when `threadTs` is set. The user is asked to confirm and sees " +
			"the full text first; nothing is posted if they decline. Always pass `threadTs` when replying — without it the " +
			"message lands top-level.",
		parameters: Type.Object({
			channel: Type.String({ description: "Channel id (C…) or name." }),
			text: Type.String({ description: "The message body." }),
			threadTs: Type.Optional(
				Type.String({
					description: "Parent message ts. Set this to reply in-thread rather than top-level.",
				}),
			),
			yes: Type.Optional(
				Type.Boolean({ description: "Skip the confirmation. Only for non-interactive use." }),
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const p = params as { channel: string; text: string; threadTs?: string; yes?: boolean };
			const c = await client();
			if ("error" in c) return refuse(c.error);

			const where =
				p.threadTs !== undefined && p.threadTs !== ""
					? `#${p.channel.replace(/^#/, "")} (thread ${p.threadTs})`
					: `#${p.channel.replace(/^#/, "")} (top-level)`;
			const preview =
				p.text.length > 2000
					? `${p.text.slice(0, 2000)}\n… (${String(p.text.length)} characters total)`
					: p.text;
			const decision = await confirmWrite(
				pi,
				ctx,
				`confirm: post to ${where}`,
				`Post to ${where}?`,
				preview,
				{ yes: p.yes === true },
				signal,
			);
			if (!decision.allowed) return refuse(decision.why);

			try {
				const res = await c.slack.post(p.channel, p.text, {
					...(p.threadTs !== undefined ? { threadTs: p.threadTs } : {}),
				});
				return ok(`Posted to ${res.data.channel} (ts ${res.data.ts}).`, {
					posted: true,
					channel: res.data.channel,
					ts: res.data.ts,
					rate: res.rate,
				});
			} catch (e) {
				return refuse(explain(e));
			}
		},
	});

	/* ------------------------------ credential ------------------------------ */

	pi.registerTool({
		name: "slack_status",
		label: "Slack status",
		description:
			"Report whether Slack is reachable, which credential is in use and where it came from, and what this extension " +
			"can and cannot do. Call this first when something is not working.",
		parameters: Type.Object({}),
		async execute() {
			const resolved = await resolveToken();
			if (resolved === null) return refuse(NO_TOKEN_MESSAGE, { connected: false });
			try {
				const who = await new SlackClient({ token: resolved.token }).authTest();
				const lines = [
					`Connected to Slack team ${who.data.team} as ${who.data.user}.`,
					`Credential: ${resolved.detail}.`,
					`Reads: ${SLACK_DESCRIPTION.segments.map((s) => s.id).join(", ")}.`,
					`Writes: ${SLACK_DESCRIPTION.actions.map((a) => a.id).join(", ")} (each asks first).`,
					`Deliberately not available: ${SLACK_DESCRIPTION.refuses.map((r) => r.id).join(", ")}.`,
				];
				return ok(lines.join("\n"), {
					connected: true,
					who: who.data,
					source: resolved.source,
					describe: SLACK_DESCRIPTION,
				});
			} catch (e) {
				return refuse(`Found a credential (${resolved.detail}) but Slack rejected it. ${explain(e)}`, {
					connected: false,
					source: resolved.source,
				});
			}
		},
	});

	pi.registerTool({
		name: "slack_connect",
		label: "Connect Slack",
		description:
			"Store a Slack bot token for this extension. Get one from Slack → Your Apps → OAuth & Permissions. Call " +
			"slack_status first — $SLACK_BOT_TOKEN may already be set.",
		parameters: Type.Object({
			token: Type.String({ description: "A bot token (xoxb-…) or user token (xoxp-…)." }),
			label: Type.Optional(Type.String({ description: "Which workspace, when you have more than one." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const p = params as { token: string; label?: string };
			const token = p.token.trim();
			if (token === "") return refuse("Refusing to store an empty token.");

			const decision = await confirmWrite(
				pi,
				ctx,
				"confirm: store Slack credential",
				"Store a Slack credential?",
				`A token beginning "${token.slice(0, 8)}…" (${String(token.length)} characters) will be written to disk and used ` +
					"for every Slack call from this machine.\n\n" +
					"If you did not just paste this token yourself, decline: content in a repository can ask an agent to do this.",
				{ yes: false, noEscape: true },
				signal,
			);
			if (!decision.allowed) return refuse(`${decision.why} No credential was stored.`);

			let who: string;
			try {
				const test = await new SlackClient({ token }).authTest();
				who = `${test.data.user} on ${test.data.team}`;
			} catch (e) {
				return refuse(`That token did not work, so nothing was stored. ${explain(e)}`);
			}

			const store = new PiAuthStore();
			await store.setCredential(SLACK_AUTH_REF, {
				type: "api_key",
				key: token,
				...(p.label !== undefined ? { label: p.label } : {}),
			});
			return ok(
				`Connected as ${who}. The token is stored in ${store.describe()}.\n` +
					"A bare `pi` session and Pi extensions read this same file, so you only connect once.",
				{ connected: true, who },
			);
		},
	});

	pi.registerTool({
		name: "slack_disconnect",
		label: "Disconnect Slack",
		description: "Remove the stored Slack token. Does not touch your environment.",
		parameters: Type.Object({}),
		async execute() {
			const store = new PiAuthStore();
			const had = (await store.get(SLACK_AUTH_REF)) !== null;
			await store.delete(SLACK_AUTH_REF);
			return ok(
				(had ? "Removed the stored Slack token." : "There was no stored token to remove.") +
					"\nNote: $SLACK_BOT_TOKEN / $SLACK_TOKEN are not affected — if either is set, this extension will still find a credential.",
				{ disconnected: true, hadStoredKey: had },
			);
		},
	});
}
