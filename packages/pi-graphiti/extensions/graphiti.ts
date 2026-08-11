import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { GraphitiClient } from "../src/client.ts";
import { graphitiConfig } from "../src/config.ts";

// Graphiti shared memory for pi.
//
// Owns a direct MCP-over-HTTP connection to a Graphiti server (no gateway in
// between) and makes memory table stakes:
//  - auto-recall: every substantive prompt is searched against the graph and
//    top facts are injected as context before the agent starts
//  - memory_remember / memory_recall / memory_status tools for explicit use
//  - a store-before-finishing policy block appended to the system prompt
//
// Config lives in ~/.pi/graphiti.json or GRAPHITI_* env vars; see src/config.ts.

const STORE_POLICY = `## Graphiti memory

Durable shared memory is available via memory_recall / memory_remember.
Relevant facts are auto-recalled into context; cite them as "per memory: ...".
Before finishing a session that produced durable outcomes — decisions,
environment changes, constraints, non-obvious debugging results — store one
small episode per fact with memory_remember. Skip ephemera, anything derivable
from a repo, and never store secret values (store where they live instead).`;

export default function (pi: ExtensionAPI) {
	let client: GraphitiClient | undefined;
	let unavailable: string | undefined;

	async function getClient(): Promise<GraphitiClient> {
		if (!client) client = new GraphitiClient(await graphitiConfig());
		return client;
	}

	pi.on("session_start", async (_event, ctx) => {
		unavailable = undefined;
		try {
			const c = await getClient();
			const status = await c.status();
			if (status.status !== "ok") {
				unavailable = status.message ?? "server not ok";
			}
		} catch (error) {
			unavailable = error instanceof Error ? error.message : String(error);
		}
		if (unavailable && ctx.hasUI) {
			ctx.ui.setStatus("graphiti", `memory unavailable: ${unavailable.slice(0, 80)}`);
		}
	});

	pi.on("session_shutdown", async () => {
		client?.close();
		client = undefined;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const systemPrompt = `${event.systemPrompt}\n\n${STORE_POLICY}`;
		if (unavailable) return { systemPrompt };

		const config = await graphitiConfig();
		if (config.autoRecallFacts <= 0) return { systemPrompt };
		if (event.prompt.trim().length < config.autoRecallMinPromptLength) return { systemPrompt };

		try {
			const c = await getClient();
			const facts = await c.searchFacts(event.prompt, config.autoRecallFacts, ctx.signal);
			if (facts.length === 0) return { systemPrompt };
			const lines = facts.map((f) => `- ${f.fact}${f.invalid_at ? " (superseded)" : ""}`);
			return {
				systemPrompt,
				message: {
					customType: "graphiti-recall",
					content: `Recalled from memory (verify against current state before relying on):\n${lines.join("\n")}`,
					display: true,
				},
			};
		} catch {
			// Recall is best-effort; a slow or failing graph must never block the turn.
			return { systemPrompt };
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
			else payload = await c.searchFacts(params.query, limit, signal);
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
