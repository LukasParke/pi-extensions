import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MemoryEngine } from "../src/engine.ts";
import { FallbackEmbedder, HashEmbedder } from "../src/index/embed.ts";
import { MEMORY_SCHEMA_UP } from "../src/schema.ts";
import type { Embedder } from "../src/types.ts";

it("falls back permanently when the semantic embedder cannot load", async () => {
	let primaryCalls = 0;
	const primary: Embedder = {
		dimensions: 384,
		modelId: "broken-semantic",
		async embed() {
			primaryCalls++;
			throw new Error("native runtime unavailable");
		},
	};
	const fallback = new HashEmbedder();
	const embedder = new FallbackEmbedder(primary, fallback);
	const [first] = await embedder.embed(["one"]);
	const [second] = await embedder.embed(["two"]);
	expect(first).toHaveLength(384);
	expect(second).toHaveLength(384);
	expect(primaryCalls).toBe(1);
	expect(embedder.modelId).toBe(fallback.modelId);
});

it("records the fallback model id when failover happens during a write", async () => {
	const primary: Embedder = {
		dimensions: 384,
		modelId: "broken-semantic",
		async embed() {
			throw new Error("native runtime unavailable");
		},
	};
	const fallback = new HashEmbedder();
	const embedder = new FallbackEmbedder(primary, fallback);
	const db = new DatabaseSync(":memory:");
	db.exec(MEMORY_SCHEMA_UP);
	const engine = new MemoryEngine({ db, peerId: "test", embedder, redact: (text) => text });
	await engine.add({ text: "A durable fallback fact", scope: "global", extracted_by: "user" });
	expect((db.prepare("SELECT model_id FROM memory_vec").get() as { model_id: string }).model_id).toBe(
		fallback.modelId,
	);
	await engine.close();
	db.close();
});
