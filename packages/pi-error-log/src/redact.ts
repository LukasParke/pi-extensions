/**
 * Safe args serialization for the error log.
 *
 * Tool args can contain credentials (API keys in headers, tokens in URLs) and
 * can be arbitrarily large or circular. Everything here is best-effort: the
 * worst case is a redacted or truncated entry, never a thrown error.
 */

const SENSITIVE_KEY = /token|secret|key|password|passwd|credential|authorization|cookie|bearer/i;
/** Long base64/hex runs and `Bearer ...` values look like secrets even under innocent keys. */
const SECRET_VALUE = /^(?:Bearer\s+\S+|[A-Za-z0-9+/=_-]{40,})$/;

export const REDACTED = "[redacted]";
export const TRUNCATED = "...[truncated]";
export const MAX_ARGS_BYTES = 4096;

function looksSecret(value: string): boolean {
	return SECRET_VALUE.test(value.trim());
}

function walk(value: unknown, seen: Set<object>, depth: number): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value === "string") return looksSecret(value) ? REDACTED : value;
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "bigint") return value.toString();
	if (typeof value !== "object") return String(value);
	if (seen.has(value)) return "[circular]";
	if (depth > 16) return "[max-depth]";
	seen.add(value);
	try {
		if (Array.isArray(value)) return value.map((item) => walk(item, seen, depth + 1));
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			out[key] = SENSITIVE_KEY.test(key) ? REDACTED : walk(item, seen, depth + 1);
		}
		return out;
	} finally {
		seen.delete(value);
	}
}

/** Deep-redact secrets from tool args. Never throws. */
export function sanitizeArgs(args: unknown): unknown {
	try {
		return walk(args, new Set(), 0);
	} catch {
		return "[unserializable]";
	}
}

/**
 * Sanitize and serialize args to a JSON string capped at `maxBytes`. The cap
 * applies to the serialized form; a truncated result ends with a marker and
 * is intentionally not valid JSON.
 */
export function serializeArgs(args: unknown, maxBytes = MAX_ARGS_BYTES): string {
	try {
		const json = JSON.stringify(sanitizeArgs(args)) ?? "null";
		if (json.length <= maxBytes) return json;
		return `${json.slice(0, Math.max(0, maxBytes - TRUNCATED.length))}${TRUNCATED}`;
	} catch {
		return "[unserializable]";
	}
}
