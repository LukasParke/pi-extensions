import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

export const EMBED_DIMENSIONS = 384;
export const MODEL_ID = "all-MiniLM-L6-v2-int8";

/** Where the weights live, relative to the built package. */
export function defaultModelDir(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	// `dist/index/` → package root.
	return join(here, "..", "..", "models");
}

interface Vocab {
	vocab: Record<string, number>;
	unkId: number;
	clsId: number;
	sepId: number;
	padId: number;
	continuingPrefix: string;
	maxInputChars: number;
}

function loadVocab(dir: string): Vocab {
	const raw = JSON.parse(readFileSync(join(dir, "tokenizer.json"), "utf8")) as {
		model: {
			vocab: Record<string, number>;
			unk_token: string;
			continuing_subword_prefix: string;
			max_input_chars_per_word?: number;
		};
	};
	const vocab = raw.model.vocab;
	const id = (t: string): number => {
		const v = vocab[t];
		if (v === undefined) throw new Error(`tokenizer.json is missing the ${t} token`);
		return v;
	};
	return {
		vocab,
		unkId: id(raw.model.unk_token),
		clsId: id("[CLS]"),
		sepId: id("[SEP]"),
		padId: id("[PAD]"),
		continuingPrefix: raw.model.continuing_subword_prefix,
		maxInputChars: raw.model.max_input_chars_per_word ?? 100,
	};
}

/**
 * BertNormalizer plus whitespace/punctuation pre-tokenization.
 *
 * Matches the reference config: lowercase, strip accents, and split on punctuation so `packages/core`
 * becomes `packages`, `/`, `core`. Getting this wrong shifts every token id and produces embeddings that
 * are subtly wrong rather than obviously broken — which is the failure mode the pinned tests exist for.
 */
function preTokenize(text: string): string[] {
	const normalized = text
		.normalize("NFD")
		// Strip combining marks: `café` → `cafe`, which is what `strip_accents` does.
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();

	const words: string[] = [];
	let current = "";
	for (const ch of normalized) {
		if (/\s/.test(ch)) {
			if (current !== "") words.push(current);
			current = "";
		} else if (/[!-/:-@[-`{-~]/.test(ch)) {
			// Punctuation is its own token, as BERT does.
			if (current !== "") words.push(current);
			words.push(ch);
			current = "";
		} else {
			current += ch;
		}
	}
	if (current !== "") words.push(current);
	return words;
}

/** Greedy longest-match-first WordPiece. */
function wordPiece(word: string, v: Vocab): number[] {
	if (word.length > v.maxInputChars) return [v.unkId];

	const out: number[] = [];
	let start = 0;
	while (start < word.length) {
		let end = word.length;
		let found: number | null = null;
		while (start < end) {
			const piece = start === 0 ? word.slice(start, end) : `${v.continuingPrefix}${word.slice(start, end)}`;
			const id = v.vocab[piece];
			if (id !== undefined) {
				found = id;
				break;
			}
			end -= 1;
		}
		if (found === null) {
			// A word with no representable prefix is UNK in its entirety, not partially.
			return [v.unkId];
		}
		out.push(found);
		start = end;
	}
	return out;
}

export interface TokenizedInput {
	ids: number[];
	attentionMask: number[];
	typeIds: number[];
}

/** Exported for the pinned tests: a tokenizer that drifts is a silent recall regression. */
export function tokenize(text: string, v: Vocab, maxLength = 256): TokenizedInput {
	const pieces: number[] = [v.clsId];
	for (const word of preTokenize(text)) {
		for (const id of wordPiece(word, v)) {
			// Room for the trailing [SEP].
			if (pieces.length >= maxLength - 1) break;
			pieces.push(id);
		}
		if (pieces.length >= maxLength - 1) break;
	}
	pieces.push(v.sepId);

	return {
		ids: pieces,
		attentionMask: pieces.map(() => 1),
		typeIds: pieces.map(() => 0),
	};
}

export type { Vocab };
export { loadVocab };

/**
 * The real embedder.
 *
 * Mean-pools the last hidden state over the attention mask, then L2-normalizes — which is what
 * sentence-transformers does for this model, and getting it wrong (CLS pooling, or no normalization)
 * produces vectors that work but rank badly.
 */
export class OnnxEmbedder implements Embedder {
	readonly dimensions = EMBED_DIMENSIONS;
	readonly modelId = MODEL_ID;

	private session: unknown = null;
	private vocabData: Vocab | null = null;
	/** Single-flight: ten concurrent first-embeds must load the model once, not ten times. */
	private loading: Promise<void> | null = null;

	constructor(private readonly modelDir: string = defaultModelDir()) {}

	/** Whether the weights are present, so `circle doctor` can report it without loading them. */
	available(): boolean {
		return (
			existsSync(join(this.modelDir, "model_quantized.onnx")) &&
			existsSync(join(this.modelDir, "tokenizer.json"))
		);
	}

	private async load(): Promise<void> {
		if (this.session !== null) return;
		if (this.loading !== null) return await this.loading;

		this.loading = (async () => {
			const ort = (await import("onnxruntime-node")) as {
				InferenceSession: { create(path: string, opts?: unknown): Promise<unknown> };
			};
			this.vocabData = loadVocab(this.modelDir);
			this.session = await ort.InferenceSession.create(join(this.modelDir, "model_quantized.onnx"), {
				/**
				 * One thread, and `sequential` execution.
				 *
				 * The daemon serves RPC on the same event loop, so a model that spawned four compute threads
				 * during load would make the health ping miss its 50ms budget (AC-8.22). Embedding one short
				 * proposition is microseconds of work; parallelism buys nothing and costs responsiveness.
				 */
				intraOpNumThreads: 1,
				interOpNumThreads: 1,
				executionMode: "sequential",
				graphOptimizationLevel: "all",
			});
		})();

		try {
			await this.loading;
		} finally {
			this.loading = null;
		}
	}

	async embed(texts: readonly string[]): Promise<Float32Array[]> {
		if (texts.length === 0) return [];
		await this.load();

		const ort = (await import("onnxruntime-node")) as {
			Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
		};
		const v = this.vocabData;
		const session = this.session as {
			run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: number[] }>>;
		};
		if (v === null) throw new Error("the tokenizer failed to load");

		const out: Float32Array[] = [];

		/**
		 * One text per run, rather than a padded batch.
		 *
		 * A batch needs padding to the longest member, and the padded positions then have to be masked out
		 * of the mean — one more place to be subtly wrong. Extraction produces at most five short candidates
		 * per turn and recall embeds one query, so the batching win is not worth the risk.
		 */
		for (const text of texts) {
			const t = tokenize(text, v);
			const len = t.ids.length;

			const feeds: Record<string, unknown> = {
				input_ids: new ort.Tensor("int64", BigInt64Array.from(t.ids.map(BigInt)), [1, len]),
				attention_mask: new ort.Tensor("int64", BigInt64Array.from(t.attentionMask.map(BigInt)), [1, len]),
				token_type_ids: new ort.Tensor("int64", BigInt64Array.from(t.typeIds.map(BigInt)), [1, len]),
			};

			const result = await session.run(feeds);
			const hidden = result.last_hidden_state ?? Object.values(result)[0];
			if (hidden === undefined) throw new Error("the model returned no output");

			out.push(meanPoolAndNormalize(hidden.data, len, this.dimensions, t.attentionMask));
		}
		return out;
	}

	async close(): Promise<void> {
		const s = this.session as { release?: () => Promise<void> } | null;
		await s?.release?.();
		this.session = null;
	}
}

/**
 * Mean pooling over the attention mask, then L2 normalization.
 *
 * The mask matters even without padding: `[CLS]` and `[SEP]` are attended, and sentence-transformers
 * includes them, so excluding them here would produce vectors that disagree with every published
 * benchmark for this model.
 */
export function meanPoolAndNormalize(
	hidden: Float32Array,
	tokens: number,
	dims: number,
	mask: readonly number[],
): Float32Array {
	const pooled = new Float32Array(dims);
	let counted = 0;

	for (let t = 0; t < tokens; t++) {
		if (mask[t] !== 1) continue;
		counted++;
		const off = t * dims;
		for (let d = 0; d < dims; d++) pooled[d] = (pooled[d] as number) + (hidden[off + d] as number);
	}
	// A zero-token input cannot happen (CLS and SEP are always present) but dividing by it would produce
	// NaNs that poison every later comparison, so the guard is cheap insurance.
	const divisor = counted === 0 ? 1 : counted;
	for (let d = 0; d < dims; d++) pooled[d] = (pooled[d] as number) / divisor;

	let norm = 0;
	for (let d = 0; d < dims; d++) norm += (pooled[d] as number) ** 2;
	norm = Math.sqrt(norm);
	if (norm > 0) {
		for (let d = 0; d < dims; d++) pooled[d] = (pooled[d] as number) / norm;
	}
	return pooled;
}

/**
 * A deterministic embedder for tests, and for a host where the model is absent.
 *
 * Hashed character trigrams into 384 dimensions. It is NOT semantic — "auth bug" and "login failure"
 * are unrelated to it — so it must never silently stand in for the real one in production. `modelId`
 * says so, and a vector written by it carries that id, so a mixed index is detectable rather than
 * mysterious.
 */
export class FallbackEmbedder implements Embedder {
	readonly dimensions: number;
	get modelId() {
		return this.active.modelId;
	}
	private active: Embedder;

	constructor(
		private readonly primary: Embedder,
		private readonly fallback: Embedder,
	) {
		this.active = primary;
		this.dimensions = primary.dimensions;
		if (primary.dimensions !== fallback.dimensions) {
			throw new Error("primary and fallback embedders must use the same dimensions");
		}
	}

	async embed(texts: readonly string[]) {
		try {
			return await this.active.embed(texts);
		} catch (error) {
			if (this.active === this.fallback) throw error;
			await this.primary.close?.().catch(() => undefined);
			this.active = this.fallback;
			return await this.active.embed(texts);
		}
	}

	async close() {
		await this.primary.close?.();
		if (this.fallback !== this.primary) await this.fallback.close?.();
	}
}

export class HashEmbedder implements Embedder {
	readonly dimensions = EMBED_DIMENSIONS;
	readonly modelId = "hash-trigram-v1-NOT-SEMANTIC";

	async embed(texts: readonly string[]): Promise<Float32Array[]> {
		return texts.map((t) => this.one(t));
	}

	private one(text: string): Float32Array {
		const v = new Float32Array(this.dimensions);
		const s = ` ${text.toLowerCase().replace(/\s+/g, " ").trim()} `;
		for (let i = 0; i + 3 <= s.length; i++) {
			const gram = s.slice(i, i + 3);
			let h = 2166136261;
			for (let k = 0; k < gram.length; k++) {
				h ^= gram.charCodeAt(k);
				h = Math.imul(h, 16777619);
			}
			const idx = Math.abs(h) % this.dimensions;
			v[idx] = (v[idx] as number) + 1;
		}
		let norm = 0;
		for (let d = 0; d < this.dimensions; d++) norm += (v[d] as number) ** 2;
		norm = Math.sqrt(norm);
		if (norm > 0) for (let d = 0; d < this.dimensions; d++) v[d] = (v[d] as number) / norm;
		return v;
	}
}

export type { Embedder };
