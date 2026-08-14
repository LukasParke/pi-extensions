import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dispatchQueue, ensureDelivery } from "@parke.dev/pi-dispatch";
import { Type } from "typebox";
import { GraphitiClient, type FactResult } from "../src/client.ts";
import { graphitiConfig } from "../src/config.ts";
import { RecallPipeline, extractRecallContext, formatRecallMessage } from "../src/recall.ts";

// Graphiti shared memory for pi.
//
// Owns a direct MCP-over-HTTP connection to a Graphiti server (no gateway in
// between) and makes memory table stakes without ever blocking a turn:
//  - background recall: conversation state (latest user message + assistant
//    tail + recent tool activity) is searched against the graph off the turn
//    path; new facts arrive via the dispatch queue at the next turn boundary
//  - memory_remember / memory_recall / memory_status tools for explicit use
//  - a store-before-finishing policy block appended to the system prompt,
//    plus a one-shot dispatch reminder when a substantive session ends
//    without a single memory_remember
//
// Config lives in ~/.pi/graphiti.json or GRAPHITI_* env vars; see src/config.ts.

const STORE_POLICY = `## Graphiti memory

Durable shared memory is available via memory_recall / memory_remember.
Relevant facts are auto-recalled into context; cite them as "per memory: ...".
Before finishing a session that produced durable outcomes — decisions,
environment changes, constraints, non-obvious debugging results — store one
small episode per fact with memory_remember. Skip ephemera, anything derivable
from a repo, and never store secret values (store where they live instead).`;

const STORE_REMINDER =
	"This session has done substantive work but memory_remember has not been called. " +
	"Per the Graphiti memory policy, store durable outcomes (decisions, environment changes, " +
	"constraints, non-obvious debugging results) as one small episode per fact before finishing.";

/** Settled turns before the store reminder is eligible. */
const STORE_REMINDER_MIN_SETTLED_TURNS = 10;

export default function (pi: ExtensionAPI) {
	ensureDelivery(pi);

	let client: GraphitiClient | undefined;
	let unavailable: string | undefined;
	let remembered = false;
	let reminderSent = false;
	let settledTurns = 0;

	async function getClient(): Promise<GraphitiClient> {
		if (!client) client = new GraphitiClient(await graphitiConfig());
		return client;
	}

	const pipeline = new RecallPipeline({
		config: graphitiConfig,
		searchFacts: async (query, maxFacts) => (await getClient()).searchFacts(query, maxFacts),
		publish: (facts: FactResult[]) => {
			dispatchQueue().publish({
				id: "graphiti:recall",
				source: "graphiti",
				priority: "info",
				urgency: "next-turn",
				message: formatRecallMessage(facts),
				details: { facts },
			});
		},
	});

	function recallFromSession(ctx: ExtensionContext, userMessage?: string): void {
		if (unavailable) return;
		try {
			const extracted = extractRecallContext(ctx.sessionManager.getBranch());
			pipeline.trigger({
				userMessage: userMessage ?? extracted.userMessage,
				assistantTail: extracted.assistantTail,
				toolNames: extracted.toolNames,
			});
		} catch {
			// Session state is best-effort context; never block the turn on it.
		}
	}

	pi.on("session_start", (_event, ctx) => {
		unavailable = undefined;
		remembered = false;
		reminderSent = false;
		settledTurns = 0;
		pipeline.reset();
		// Fire-and-forget: the status glyph lands whenever the check resolves.
		void (async () => {
			try {
				const status = await (await getClient()).status();
				if (status.status !== "ok") unavailable = status.message ?? "server not ok";
			} catch (error) {
				unavailable = error instanceof Error ? error.message : String(error);
			}
			if (unavailable && ctx.hasUI) {
				ctx.ui.setStatus("graphiti", `memory unavailable: ${unavailable.slice(0, 80)}`);
			}
		})().catch(() => {});
	});

	pi.on("session_shutdown", () => {
		client?.close();
		client = undefined;
	});

	pi.on("before_agent_start", (event, ctx) => {
		// Synchronous: only the system-prompt append. Recall runs in the
		// background and arrives via dispatch at the next turn boundary.
		recallFromSession(ctx, event.prompt);
		return { systemPrompt: `${event.systemPrompt}\n\n${STORE_POLICY}` };
	});

	pi.on("agent_settled", (_event, ctx) => {
		settledTurns++;
		recallFromSession(ctx);
		if (!remembered && !reminderSent && settledTurns >= STORE_REMINDER_MIN_SETTLED_TURNS) {
			reminderSent = true;
			dispatchQueue().publish({
				id: "graphiti:store-reminder",
				source: "graphiti:store",
				priority: "info",
				urgency: "next-turn",
				message: STORE_REMINDER,
			});
		}
	});

	pi.registerTool({
		name: "memory_recall",
		label: "Memory Recall",
		description:
			"Search shared Graphiti memory. mode 'facts' (default) does semantic search over stored facts; 'nodes' finds entities (people, hosts, services, projects); 'episodes' lists recent raw episodes chronologically.",
		parameters: Type.Object({
			query: Type.String({ description: "What to look for. Ignored for mode 'episodes'." }),
			mode: Type.Optional(Type.String({ description: "'facts' (default), 'nodes', or 'episodes'" })),
			limit: Type.Optional(Type.Number({ description: "Max results, default 10" })),
		}),
		async execute(_id, params, signal) {
			const c = await getClient();
			const limit = params.limit ?? 10;
			const mode = params.mode ?? "facts";
			let payload: unknown;
			if (mode === "nodes") payload = await c.searchNodes(params.query, limit, signal);
			else if (mode === "episodes") payload = await c.recentEpisodes(limit, signal);
			else {
				const facts = await c.searchFacts(params.query, limit, signal);
				pipeline.markSeen(facts);
				payload = facts;
			}
			return {
				content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "memory_remember",
		label: "Memory Remember",
		description:
			"Store one durable fact, decision, constraint, or outcome in shared Graphiti memory. One small episode per fact. Include source context in the body. Never store secret values — store where they live instead.",
		parameters: Type.Object({
			name: Type.String({ description: "Short episode title, e.g. 'Bifrost replaced LiteLLM'" }),
			body: Type.String({
				description: "The fact itself, self-contained, with source context and dates",
			}),
			source_description: Type.Optional(
				Type.String({ description: "Where this came from, e.g. 'pi session 2026-08-11'" }),
			),
		}),
		async execute(_id, params, signal) {
			const c = await getClient();
			const result = await c.addMemory(
				{
					name: params.name,
					episodeBody: params.body,
					sourceDescription: params.source_description,
				},
				signal,
			);
			remembered = true;
			dispatchQueue().suppress("graphiti:store");
			return { content: [{ type: "text", text: result }], details: {} };
		},
	});

	pi.registerTool({
		name: "memory_status",
		label: "Memory Status",
		description: "Health-check the Graphiti memory server. Use when recall or remember calls fail.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			const c = await getClient();
			const status = await c.status(signal);
			return { content: [{ type: "text", text: JSON.stringify(status) }], details: {} };
		},
	});
}
