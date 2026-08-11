import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryEngine, ulid } from "../src/engine.ts";
import { encodeVector, OnnxEmbedder } from "../src/index.ts";
import { MEMORY_SCHEMA_UP } from "../src/schema.ts";

/**
 * Recall at scale (AC-8.2).
 *
 * The budget is p95 < 50ms on a 10k-entry corpus, INCLUDING the query embed. That last clause is what
 * makes it a real budget: the model is ~2ms of the total, and a test that excluded it would pass while
 * the product felt slow.
 *
 * The corpus is seeded directly rather than through `add()`, because 10,000 real embeds is ~20 seconds
 * and this measures RETRIEVAL. The vectors are random-but-normalized, which is the honest shape for a
 * scan benchmark: the scan cost does not depend on what the vectors mean.
 */

const CORPUS = 10_000;
const embedder = new OnnxEmbedder();

let db: DatabaseSync;
let engine: MemoryEngine;

beforeAll(async () => {
	db = new DatabaseSync(":memory:");
	db.exec(MEMORY_SCHEMA_UP);
	engine = new MemoryEngine({ db, peerId: "perf", embedder, redact: (s) => s });

	// Realistic text, so FTS has something to rank rather than one repeated string.
	const subjects = ["api", "auth", "deploy", "cache", "index", "session", "worker", "panel"];
	const verbs = ["lives in", "runs on", "depends on", "is owned by", "expires after"];
	const objects = ["packages/core", "talos", "the daemon", "thirty days", "the renderer"];

	const insertEntry = db.prepare(
		`INSERT INTO memory_entries (id,scope,project_id,text,text_norm,created_at,updated_at,tombstone,
       lamport,origin_peer,learned_at,confirmations,extracted_by,used_in_count)
     VALUES (?,'global',NULL,?,?,1,1,0,?,'perf',1,1,'turn',0)`,
	);
	const insertFts = db.prepare("INSERT INTO memory_fts (entry_id, text) VALUES (?,?)");
	const insertVec = db.prepare("INSERT INTO memory_vec (entry_id, embedding, model_id) VALUES (?,?,'perf')");

	db.exec("BEGIN IMMEDIATE");
	for (let i = 0; i < CORPUS; i++) {
		const text = `${subjects[i % subjects.length]} ${verbs[i % verbs.length]} ${objects[i % objects.length]} variant ${String(i)}`;
		const id = ulid(1000 + i);
		insertEntry.run(id, text, text.toLowerCase(), i + 1);
		insertFts.run(id, text);

		const v = new Float32Array(384);
		for (let d = 0; d < 384; d++) v[d] = Math.random() - 0.5;
		let n = 0;
		for (let d = 0; d < 384; d++) n += (v[d] as number) ** 2;
		n = Math.sqrt(n);
		for (let d = 0; d < 384; d++) v[d] = (v[d] as number) / n;
		insertVec.run(id, encodeVector(v));
	}
	db.exec("COMMIT");

	// Warms the model, so the first measured query is not paying for a cold load — that budget is AC-8.21.
	await engine.recall("warm up", { mode: "global" });
}, 120_000);

afterAll(async () => {
	await engine.close();
	db.close();
});

/**
 * The budget is measured WITHOUT coverage instrumentation.
 *
 * Uninstrumented this is 33.9ms p95; under V8 coverage it is 51.5ms, so a hard 50ms assertion fails in
 * `pnpm coverage` while the product is comfortably inside budget. That is a test measuring the profiler,
 * which I hit once already in Phase 6 and widened the wrong way — the fix there was a looser number,
 * which weakened the check for every run.
 *
 * Here the ceiling adapts instead: the real budget is asserted in a normal run, and coverage runs get a
 * ceiling that still catches a genuine regression (a 2x slowdown would breach either). The console line
 * always prints the true figure, so a slow p95 is visible even when it passes.
 */
const INSTRUMENTED = process.env.VITEST_COVERAGE === "true" || process.argv.includes("--coverage");
const BUDGET_MS = INSTRUMENTED ? 90 : 50;

describe.sequential("recall performance", () => {
	it("AC-8.2 recall p95 < 50ms on a 10k corpus, query embed included", async () => {
		expect(engine.stats().total).toBe(CORPUS);

		const queries = [
			"where does auth live",
			"what runs on talos",
			"how long do sessions last",
			"which package owns the api",
			"deploy pipeline",
			"cache expiry",
			"worker thread",
			"panel renderer",
		];

		const timings: number[] = [];
		for (let round = 0; round < 5; round++) {
			for (const q of queries) {
				const { tookMs } = await engine.recall(q, { mode: "global" });
				timings.push(tookMs);
			}
		}

		timings.sort((a, b) => a - b);
		const p50 = timings[Math.floor(timings.length * 0.5)] as number;
		const p95 = timings[Math.floor(timings.length * 0.95)] as number;
		console.log(
			`  recall over ${String(CORPUS)} entries: p50 ${p50.toFixed(1)}ms  p95 ${p95.toFixed(1)}ms ` +
				`(budget ${String(BUDGET_MS)}ms${INSTRUMENTED ? ", instrumented" : ""})`,
		);
		expect(p95).toBeLessThan(BUDGET_MS);
	}, 120_000);

	it("AC-8.2 the dense scan itself is a small part of the budget", async () => {
		/**
		 * Recorded so the ANN decision can be revisited on evidence rather than instinct. The scan was measured
		 * at 3.3ms p95 for 10k x 384 before any of this was built, and if it ever dominates, THIS is the number
		 * that will say so — not a hunch about scale.
		 */
		const vectors = engine.store.liveVectors();
		expect(vectors.size).toBe(CORPUS);

		const [q] = await embedder.embed(["a representative query"]);
		const timings: number[] = [];
		for (let i = 0; i < 20; i++) {
			const t0 = performance.now();
			let best = -1;
			for (const v of vectors.values()) {
				let acc = 0;
				for (let d = 0; d < 384; d++) acc += (q as Float32Array)[d]! * v[d]!;
				if (acc > best) best = acc;
			}
			timings.push(performance.now() - t0);
		}
		timings.sort((a, b) => a - b);
		console.log(`  dense scan alone: p95 ${(timings[19] as number).toFixed(1)}ms`);
		expect(timings[19]).toBeLessThan(25);
	}, 60_000);
});
