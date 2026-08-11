import type { Embedder } from "../types.js";
/**
 * The bundled sentence encoder (R-8.4).
 *
 * `all-MiniLM-L6-v2`, INT8 ONNX, 384 dimensions, Apache-2.0, ~23MB. Runs entirely locally: the model
 * file is on disk, the ONNX session is in-process, and the index is SQLite. A test with every socket
 * blocked still recalls (AC-8.3), which is the property that makes memory usable on a plane and the
 * reason a hosted embedding API was never an option.
 *
 * ## Why the tokenizer is written here
 *
 * WordPiece is ~80 lines and `tokenizer.json` supplies the vocabulary. The alternative,
 * `@xenova/transformers`, is a several-hundred-megabyte dependency that bundles its own ONNX runtime and
 * a model downloader — for a tokenizer this file implements in full. The encoder's contract is narrow
 * (text in, 384 floats out) and stable, so the usual argument for a library (it tracks a moving upstream)
 * does not apply.
 *
 * The risk is that a hand-written tokenizer disagrees with the reference implementation on unusual input,
 * which would silently degrade recall rather than fail. That is why `embed.test.ts` pins known token id
 * sequences against values taken from the reference tokenizer.
 *
 * ## Lazy, on a worker
 *
 * Loading is deferred to the first embed and the ONNX session is created with a single intra-op thread,
 * so the daemon's event loop stays responsive during load (AC-8.21, AC-8.22). Cold start budgets from
 * earlier phases must not regress just because a model exists (AC-8.32).
 */
export declare const EMBED_DIMENSIONS = 384;
export declare const MODEL_ID = "all-MiniLM-L6-v2-int8";
/** Where the weights live, relative to the built package. */
export declare function defaultModelDir(): string;
interface Vocab {
    vocab: Record<string, number>;
    unkId: number;
    clsId: number;
    sepId: number;
    padId: number;
    continuingPrefix: string;
    maxInputChars: number;
}
declare function loadVocab(dir: string): Vocab;
export interface TokenizedInput {
    ids: number[];
    attentionMask: number[];
    typeIds: number[];
}
/** Exported for the pinned tests: a tokenizer that drifts is a silent recall regression. */
export declare function tokenize(text: string, v: Vocab, maxLength?: number): TokenizedInput;
export type { Vocab };
export { loadVocab };
/**
 * The real embedder.
 *
 * Mean-pools the last hidden state over the attention mask, then L2-normalizes — which is what
 * sentence-transformers does for this model, and getting it wrong (CLS pooling, or no normalization)
 * produces vectors that work but rank badly.
 */
export declare class OnnxEmbedder implements Embedder {
    private readonly modelDir;
    readonly dimensions = 384;
    readonly modelId = "all-MiniLM-L6-v2-int8";
    private session;
    private vocabData;
    /** Single-flight: ten concurrent first-embeds must load the model once, not ten times. */
    private loading;
    constructor(modelDir?: string);
    /** Whether the weights are present, so `circle doctor` can report it without loading them. */
    available(): boolean;
    private load;
    embed(texts: readonly string[]): Promise<Float32Array[]>;
    close(): Promise<void>;
}
/**
 * Mean pooling over the attention mask, then L2 normalization.
 *
 * The mask matters even without padding: `[CLS]` and `[SEP]` are attended, and sentence-transformers
 * includes them, so excluding them here would produce vectors that disagree with every published
 * benchmark for this model.
 */
export declare function meanPoolAndNormalize(hidden: Float32Array, tokens: number, dims: number, mask: readonly number[]): Float32Array;
/**
 * A deterministic embedder for tests, and for a host where the model is absent.
 *
 * Hashed character trigrams into 384 dimensions. It is NOT semantic — "auth bug" and "login failure"
 * are unrelated to it — so it must never silently stand in for the real one in production. `modelId`
 * says so, and a vector written by it carries that id, so a mixed index is detectable rather than
 * mysterious.
 */
export declare class FallbackEmbedder implements Embedder {
    private readonly primary;
    private readonly fallback;
    readonly dimensions: number;
    get modelId(): string;
    private active;
    constructor(primary: Embedder, fallback: Embedder);
    embed(texts: readonly string[]): Promise<Float32Array<ArrayBufferLike>[]>;
    close(): Promise<void>;
}
export declare class HashEmbedder implements Embedder {
    readonly dimensions = 384;
    readonly modelId = "hash-trigram-v1-NOT-SEMANTIC";
    embed(texts: readonly string[]): Promise<Float32Array[]>;
    private one;
}
export type { Embedder };
//# sourceMappingURL=embed.d.ts.map