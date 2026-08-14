/**
 * Background, conversation-aware recall pipeline.
 *
 * The synchronous hooks never touch the network: they hand a snapshot of the
 * conversation state to `RecallPipeline.trigger()`, which resolves the query,
 * hits the graph (with a short in-memory TTL cache), drops facts already
 * surfaced this session, and publishes whatever is new to the dispatch queue.
 * Everything here is pure or dependency-injected so tests never need a server.
 */

import { createHash } from "node:crypto";
import type { FactResult } from "./client.ts";
import type { GraphitiConfig } from "./config.ts";

const ASSISTANT_TAIL_CHARS = 300;
const MAX_TOOL_NAMES = 10;

export interface RecallContextInput {
	/** The current (or most recent) user message. */
	userMessage: string;
	/** Tail of the latest assistant text, for topical context. */
	assistantTail?: string;
	/** Distinctive tool names recently used. */
	toolNames?: string[];
}

export interface RecallPipelineDeps {
	searchFacts: (query: string, maxFacts: number) => Promise<FactResult[]>;
	/** Called with the facts that survived the delta filter. */
	publish: (facts: FactResult[]) => void;
	config: () => Promise<GraphitiConfig>;
	now?: () => number;
}

export function hashFact(text: string): string {
	return createHash("sha1").update(text).digest("hex");
}

/**
 * Builds the recall query from conversation state, or undefined when the user
 * message is below the min-length gate (greetings, confirmations).
 */
export function buildRecallQuery(input: RecallContextInput, minPromptLength: number): string | undefined {
	const user = input.userMessage.trim();
	if (user.length < minPromptLength) return undefined;
	const parts = [user];
	const tail = input.assistantTail?.trim().slice(-ASSISTANT_TAIL_CHARS);
	if (tail) parts.push(tail);
	const tools = [...new Set(input.toolNames ?? [])].slice(-MAX_TOOL_NAMES);
	if (tools.length) parts.push(`tools: ${tools.join(", ")}`);
	return parts.join("\n");
}

export function formatRecallMessage(facts: FactResult[]): string {
	const lines = facts.map((f) => `- ${f.fact}${f.invalid_at ? " (superseded)" : ""}`);
	return `Recalled from memory (verify against current state before relying on):\n${lines.join("\n")}`;
}

interface SessionEntryLike {
	type?: string;
	message?: {
		role?: string;
		content?: unknown;
		toolName?: string;
	};
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n");
}

/** Distills session entries into the state a recall query is built from. */
export function extractRecallContext(entries: SessionEntryLike[]): RecallContextInput {
	let userMessage = "";
	let assistantTail = "";
	const toolNames: string[] = [];
	for (const entry of entries) {
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message?.role === "user") {
			userMessage = textOf(message.content);
		} else if (message?.role === "assistant") {
			const text = textOf(message.content);
			if (text) assistantTail = text;
			if (Array.isArray(message.content)) {
				for (const part of message.content) {
					if (part?.type === "toolCall" && typeof part.name === "string") toolNames.push(part.name);
				}
			}
		} else if (message?.role === "toolResult" && typeof message.toolName === "string") {
			toolNames.push(message.toolName);
		}
	}
	return {
		userMessage,
		assistantTail: assistantTail.slice(-ASSISTANT_TAIL_CHARS),
		toolNames: [...new Set(toolNames)].slice(-MAX_TOOL_NAMES),
	};
}

export class RecallPipeline {
	private seen = new Set<string>();
	private cache = new Map<string, { expires: number; facts: FactResult[] }>();
	private inFlight = false;
	private pending: RecallContextInput | undefined;

	constructor(private readonly deps: RecallPipelineDeps) {}

	/** Drop per-session state (seen facts, cache, pending query). */
	reset(): void {
		this.seen.clear();
		this.cache.clear();
		this.pending = undefined;
	}

	/** Mark facts as surfaced so auto-recall never re-surfaces them. */
	markSeen(facts: FactResult[]): void {
		for (const fact of facts) this.seen.add(hashFact(fact.fact));
	}

	/**
	 * Fire-and-forget recall. At most one search runs at a time; a trigger
	 * while one is in flight replaces the pending query (latest wins), never
	 * queues a backlog. Returns a promise for tests; callers should void it.
	 */
	trigger(input: RecallContextInput): Promise<void> {
		if (this.inFlight) {
			this.pending = input;
			return Promise.resolve();
		}
		return this.run(input);
	}

	private async run(input: RecallContextInput): Promise<void> {
		this.inFlight = true;
		try {
			let current: RecallContextInput | undefined = input;
			while (current) {
				await this.recallOnce(current);
				current = this.pending;
				this.pending = undefined;
			}
		} finally {
			this.inFlight = false;
		}
	}

	private async recallOnce(input: RecallContextInput): Promise<void> {
		try {
			const config = await this.deps.config();
			if (config.autoRecallFacts <= 0) return;
			const query = buildRecallQuery(input, config.autoRecallMinPromptLength);
			if (!query) return;
			const now = (this.deps.now ?? Date.now)();
			const key = hashFact(query);
			let facts: FactResult[];
			const hit = this.cache.get(key);
			if (hit && hit.expires > now) {
				facts = hit.facts;
			} else {
				facts = await this.deps.searchFacts(query, config.autoRecallFacts);
				this.cache.set(key, { expires: now + config.recallCacheTtlMs, facts });
			}
			const fresh = facts.filter((fact) => !this.seen.has(hashFact(fact.fact)));
			if (!fresh.length) return;
			this.markSeen(fresh);
			this.deps.publish(fresh);
		} catch {
			// Recall is best-effort; a slow or failing graph must never surface.
		}
	}
}
