import { MAX_TEXT_LENGTH } from "../index/normalize.js";
/**
 * Extraction at turn boundaries (R-8.6).
 *
 * The model proposes; this file decides what survives. Every rule here exists because the alternative
 * pollutes the store, and a polluted store is worse than an empty one: recall returns noise, the user
 * stops trusting it, and the feature is dead.
 */
export const MAX_CANDIDATES_PER_TURN = 5;
/**
 * Parses the model's JSON array.
 *
 * Tolerant of the three things models actually do wrong — a markdown fence, prose before the array, a
 * trailing comma — because the alternative is discarding a whole turn's learning over a formatting
 * detail. Not tolerant of anything that changes MEANING.
 */
export function parseCandidates(raw) {
    const rejected = [];
    const json = extractJsonArray(raw);
    if (json === null)
        return { candidates: [], rejected: [{ text: raw.slice(0, 80), reason: "no JSON array found" }] };
    let parsed;
    try {
        parsed = JSON.parse(json);
    }
    catch {
        return { candidates: [], rejected: [{ text: json.slice(0, 80), reason: "not valid JSON" }] };
    }
    if (!Array.isArray(parsed)) {
        return { candidates: [], rejected: [{ text: json.slice(0, 80), reason: "not an array" }] };
    }
    const out = [];
    for (const item of parsed) {
        /**
         * The cap applies to what SURVIVES, not to what was proposed.
         *
         * A model returning eight candidates of which three are junk should still yield five — capping the
         * input would silently discard good facts because bad ones came first.
         */
        if (out.length >= MAX_CANDIDATES_PER_TURN) {
            rejected.push({ text: JSON.stringify(item).slice(0, 80), reason: "over the per-turn cap" });
            continue;
        }
        const verdict = validate(item);
        if (verdict.ok)
            out.push(verdict.candidate);
        else
            rejected.push({ text: preview(item), reason: verdict.reason });
    }
    return { candidates: out, rejected };
}
function validate(item) {
    if (item === null || typeof item !== "object")
        return { ok: false, reason: "not an object" };
    const o = item;
    if (typeof o.text !== "string")
        return { ok: false, reason: "text is not a string" };
    const text = o.text.trim();
    if (text === "")
        return { ok: false, reason: "empty text" };
    if (text.length > MAX_TEXT_LENGTH) {
        return { ok: false, reason: `${String(text.length)} chars, limit ${String(MAX_TEXT_LENGTH)}` };
    }
    if (o.scope !== "global" && o.scope !== "project") {
        return { ok: false, reason: "scope must be global or project" };
    }
    /**
     * Transient state is refused by pattern, and the list is deliberately short.
     *
     * "the build is running" is worthless tomorrow, and a store full of such lines makes recall useless.
     * But a long heuristic list would reject real facts — "the api is deprecated" contains "is" and is
     * perfectly durable — so this catches only the unambiguous cases and leaves the rest to the prompt.
     */
    if (/\b(?:i will|i'll|let me|next i|currently running|is running now)\b/i.test(text)) {
        return { ok: false, reason: "transient or first-person intent" };
    }
    /**
     * Chain-of-thought leakage: a candidate that is a sentence ABOUT the turn rather than a fact learned
     * from it. "The user asked me to…" is a description of the conversation, not knowledge.
     */
    if (/^(?:the user (?:asked|wants|said)|you asked|we discussed)\b/i.test(text)) {
        return { ok: false, reason: "describes the conversation rather than a fact" };
    }
    return { ok: true, candidate: { text, scope: o.scope } };
}
/**
 * Finds the JSON array in a model response.
 *
 * Bounded scanning rather than a regex with nested quantifiers: two production ReDoS bugs in this
 * codebase came from unbounded patterns on external input, and this input is model output.
 */
function extractJsonArray(raw) {
    const trimmed = raw.trim();
    if (trimmed === "")
        return null;
    // A fenced block, which the prompt forbids and models produce anyway.
    const fence = trimmed.indexOf("```");
    if (fence !== -1) {
        const afterFence = trimmed.slice(fence + 3).replace(/^json\s*/i, "");
        const close = afterFence.indexOf("```");
        return extractJsonArray(close === -1 ? afterFence : afterFence.slice(0, close));
    }
    const start = trimmed.indexOf("[");
    const end = trimmed.lastIndexOf("]");
    if (start === -1 || end === -1 || end < start)
        return null;
    return trimmed.slice(start, end + 1);
}
function preview(item) {
    const s = typeof item === "string" ? item : JSON.stringify(item);
    return (s ?? "").slice(0, 80);
}
/**
 * A compact digest of one turn, for the extraction prompt (R-8.6 step 1).
 *
 * Truncated hard, because the point is what was LEARNED and a 40-message transcript does not make that
 * clearer — it makes the model summarise instead of extract. The tool names are included because they say
 * what the turn was about ("read, edit, bash" is a code change) without their arguments, which are usually
 * paths and sometimes secrets.
 */
export function turnDigest(input) {
    const parts = [];
    if (input.projectName !== null && input.projectName !== undefined) {
        parts.push(`Project: ${input.projectName}`);
    }
    parts.push(`User asked: ${input.userText.slice(0, 1500)}`);
    if (input.toolNames.length > 0) {
        parts.push(`Tools used: ${[...new Set(input.toolNames)].slice(0, 10).join(", ")}`);
    }
    parts.push(`Assistant said: ${input.assistantText.slice(0, 3000)}`);
    return parts.join("\n\n");
}
//# sourceMappingURL=extract.js.map