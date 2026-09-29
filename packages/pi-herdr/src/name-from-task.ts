import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";

const NAME_SYSTEM = `Reply with only a 2-4 word lowercase kebab-case SUBJECT name for a git worktree.
Name the subject, not the action. Target 8-24 characters, never more than 32.
Examples: clickable-file-paths, herdr-context-gate, agent-name-limit
No quotes, no backticks, no punctuation, no explanation.`;

export type NameContext = Partial<Pick<ExtensionContext, "model" | "signal">> & {
	modelRegistry?: Pick<ExtensionContext["modelRegistry"], "streamSimple">;
};

export interface GenerateNameOptions {
	timeoutMs?: number;
	now?: () => number;
	signal?: AbortSignal;
	onUsage?: (usage: Usage) => void;
}

export function generateNameIfOmitted(
	name: string | undefined,
	ctx: NameContext,
	options: GenerateNameOptions = {},
) {
	return name === undefined ? (task: string) => generateNameFromContext(task, ctx, options) : undefined;
}

export async function generateNameFromContext(
	task: string,
	ctx: NameContext,
	options: GenerateNameOptions = {},
) {
	if (!ctx.model || !ctx.modelRegistry) return undefined;
	const signals = [AbortSignal.timeout(options.timeoutMs ?? 8_000)];
	if (ctx.signal) signals.push(ctx.signal);
	if (options.signal) signals.push(options.signal);
	const signal = AbortSignal.any(signals);
	if (signal.aborted) return undefined;
	try {
		const response = await ctx.modelRegistry
			.streamSimple(
				ctx.model,
				{
					systemPrompt: NAME_SYSTEM,
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: task.slice(0, 2_000) }],
							timestamp: (options.now ?? Date.now)(),
						},
					],
				},
				{ maxTokens: 24, reasoning: "minimal", signal },
			)
			.result();
		options.onUsage?.(response.usage);
		if (response.stopReason === "aborted" || response.stopReason === "error") return undefined;
		const text = response.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		return text.trim() || undefined;
	} catch {
		return undefined;
	}
}
