/**
 * Normalization and dedupe primitives (R-8.7).
 *
 * These decide whether two propositions are "the same fact", which is the single most consequential
 * judgement the memory system makes. Too loose and distinct facts collapse into one, losing
 * information silently. Too strict and the store fills with near-duplicates until recall returns eight
 * phrasings of one thing and nothing else.
 */
/** Hard cap from R-8.2. Enforced after redaction, because redaction can lengthen text. */
export const MAX_TEXT_LENGTH = 280;
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
export function normalize(text) {
    return text
        .normalize("NFKC")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^[\s"'`([{«]+/, "")
        .replace(/[\s"'`)\]}».,;:!?]+$/, "")
        .trim();
}
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
export function tokenJaccard(a, b) {
    const ta = tokenSet(a);
    const tb = tokenSet(b);
    if (ta.size === 0 && tb.size === 0)
        return 1;
    if (ta.size === 0 || tb.size === 0)
        return 0;
    let shared = 0;
    for (const t of ta)
        if (tb.has(t))
            shared++;
    return shared / (ta.size + tb.size - shared);
}
/**
 * Tokens for Jaccard.
 *
 * A bounded character class rather than a split on `\W+`: two production ReDoS bugs in this codebase
 * came from unbounded quantifiers on external input, and extracted text is model output, which is
 * external.
 */
function tokenSet(s) {
    const out = new Set();
    for (const m of normalize(s).matchAll(/[a-z0-9_./-]{1,64}/g)) {
        const t = m[0];
        // Single characters carry no signal and inflate the union, weakening every comparison.
        if (t.length > 1)
            out.add(t);
    }
    return out;
}
/** Cosine for L2-normalized vectors, which is a dot product. Mismatched lengths are a corrupt index. */
export function cosine(a, b) {
    if (a.length !== b.length) {
        throw new Error(`vector length mismatch: ${String(a.length)} vs ${String(b.length)} — the index was written by a different model`);
    }
    let acc = 0;
    for (let i = 0; i < a.length; i++)
        acc += a[i] * b[i];
    return acc;
}
/** Thresholds from R-8.7. Named so a change is visible in a diff rather than buried in a call. */
export const NEAR_DUP_COSINE = 0.92;
export const NEAR_DUP_JACCARD = 0.6;
/**
 * Whether two texts are the same fact, given their vectors.
 *
 * Both thresholds must pass. See `tokenJaccard` for why one is not enough.
 */
export function isNearDuplicate(aText, bText, aVec, bVec) {
    const c = cosine(aVec, bVec);
    const j = tokenJaccard(aText, bText);
    return { duplicate: c >= NEAR_DUP_COSINE && j >= NEAR_DUP_JACCARD, cosine: c, jaccard: j };
}
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
export const RRF_K = 60;
export function fuseRankings(rankings, k = RRF_K) {
    const scores = new Map();
    for (const ranking of rankings) {
        for (const [i, id] of ranking.entries()) {
            // 1-based rank: rank 0 would make the first result score 1/K and the second 1/(K+1), a much
            // bigger gap than between any later pair.
            const contribution = 1 / (k + i + 1);
            scores.set(id, (scores.get(id) ?? 0) + contribution);
        }
    }
    return scores;
}
//# sourceMappingURL=normalize.js.map