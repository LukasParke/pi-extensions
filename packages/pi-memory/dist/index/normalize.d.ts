/**
 * Normalization and dedupe primitives (R-8.7).
 *
 * These decide whether two propositions are "the same fact", which is the single most consequential
 * judgement the memory system makes. Too loose and distinct facts collapse into one, losing
 * information silently. Too strict and the store fills with near-duplicates until recall returns eight
 * phrasings of one thing and nothing else.
 */
/** Hard cap from R-8.2. Enforced after redaction, because redaction can lengthen text. */
export declare const MAX_TEXT_LENGTH = 280;
/**
 * The dedupe key.
 *
 * NFKC first, so `ﬁle` and `file` are the same fact — a ligature is a rendering difference, not a
 * semantic one. Then lowercase, then whitespace collapse, then strip wrapping punctuation so
 * `"Luke prefers tabs."` and `Luke prefers tabs` match.
 *
 * Deliberately NOT stemming or removing stop words. "the build runs on talos" and "builds run on
 * talos" are the same fact to a stemmer and different facts to a reader — and the near-dup path with a
 * real embedding is a better judge of that than a word-list heuristic.
 */
export declare function normalize(text: string): string;
/**
 * Token-set Jaccard, the second half of the near-dup test.
 *
 * Paired with cosine because they fail differently. Cosine is high for two sentences about the same
 * topic even when they assert opposite things — "the tests pass on talos" and "the tests fail on talos"
 * are close in embedding space. Jaccard catches that they share most tokens but not all, and requiring
 * BOTH thresholds means a near-dup has to be similar in meaning *and* in wording.
 *
 * It is not a distance in any strict sense; it is a cheap second opinion, which is its whole job.
 */
export declare function tokenJaccard(a: string, b: string): number;
/** Cosine for L2-normalized vectors, which is a dot product. Mismatched lengths are a corrupt index. */
export declare function cosine(a: Float32Array, b: Float32Array): number;
/** Thresholds from R-8.7. Named so a change is visible in a diff rather than buried in a call. */
export declare const NEAR_DUP_COSINE = 0.92;
export declare const NEAR_DUP_JACCARD = 0.6;
/**
 * Whether two texts are the same fact, given their vectors.
 *
 * Both thresholds must pass. See `tokenJaccard` for why one is not enough.
 */
export declare function isNearDuplicate(aText: string, bText: string, aVec: Float32Array, bVec: Float32Array): {
    duplicate: boolean;
    cosine: number;
    jaccard: number;
};
/**
 * Reciprocal-rank fusion (R-8.5, AC-8.5).
 *
 * `score(e) = Σ 1/(K + rank)` over the rankings an entry appears in, with `K = 60`.
 *
 * RRF rather than score normalization because the two legs are incommensurable: a cosine of 0.7 and a
 * BM25 of 12.4 have no common scale, and any attempt to map them onto one is a tuning parameter that
 * silently favours one leg. Ranks are comparable by construction.
 *
 * A missing entry contributes NOTHING — not `1/(K+∞)`. That matters: adding a vanishing term would make
 * an entry found by one leg score lower than the same entry found by one leg in a query where the other
 * leg returned fewer results, which is incoherent.
 */
export declare const RRF_K = 60;
export declare function fuseRankings(rankings: readonly string[][], k?: number): Map<string, number>;
//# sourceMappingURL=normalize.d.ts.map