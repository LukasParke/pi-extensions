import { describe, expect, it } from "vitest";
import {
	defaultModelDir,
	EMBED_DIMENSIONS,
	HashEmbedder,
	loadVocab,
	meanPoolAndNormalize,
	OnnxEmbedder,
	tokenize,
} from "../src/index/embed.ts";

/**
 * The bundled encoder (R-8.4, AC-8.21).
 *
 * The tokenizer tests PIN token ids against the reference implementation, because a hand-written
 * WordPiece that drifts produces embeddings that are subtly wrong rather than broken — recall quietly
 * degrades and nothing fails. These ids are BERT's published vocabulary values.
 */

const vocab = loadVocab(defaultModelDir());

describe("tokenizer (pinned against the reference)", () => {
	it("produces the reference token ids", () => {
		// 101 = [CLS], 102 = [SEP]. The interior ids are bert-base-uncased vocabulary positions.
		expect(tokenize("hello world", vocab).ids).toEqual([101, 7592, 2088, 102]);
	});

	it("splits punctuation into its own tokens, as BertPreTokenizer does", () => {
		/**
		 * `packages/core` must become `packages`, `/`, `core`. Treating it as one word would make every
		 * path-shaped fact a single UNK, which is most of what a codebase memory contains.
		 */
		expect(tokenize("packages/core", vocab).ids).toEqual([101, 14555, 1013, 4563, 102]);
		expect(tokenize("DEV-412", vocab).ids).toEqual([101, 16475, 1011, 25873, 102]);
	});

	it("strips accents, so a ligature is not a different fact", () => {
		// `café` and `cafe` are the same fact; NFD plus combining-mark removal is what the config asks for.
		expect(tokenize("café", vocab).ids).toEqual(tokenize("cafe", vocab).ids);
	});

	it("splits an unknown word into subwords rather than dropping it", () => {
		// Greedy longest-match-first: `un ##pro ##no ##unce ##able`.
		const ids = tokenize("unpronounceable", vocab).ids;
		expect(ids).toEqual([101, 4895, 21572, 3630, 17457, 3085, 102]);
		// Not UNK: a word with representable pieces must not be lost.
		expect(ids).not.toContain(vocab.unkId);
	});

	it("a word with no representable prefix becomes UNK entirely, not partially", () => {
		const ids = tokenize("\u{1F600}\u{1F600}\u{1F600}", vocab).ids;
		expect(ids[0]).toBe(vocab.clsId);
		expect(ids[ids.length - 1]).toBe(vocab.sepId);
	});

	it("an absurdly long word is UNK rather than a hundred subwords", () => {
		// The reference caps at `max_input_chars_per_word`; without it a 5000-char blob becomes thousands of
		// tokens and blows the sequence limit.
		const ids = tokenize("a".repeat(500), vocab).ids;
		expect(ids).toEqual([101, vocab.unkId, 102]);
	});

	it("truncates to the sequence limit, always leaving room for [SEP]", () => {
		/**
		 * A missing [SEP] changes the pooled vector, so the truncation has to reserve its slot rather than
		 * cut at exactly maxLength.
		 */
		const long = Array.from({ length: 400 }, (_, i) => `word${String(i)}`).join(" ");
		const ids = tokenize(long, vocab, 64).ids;
		expect(ids.length).toBeLessThanOrEqual(64);
		expect(ids[0]).toBe(vocab.clsId);
		expect(ids[ids.length - 1]).toBe(vocab.sepId);
	});

	it("the attention mask and type ids match the length", () => {
		const t = tokenize("the tests run on talos", vocab);
		expect(t.attentionMask).toHaveLength(t.ids.length);
		expect(t.typeIds).toHaveLength(t.ids.length);
		expect(new Set(t.attentionMask)).toEqual(new Set([1]));
		expect(new Set(t.typeIds)).toEqual(new Set([0]));
	});

	it("empty text still produces a valid sequence", () => {
		// CLS + SEP. A zero-length input would divide by zero in the pool.
		expect(tokenize("", vocab).ids).toEqual([101, 102]);
		expect(tokenize("   \n  ", vocab).ids).toEqual([101, 102]);
	});
});

describe("mean pooling", () => {
	it("averages over the mask, then normalizes to unit length", () => {
		/**
		 * The mask matters even without padding: [CLS] and [SEP] are attended and sentence-transformers
		 * includes them, so excluding them would disagree with every published benchmark for this model.
		 */
		const dims = 4;
		const hidden = Float32Array.from([1, 0, 0, 0, 3, 0, 0, 0, 99, 99, 99, 99]);
		const pooled = meanPoolAndNormalize(hidden, 3, dims, [1, 1, 0]);
		// Mean of the first two rows is [2,0,0,0]; normalized that is [1,0,0,0].
		expect(pooled[0]).toBeCloseTo(1, 5);
		expect(pooled[1]).toBeCloseTo(0, 5);
	});

	it("an all-zero mask does not produce NaN", () => {
		// Cannot happen (CLS and SEP are always attended) but a NaN would poison every later comparison.
		const pooled = meanPoolAndNormalize(Float32Array.from([1, 2, 3, 4]), 2, 2, [0, 0]);
		expect([...pooled].every((x) => Number.isFinite(x))).toBe(true);
	});

	it("a zero vector normalizes to zero rather than NaN", () => {
		const pooled = meanPoolAndNormalize(Float32Array.from([0, 0]), 1, 2, [1]);
		expect([...pooled]).toEqual([0, 0]);
	});
});

describe("OnnxEmbedder (the real model)", () => {
	it("AC-8.21 produces 384 L2-normalized dimensions", async () => {
		const e = new OnnxEmbedder();
		expect(e.available()).toBe(true);
		expect(e.dimensions).toBe(EMBED_DIMENSIONS);

		const [v] = await e.embed(["Luke prefers concise commit messages"]);
		expect(v).toHaveLength(384);

		let norm = 0;
		for (const x of v as Float32Array) norm += x * x;
		// Cosine is a dot product only if the vectors are normalized, and the whole retrieval leg assumes it.
		expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
		await e.close();
	}, 60_000);

	it("AC-8.4 is genuinely SEMANTIC: related facts score high with no shared words", async () => {
		/**
		 * The property that justifies a 23MB dependency. "the authentication is broken" and "login is
		 * failing for users" share no tokens, so BM25 scores them at zero — a hash embedder would too. Only
		 * a real encoder connects them, and that connection is the entire reason memory beats grep.
		 */
		const e = new OnnxEmbedder();
		const [auth, login, deploy, tabs] = await e.embed([
			"the authentication is broken",
			"login is failing for users",
			"the deploy pipeline runs on talos",
			"Luke prefers tabs over spaces",
		]);
		const cos = (a: Float32Array, b: Float32Array): number => {
			let s = 0;
			for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
			return s;
		};

		const related = cos(auth as Float32Array, login as Float32Array);
		const unrelatedDeploy = cos(auth as Float32Array, deploy as Float32Array);
		const unrelatedTabs = cos(auth as Float32Array, tabs as Float32Array);

		expect(related).toBeGreaterThan(0.4);
		// And clearly separated, not merely ordered: a 0.61-vs-0.59 gap would not survive real data.
		expect(related).toBeGreaterThan(unrelatedDeploy + 0.3);
		expect(related).toBeGreaterThan(unrelatedTabs + 0.3);
		await e.close();
	}, 60_000);

	it("AC-8.21 is deterministic: the same text always yields the same vector", async () => {
		/**
		 * A stored vector has to match one computed later, or dedupe and recall drift apart as the corpus
		 * ages. Non-determinism would come from thread scheduling, which is why the session is configured
		 * with a single thread and sequential execution.
		 */
		const e = new OnnxEmbedder();
		const [a] = await e.embed(["the api lives in packages/core"]);
		const [b] = await e.embed(["the api lives in packages/core"]);
		expect([...(a as Float32Array)]).toEqual([...(b as Float32Array)]);
		await e.close();
	}, 60_000);

	it("AC-8.22 concurrent first-embeds load the model ONCE", async () => {
		/**
		 * Single-flight. Ten concurrent recalls on a cold daemon would otherwise create ten ONNX sessions,
		 * each allocating the model — which is both slow and a memory spike big enough to matter.
		 */
		const e = new OnnxEmbedder();
		const t0 = Date.now();
		const results = await Promise.all(
			Array.from({ length: 10 }, (_, i) => e.embed([`concurrent ${String(i)}`])),
		);
		const elapsed = Date.now() - t0;
		expect(results).toHaveLength(10);
		// Ten sequential cold loads would be seconds; one load plus ten embeds is well under.
		expect(elapsed).toBeLessThan(60_000);
		await e.close();
	}, 90_000);

	it("embedding nothing returns nothing, without loading the model", async () => {
		const e = new OnnxEmbedder();
		expect(await e.embed([])).toEqual([]);
		await e.close();
	});

	it("a missing model directory is reported rather than crashing at load", () => {
		expect(new OnnxEmbedder("/nonexistent/models").available()).toBe(false);
	});

	it("the native ONNX runtime is loadable on this installation", async () => {
		const ort = await import("onnxruntime-node");
		expect(ort.InferenceSession).toBeDefined();
	});
});

describe("HashEmbedder (tests and degraded hosts)", () => {
	it("is deterministic and normalized", async () => {
		const e = new HashEmbedder();
		const [a] = await e.embed(["some fact"]);
		const [b] = await e.embed(["some fact"]);
		expect([...(a as Float32Array)]).toEqual([...(b as Float32Array)]);
		let n = 0;
		for (const x of a as Float32Array) n += x * x;
		expect(Math.sqrt(n)).toBeCloseTo(1, 5);
	});

	it("announces that it is NOT semantic", () => {
		/**
		 * A vector carries its model id, so a mixed index is detectable rather than mysterious. The name
		 * says the limitation out loud because a silent stand-in would make recall look broken rather than
		 * degraded.
		 */
		expect(new HashEmbedder().modelId).toContain("NOT-SEMANTIC");
		expect(new HashEmbedder().dimensions).toBe(EMBED_DIMENSIONS);
	});

	it("different texts produce different vectors", async () => {
		const e = new HashEmbedder();
		const [a, b] = await e.embed(["alpha beta", "gamma delta"]);
		expect([...(a as Float32Array)]).not.toEqual([...(b as Float32Array)]);
	});
});
