/**
 * Graphiti configuration.
 *
 * Points at a Graphiti MCP server speaking streamable HTTP (the zep/graphiti
 * mcp_server). There is no hosted default that makes sense for anyone else,
 * so baseUrl is required via config file or env.
 */

import { httpUrl, load, nonEmptyString, number, type Schema } from "@parke.dev/pi-ext-config";

export interface GraphitiConfig {
	/** MCP endpoint, e.g. https://memory.example.com/mcp */
	baseUrl?: string;
	/** Sent as `Authorization: Bearer`. */
	apiKey?: string;
	/** Graph group id all reads and writes default to. */
	groupId: string;
	/** Per-request timeout, ms. */
	timeoutMs: number;
	/** Facts injected by auto-recall per prompt. 0 disables auto-recall. */
	autoRecallFacts: number;
	/** Prompts shorter than this skip auto-recall (greetings, confirmations). */
	autoRecallMinPromptLength: number;
	/** In-memory TTL for identical recall queries, ms. Skips repeat server hits. */
	recallCacheTtlMs: number;
}

export const defaultConfig: GraphitiConfig = {
	groupId: "main",
	timeoutMs: 15_000,
	autoRecallFacts: 5,
	autoRecallMinPromptLength: 24,
	recallCacheTtlMs: 120_000,
};

export const schema: Schema<GraphitiConfig> = {
	baseUrl: { validate: httpUrl, env: "GRAPHITI_BASE_URL" },
	apiKey: { validate: nonEmptyString, env: "GRAPHITI_API_KEY" },
	groupId: { validate: nonEmptyString, env: "GRAPHITI_GROUP_ID" },
	timeoutMs: { validate: number(1_000), env: "GRAPHITI_TIMEOUT_MS" },
	autoRecallFacts: { validate: number(0), env: "GRAPHITI_AUTO_RECALL_FACTS" },
	autoRecallMinPromptLength: { validate: number(0), env: "GRAPHITI_AUTO_RECALL_MIN_PROMPT" },
	recallCacheTtlMs: { validate: number(0), env: "GRAPHITI_RECALL_CACHE_TTL_MS" },
};

let cached: Promise<GraphitiConfig> | undefined;

export function graphitiConfig(): Promise<GraphitiConfig> {
	cached ??= load({ name: "graphiti", schema, defaults: defaultConfig }).then((r) => r.config);
	return cached;
}

export function resetConfigCache(): void {
	cached = undefined;
}
