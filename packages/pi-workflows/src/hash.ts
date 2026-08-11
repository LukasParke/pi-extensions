import { createHash } from "node:crypto";

/** Stable SHA-256 hex of a UTF-8 string. */
export function sha256(text: string) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Canonical JSON for hashing: sorted object keys, no undefined. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
	if (value === undefined) return null;
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(sortValue);
	const record = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(record).sort()) {
		const item = record[key];
		if (item !== undefined) out[key] = sortValue(item);
	}
	return out;
}

export function hashJson(value: unknown) {
	return sha256(canonicalJson(value));
}
