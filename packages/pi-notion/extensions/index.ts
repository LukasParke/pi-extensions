import { HttpError } from "@parke.dev/pi-integration-http";
import { PiAuthStore, registerCredentialCommand } from "@parke.dev/pi-integration-auth";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { NO_KEY_MESSAGE, NOTION_AUTH_REF, resolveKey } from "../src/auth.ts";
import { withBlockedSignal } from "./blocked.ts";
import { NotionClient } from "../src/client.ts";
import { NOTION_DESCRIPTION } from "../src/describe.ts";
import { renderToolCall, renderToolResult } from "../src/tui.ts";
import { type PageRow, pageToText, toPageDetail, toPageRow } from "../src/viewmodel.ts";
import {
	searchSchema,
	pageSchema,
	appendSchema,
	statusSchema,
	connectSchema,
	disconnectSchema,
} from "../src/schemas.ts";

const MAX_LIMIT = 50;
const namespace = { name: "notion", description: "Notion pages, content and credentials" };
const readAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
};

function ok(text: string, details: unknown) {
	return {
		content: [{ type: "text" as const, text }],
		details,
		structuredContent: JSON.parse(JSON.stringify(details)),
	};
}

function refuse(text: string, details?: unknown) {
	const data = {
		refused: true,
		...(typeof details === "object" && details !== null ? details : {}),
	};
	return {
		...ok(text, data),
		structuredContent: JSON.parse(JSON.stringify({ ...data, error: text })),
		isError: true,
	};
}

function explain(e: unknown): string {
	if (e instanceof HttpError) {
		const provider = e.providerMessage === null ? "" : ` Notion said: ${e.providerMessage}`;
		const wait = e.retryAfterSec === null ? "" : ` Retry in about ${String(e.retryAfterSec)}s.`;
		const remedy =
			e.code === "reauthorize"
				? " Reconnect with `notion_connect` — an internal integration token from Notion → Settings → Connections."
				: "";
		return `${e.message}.${provider}${wait}${remedy}`;
	}
	return e instanceof Error ? e.message : String(e);
}

async function client(): Promise<{ notion: NotionClient } | { error: string }> {
	const resolved = await resolveKey();
	if (resolved === null) return { error: NO_KEY_MESSAGE };
	return { notion: new NotionClient({ key: resolved.token }) };
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
			why: `This writes to Notion and nobody can be asked to confirm in this mode. ${hint}`,
		};
	}
	const answer = await withBlockedSignal(pi, label, () => ctx.ui.confirm(title, detail, { signal }));
	return answer === true
		? { allowed: true }
		: { allowed: false, why: "The user declined. Nothing was written." };
}

function renderRows(rows: PageRow[], truncated: boolean): string {
	if (rows.length === 0) return "No matching pages.";
	const body = rows.map((r) => `${r.title} (${r.parent}) ${r.url === "" ? r.id : r.url}`).join("\n");
	return truncated ? `${body}\n\n(truncated — more pages exist than were fetched)` : body;
}

export default function notion(pi: ExtensionAPI): void {
	const registerTool: ExtensionAPI["registerTool"] = (tool) =>
		pi.registerTool({
			...tool,
			renderCall: (args, theme, context) => renderToolCall(tool.name, args, theme, context),
			renderResult: (result, options, theme, context) =>
				renderToolResult(tool.name, result, options, theme, context),
		});
	registerCredentialCommand(pi, {
		id: "notion-login",
		label: "Notion",
		authRef: NOTION_AUTH_REF,
		envNames: ["NOTION_TOKEN", "NOTION_API_KEY"],
		prompt: "Paste a Notion internal integration token",
		store: new PiAuthStore(),
		validate: async (key) => (await new NotionClient({ key }).me()).data.name,
	});

	registerTool({
		name: "notion_search",
		namespace,
		annotations: readAnnotations,
		outputSchema: searchSchema,
		label: "Notion search",
		description:
			"Find Notion pages this integration can see. Most recently edited first. Pass a query to search; omit it to list. " +
			"The list is bounded and says when it was cut short.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Search text. Omit to list recent pages." })),
			limit: Type.Optional(Type.Number()),
		}),
		async execute(_id, params) {
			const p = params as { query?: string; limit?: number };
			const c = await client();
			if ("error" in c) return refuse(c.error);
			try {
				const res = await c.notion.search({
					limit: Math.min(p.limit ?? 25, MAX_LIMIT),
					...(p.query !== undefined ? { query: p.query } : {}),
				});
				const rows = res.data.map(toPageRow);
				const truncated = res.truncated === true;
				return ok(renderRows(rows, truncated), {
					segment: "pages",
					rows,
					truncated,
					rate: res.rate,
				});
			} catch (e) {
				return refuse(explain(e));
			}
		},
	});

	registerTool({
		name: "notion_page",
		namespace,
		annotations: readAnnotations,
		outputSchema: pageSchema,
		label: "Notion page",
		description:
			"Read one page as structured blocks. This is the main read — it returns the page content, so no follow-up call is " +
			"needed for ordinary docs. Blocks this package does not render appear as `unsupported` with their Notion type; they " +
			"are never dropped silently.",
		parameters: Type.Object({
			page: Type.String({ description: "The page id (UUID, with or without dashes)." }),
		}),
		async execute(_id, params) {
			const p = params as { page: string };
			const c = await client();
			if ("error" in c) return refuse(c.error);
			try {
				const res = await c.notion.page(p.page);
				const detail = toPageDetail(res.data.page, res.data.blocks, res.data.truncated);
				return ok(pageToText(detail), {
					segment: "page",
					block: "page",
					page: detail,
					rate: res.rate,
				});
			} catch (e) {
				return refuse(explain(e));
			}
		},
	});

	/* -------------------------------- writes -------------------------------- */

	registerTool({
		name: "notion_append",
		namespace,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		outputSchema: appendSchema,
		label: "Notion append",
		description:
			"Append plain-text paragraphs to a page, one per non-empty line. The user is asked to confirm and sees the full " +
			"text first; nothing is written if they decline. Not a markdown converter.",
		parameters: Type.Object({
			page: Type.String({ description: "The page id to append to." }),
			text: Type.String({ description: "The content. Blank lines separate paragraphs." }),
			yes: Type.Optional(
				Type.Boolean({ description: "Skip the confirmation. Only for non-interactive use." }),
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const p = params as { page: string; text: string; yes?: boolean };
			const c = await client();
			if ("error" in c) return refuse(c.error);

			const preview =
				p.text.length > 2000
					? `${p.text.slice(0, 2000)}\n… (${String(p.text.length)} characters total)`
					: p.text;
			const decision = await confirmWrite(
				pi,
				ctx,
				`confirm: append to Notion page ${p.page}`,
				`Append to Notion page ${p.page}?`,
				preview,
				{ yes: p.yes === true },
				signal,
			);
			if (!decision.allowed) return refuse(decision.why);

			try {
				const res = await c.notion.append(p.page, p.text);
				return ok(
					`Appended ${String(res.data.paragraphs)} paragraph${res.data.paragraphs === 1 ? "" : "s"}` +
						(res.data.firstBlockId === null ? "." : ` (first block ${res.data.firstBlockId}).`),
					{ posted: true, ...res.data, rate: res.rate },
				);
			} catch (e) {
				return refuse(explain(e));
			}
		},
	});

	/* ------------------------------ credential ------------------------------ */

	registerTool({
		name: "notion_status",
		namespace,
		annotations: readAnnotations,
		outputSchema: statusSchema,
		label: "Notion status",
		description:
			"Report whether Notion is reachable, which credential is in use and where it came from, and what this extension " +
			"can and cannot do. Call this first when something is not working.",
		parameters: Type.Object({}),
		async execute() {
			const resolved = await resolveKey();
			if (resolved === null) return refuse(NO_KEY_MESSAGE, { connected: false });
			try {
				const who = await new NotionClient({ key: resolved.token }).me();
				const lines = [
					`Connected to Notion as ${who.data.name} (${who.data.type}).`,
					`Credential: ${resolved.detail}.`,
					`Reads: ${NOTION_DESCRIPTION.segments.map((s) => s.id).join(", ")}.`,
					`Writes: ${NOTION_DESCRIPTION.actions.map((a) => a.id).join(", ")} (each asks first).`,
					`Deliberately not available: ${NOTION_DESCRIPTION.refuses.map((r) => r.id).join(", ")}.`,
				];
				return ok(lines.join("\n"), {
					connected: true,
					who: who.data,
					source: resolved.source,
					describe: NOTION_DESCRIPTION,
				});
			} catch (e) {
				return refuse(`Found a credential (${resolved.detail}) but Notion rejected it. ${explain(e)}`, {
					connected: false,
					source: resolved.source,
				});
			}
		},
	});

	registerTool({
		name: "notion_connect",
		namespace,
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
		outputSchema: connectSchema,
		label: "Connect Notion",
		description:
			"Store a Notion internal-integration token for this extension. Create one at Notion → Settings → Connections → " +
			"Develop or manage integrations, and share the relevant pages with it. Call notion_status first — $NOTION_TOKEN " +
			"may already be set.",
		parameters: Type.Object({
			key: Type.String({
				description: "An internal integration token (starts with secret_ or ntn_).",
			}),
			label: Type.Optional(Type.String({ description: "Which workspace, when you have more than one." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const p = params as { key: string; label?: string };
			const key = p.key.trim();
			if (key === "") return refuse("Refusing to store an empty key.");

			const decision = await confirmWrite(
				pi,
				ctx,
				"confirm: store Notion credential",
				"Store a Notion credential?",
				`A key beginning "${key.slice(0, 8)}…" (${String(key.length)} characters) will be written to disk and used for ` +
					"every Notion call from this machine.\n\n" +
					"If you did not just paste this key yourself, decline: content in a repository can ask an agent to do this.",
				{ yes: false, noEscape: true },
				signal,
			);
			if (!decision.allowed) return refuse(`${decision.why} No credential was stored.`);

			let name: string;
			try {
				name = (await new NotionClient({ key }).me()).data.name;
			} catch (e) {
				return refuse(`That key did not work, so nothing was stored. ${explain(e)}`);
			}

			const store = new PiAuthStore();
			await store.setCredential(NOTION_AUTH_REF, {
				type: "api_key",
				key,
				...(p.label !== undefined ? { label: p.label } : {}),
			});
			return ok(
				`Connected as ${name}. The key is stored in ${store.describe()}.\n` +
					"A bare `pi` session and Pi extensions read this same file, so you only connect once.\n" +
					"Share the pages this integration should see from each page's ••• → Connections menu — a token alone sees nothing.",
				{ connected: true, who: name },
			);
		},
	});

	registerTool({
		name: "notion_disconnect",
		namespace,
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		outputSchema: disconnectSchema,
		label: "Disconnect Notion",
		description: "Remove the stored Notion key. Does not touch your environment.",
		parameters: Type.Object({}),
		async execute() {
			const store = new PiAuthStore();
			const had = (await store.get(NOTION_AUTH_REF)) !== null;
			await store.delete(NOTION_AUTH_REF);
			return ok(
				(had ? "Removed the stored Notion key." : "There was no stored key to remove.") +
					"\nNote: $NOTION_TOKEN / $NOTION_API_KEY are not affected — if either is set, this extension will still find a credential.",
				{ disconnected: true, hadStoredKey: had },
			);
		},
	});
}
