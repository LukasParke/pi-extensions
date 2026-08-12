/**
 * Model-backed subject names for omitted herdr_task labels.
 * Dispatch never imports this — only the extension resolves a name, then
 * hands the already-normalized identifier to dispatch.
 */

import { complete } from "@earendil-works/pi-ai/compat";

const NAME_SYSTEM = `Reply with only a 2-4 word lowercase kebab-case SUBJECT name for a git worktree.
Name the subject, not the action. Target 8-24 characters, never more than 32.
Examples: clickable-file-paths, herdr-context-gate, agent-name-limit
No quotes, no backticks, no punctuation, no explanation.`;

export type NameAuth = {
	ok: boolean;
	error?: string;
	apiKey?: string;
	headers?: Record<string, string | null>;
	env?: Record<string, string>;
};

export type NameContext = {
	model?: unknown;
	modelRegistry?: {
		getApiKeyAndHeaders(model: any): Promise<NameAuth>;
	};
};

export type CompleteFn = (
	model: unknown,
	context: {
		systemPrompt: string;
		messages: Array<{ role: "user"; content: Array<{ type: "text"; text: string }>; timestamp: number }>;
	},
	options: Record<string, unknown>,
) => Promise<{ content?: Array<{ type: string; text?: string }>; stopReason?: string }>;

export interface GenerateNameOptions {
	complete?: CompleteFn;
	timeoutMs?: number;
	now?: () => number;
}

/** Shared by herdr_task and /herdr-task. Explicit names skip generation. */
export function generateNameIfOmitted(name: string | undefined, ctx: NameContext) {
	return name === undefined ? (task: string) => generateNameFromContext(task, ctx) : undefined;
}

export async function generateNameFromContext(
	task: string,
	ctx: NameContext,
	options: GenerateNameOptions = {},
): Promise<string | undefined> {
	if (!ctx.model || !ctx.modelRegistry) return undefined;

	const timeoutMs = options.timeoutMs ?? 8_000;
	const run = options.complete ?? (complete as CompleteFn);
	const now = options.now ?? Date.now;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok) return undefined;
		const response = await run(
			ctx.model,
			{
				systemPrompt: NAME_SYSTEM,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: task.slice(0, 2_000) }],
						timestamp: now(),
					},
				],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				maxTokens: 24,
				reasoning: "minimal",
				reasoningEffort: "minimal",
				signal: controller.signal,
			},
		);
		if (response.stopReason === "aborted") return undefined;
		const text = (response.content ?? [])
			.filter((part) => part.type === "text" && part.text)
			.map((part) => part.text)
			.join("\n");
		return text.trim() || undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}
