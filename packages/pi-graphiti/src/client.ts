/**
 * Minimal MCP-over-streamable-HTTP client, scoped to exactly what the
 * Graphiti server needs: initialize once, keep the session id, call tools.
 *
 * Responses arrive either as plain JSON or as an SSE stream whose final
 * `data:` line carries the JSON-RPC result — both are handled.
 */

import type { GraphitiConfig } from "./config.ts";

export interface FactResult {
	fact: string;
	valid_at?: string | null;
	invalid_at?: string | null;
}

interface JsonRpcResponse {
	result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
	error?: { code: number; message: string };
}

export class GraphitiClient {
	private sessionId: string | undefined;
	private initializing: Promise<void> | undefined;

	constructor(private readonly config: GraphitiConfig) {}

	get endpoint(): string {
		if (!this.config.baseUrl) {
			throw new Error(
				"Graphiti baseUrl is not configured. Set it in ~/.pi/graphiti.json or GRAPHITI_BASE_URL.",
			);
		}
		return this.config.baseUrl;
	}

	private headers(): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};
		if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;
		if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
		return headers;
	}

	private async post(body: unknown, signal?: AbortSignal): Promise<Response> {
		const timeout = AbortSignal.timeout(this.config.timeoutMs);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
		return fetch(this.endpoint, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(body),
			signal: combined,
		});
	}

	private async ensureSession(signal?: AbortSignal): Promise<void> {
		if (this.sessionId) return;
		this.initializing ??= this.initialize(signal).finally(() => {
			this.initializing = undefined;
		});
		return this.initializing;
	}

	private async initialize(signal?: AbortSignal): Promise<void> {
		const response = await this.post(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "pi-graphiti", version: "0.1.0" },
				},
			},
			signal,
		);
		if (!response.ok) {
			throw new Error(`Graphiti initialize failed: HTTP ${response.status}`);
		}
		const sessionId = response.headers.get("mcp-session-id");
		if (!sessionId) throw new Error("Graphiti server returned no mcp-session-id");
		await response.body?.cancel();
		this.sessionId = sessionId;
		await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, signal);
	}

	/** Calls one MCP tool and returns the text payload of its first content block. */
	async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
		await this.ensureSession(signal);
		const response = await this.post(
			{ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } },
			signal,
		);
		if (response.status === 404) {
			// Session expired server-side; reconnect once.
			this.sessionId = undefined;
			await this.ensureSession(signal);
			return this.callTool(name, args, signal);
		}
		if (!response.ok) {
			throw new Error(`Graphiti ${name} failed: HTTP ${response.status}`);
		}
		const rpc = await parseRpcResponse(response);
		if (rpc.error) throw new Error(`Graphiti ${name} failed: ${rpc.error.message}`);
		const text = rpc.result?.content?.find((c) => c.type === "text")?.text ?? "";
		if (rpc.result?.isError) throw new Error(`Graphiti ${name} failed: ${text.slice(0, 500)}`);
		return text;
	}

	async status(signal?: AbortSignal): Promise<{ status: string; message?: string }> {
		return parseJson(await this.callTool("get_status", {}, signal));
	}

	async addMemory(
		input: { name: string; episodeBody: string; source?: string; sourceDescription?: string },
		signal?: AbortSignal,
	): Promise<string> {
		return this.callTool(
			"add_memory",
			{
				name: input.name,
				episode_body: input.episodeBody,
				group_id: this.config.groupId,
				source: input.source ?? "text",
				source_description: input.sourceDescription ?? "pi session",
			},
			signal,
		);
	}

	async searchFacts(query: string, maxFacts: number, signal?: AbortSignal): Promise<FactResult[]> {
		const text = await this.callTool(
			"search_memory_facts",
			{ query, group_ids: [this.config.groupId], max_facts: maxFacts },
			signal,
		);
		return parseJson<{ facts?: FactResult[] }>(text).facts ?? [];
	}

	async searchNodes(query: string, maxNodes: number, signal?: AbortSignal): Promise<unknown[]> {
		const text = await this.callTool(
			"search_nodes",
			{ query, group_ids: [this.config.groupId], max_nodes: maxNodes },
			signal,
		);
		const parsed = parseJson<{ nodes?: unknown[] }>(text);
		return parsed.nodes ?? [];
	}

	async recentEpisodes(maxEpisodes: number, signal?: AbortSignal): Promise<unknown[]> {
		const text = await this.callTool(
			"get_episodes",
			{ group_ids: [this.config.groupId], max_episodes: maxEpisodes },
			signal,
		);
		return parseJson<{ episodes?: unknown[] }>(text).episodes ?? [];
	}

	close(): void {
		this.sessionId = undefined;
	}
}

async function parseRpcResponse(response: Response): Promise<JsonRpcResponse> {
	const raw = await response.text();
	const contentType = response.headers.get("content-type") ?? "";
	if (contentType.includes("text/event-stream")) {
		// Last data: line with a JSON object wins.
		const lines = raw.split("\n").filter((line) => line.startsWith("data: "));
		for (let i = lines.length - 1; i >= 0; i--) {
			const payload = lines[i].slice(6).trim();
			if (payload.startsWith("{")) return JSON.parse(payload);
		}
		throw new Error("Graphiti SSE response contained no JSON payload");
	}
	return JSON.parse(raw);
}

function parseJson<T>(text: string): T {
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error(`Graphiti returned non-JSON tool payload: ${text.slice(0, 300)}`);
	}
}
