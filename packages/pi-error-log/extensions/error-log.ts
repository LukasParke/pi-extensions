/**
 * Captures every tool error in the session into one JSONL log and exposes an
 * `error_log` tool to review it.
 *
 * `tool_execution_end` carries the result but not the args, so args are
 * stashed from `tool_execution_start` keyed by toolCallId. There is no
 * `extension_error` event in the pi extension API (extension errors are only
 * surfaced through the internal ExtensionRunner.onError listener), so only
 * tool errors are captured here.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { errorLogConfig, logPath } from "../src/config.ts";
import { appendError, type ErrorLogEntry, filterErrors, readErrors } from "../src/log.ts";
import { serializeArgs } from "../src/redact.ts";

const MAX_PENDING_ARGS = 1_000;
const MAX_ERROR_MESSAGE = 2_000;

function extractError(result: unknown): { message: string; stack?: string } {
	if (result instanceof Error) {
		return { message: result.message, ...(result.stack ? { stack: result.stack } : {}) };
	}
	if (typeof result === "string") return { message: result.slice(0, MAX_ERROR_MESSAGE) };
	if (result && typeof result === "object") {
		const content = (result as { content?: unknown }).content;
		if (Array.isArray(content)) {
			const text = content
				.filter(
					(block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text",
				)
				.map((block) => String((block as { text?: unknown }).text ?? ""))
				.join("\n")
				.trim();
			if (text) return { message: text.slice(0, MAX_ERROR_MESSAGE) };
		}
	}
	try {
		return { message: JSON.stringify(result)?.slice(0, MAX_ERROR_MESSAGE) ?? "unknown error" };
	} catch {
		return { message: "unknown error" };
	}
}

function sessionFile(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionFile() ?? undefined;
	} catch {
		return undefined;
	}
}

function modelRef(ctx: ExtensionContext): { provider: string; id: string } | undefined {
	try {
		const model = ctx.model;
		return model ? { provider: model.provider, id: model.id } : undefined;
	} catch {
		return undefined;
	}
}

export default function errorLog(pi: ExtensionAPI) {
	// Args for in-flight tool calls, keyed by toolCallId.
	const pendingArgs = new Map<string, unknown>();

	pi.on("tool_execution_start", (event) => {
		try {
			if (pendingArgs.size >= MAX_PENDING_ARGS) pendingArgs.clear();
			pendingArgs.set(event.toolCallId, event.args);
		} catch {
			// never break tool execution
		}
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		const args = pendingArgs.get(event.toolCallId);
		pendingArgs.delete(event.toolCallId);
		if (!event.isError) return;
		try {
			const config = await errorLogConfig();
			if (!config.enabled) return;
			const entry: ErrorLogEntry = {
				ts: new Date().toISOString(),
				...(sessionFile(ctx) ? { session: sessionFile(ctx) } : {}),
				cwd: ctx.cwd,
				kind: "tool",
				tool: event.toolName,
				toolCallId: event.toolCallId,
				...(args !== undefined ? { args: serializeArgs(args) } : {}),
				error: extractError(event.result),
				...(modelRef(ctx) ? { model: modelRef(ctx) } : {}),
			};
			await appendError(logPath(config), config.maxBytes, entry);
		} catch {
			// never break tool execution
		}
	});

	pi.registerTool({
		name: "error_log",
		label: "Error Log",
		description:
			"Read tool errors captured this session (and previous sessions) from the central error log. Use to review what failed recently, filter by tool or time window, and inspect full error details.",
		promptSnippet: "Review captured tool errors from the central error log",
		promptGuidelines: [
			"Use error_log when the user asks what went wrong, what failed recently, or to review tool errors.",
		],
		parameters: Type.Object({
			tool: Type.Optional(Type.String({ description: "Only errors from this tool name." })),
			kind: Type.Optional(
				Type.Unsafe<"tool" | "extension">({
					type: "string",
					enum: ["tool", "extension"],
					description: "Entry kind filter.",
				}),
			),
			since: Type.Optional(Type.String({ description: 'ISO timestamp or duration like "30m", "2h", "1d".' })),
			limit: Type.Optional(Type.Number({ description: "Max entries, newest first. Defaults to 20." })),
		}),
		async execute(_toolCallId, params) {
			const config = await errorLogConfig();
			if (!config.enabled) {
				return {
					content: [{ type: "text", text: "Error log is disabled (error-log.enabled = false)." }],
					details: { path: undefined as string | undefined, entries: [] as ErrorLogEntry[] },
				};
			}
			const file = logPath(config);
			const entries = filterErrors(await readErrors(file), {
				tool: params.tool,
				kind: params.kind,
				since: params.since,
				limit: params.limit,
			});
			if (entries.length === 0) {
				return {
					content: [{ type: "text", text: `No matching errors in ${file}.` }],
					details: { path: file, entries: [] },
				};
			}
			const lines = entries.map((entry) => {
				const argsPreview = entry.args
					? entry.args.length > 120
						? `${entry.args.slice(0, 120)}...`
						: entry.args
					: "";
				const messagePreview = entry.error.message.split("\n")[0]!.slice(0, 160);
				return `[${entry.ts}] ${entry.kind}${entry.tool ? ` ${entry.tool}` : ""}: ${messagePreview}${argsPreview ? `\n  args: ${argsPreview}` : ""}`;
			});
			return {
				content: [{ type: "text", text: `${entries.length} error(s) from ${file}:\n\n${lines.join("\n")}` }],
				details: { path: file, entries },
			};
		},
	});
}
