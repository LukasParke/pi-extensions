/**
 * Tool argument normalization.
 *
 * Accept structured `args` objects while preserving legacy JSON-string input
 * through prepareArguments (so resumed sessions with old schemas still work).
 */

export interface WorkflowToolParams {
	script?: string;
	description?: string;
	args?: unknown;
	name?: string;
	action?: string;
	id?: string;
	async?: boolean;
	timeout_ms?: number;
}

/**
 * Normalize raw model arguments before schema validation.
 * - Legacy `args` JSON strings are parsed into objects/values.
 * - Already-structured args pass through.
 * - Invalid JSON strings are left as-is so schema/execute can surface a clear error.
 */
export function prepareWorkflowArguments(raw: unknown): WorkflowToolParams {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const input = raw as Record<string, unknown>;
	const out: WorkflowToolParams = { ...input };

	if (typeof input.args === "string") {
		const trimmed = input.args.trim();
		if (trimmed) {
			try {
				out.args = JSON.parse(trimmed);
			} catch {
				// Keep the string; execute will report a parse error with context.
				out.args = input.args;
			}
		} else {
			out.args = undefined;
		}
	}

	return out;
}

/** Parse args for execute after schema validation. */
export function coerceArgs(value: unknown): { ok: true; args?: unknown } | { ok: false; error: string } {
	if (value === undefined) return { ok: true, args: undefined };
	if (typeof value === "string") {
		try {
			return { ok: true, args: JSON.parse(value) };
		} catch (error) {
			return {
				ok: false,
				error: `args must be JSON-serializable (legacy string failed to parse): ${
					error instanceof Error ? error.message : String(error)
				}`,
			};
		}
	}
	return { ok: true, args: value };
}
