import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MemoryEngine } from "../src/engine.ts";
import { HashEmbedder } from "../src/index/embed.ts";
import { MEMORY_SCHEMA_UP } from "../src/schema.ts";

it("stores the embedding model id on local writes", async () => {
	const db = new DatabaseSync(":memory:");
	db.exec(MEMORY_SCHEMA_UP);
	const embedder = new HashEmbedder();
	const engine = new MemoryEngine({ db, peerId: "test", embedder, redact: (text) => text });
	await engine.add({ text: "A durable fact", scope: "global", extracted_by: "user" });
	expect((db.prepare("SELECT model_id FROM memory_vec").get() as { model_id: string }).model_id).toBe(
		embedder.modelId,
	);
	await engine.close();
	db.close();
});
