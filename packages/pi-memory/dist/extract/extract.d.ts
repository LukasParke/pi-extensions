import type { MemoryScope } from "../types.js";
/**
 * Extraction at turn boundaries (R-8.6).
 *
 * The model proposes; this file decides what survives. Every rule here exists because the alternative
 * pollutes the store, and a polluted store is worse than an empty one: recall returns noise, the user
 * stops trusting it, and the feature is dead.
 */
export declare const MAX_CANDIDATES_PER_TURN = 5;
export interface Candidate {
    text: string;
    scope: MemoryScope;
}
export interface ExtractionResult {
    candidates: Candidate[];
    /** Why items were dropped, for diagnosis. Never surfaced to a user; useful in a test failure. */
    rejected: {
        text: string;
        reason: string;
    }[];
}
/**
 * Parses the model's JSON array.
 *
 * Tolerant of the three things models actually do wrong — a markdown fence, prose before the array, a
 * trailing comma — because the alternative is discarding a whole turn's learning over a formatting
 * detail. Not tolerant of anything that changes MEANING.
 */
export declare function parseCandidates(raw: string): ExtractionResult;
/**
 * A compact digest of one turn, for the extraction prompt (R-8.6 step 1).
 *
 * Truncated hard, because the point is what was LEARNED and a 40-message transcript does not make that
 * clearer — it makes the model summarise instead of extract. The tool names are included because they say
 * what the turn was about ("read, edit, bash" is a code change) without their arguments, which are usually
 * paths and sometimes secrets.
 */
export declare function turnDigest(input: {
    userText: string;
    assistantText: string;
    toolNames: readonly string[];
    projectName?: string | null;
}): string;
//# sourceMappingURL=extract.d.ts.map