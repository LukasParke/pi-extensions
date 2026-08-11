#!/usr/bin/env node
/**
 * Fetches the bundled embedding model (R-8.4).
 *
 * The weights are ~23MB of binary and are NOT committed: a repository that carries them is a repository
 * every clone pays for, and git handles large binaries badly enough that a later model swap would leave
 * both versions in history forever.
 *
 * They are still BUNDLED in the sense AC-8.3 requires — fetched once at install, then entirely local, so
 * recall works with the network unplugged. The distinction that matters is "no network on the hot path",
 * not "no network ever".
 *
 * Verified by SHA-256, because an embedding model is code in the sense that matters: it decides what
 * Pi remembers, and a substituted file would silently change every vector.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "packages/pi-memory/models");

const FILES = [
	{
		name: "model_quantized.onnx",
		url: "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx",
		bytes: 22972370,
		sha256: "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
	},
	{
		name: "tokenizer.json",
		url: "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/tokenizer.json",
		bytes: 711661,
		sha256: "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
	},
];

async function main() {
	mkdirSync(DIR, { recursive: true });
	const check = process.argv.includes("--check");

	for (const f of FILES) {
		const path = join(DIR, f.name);
		if (existsSync(path)) {
			const existing = readFileSync(path);
			const actual = existing.byteLength;
			const digest = createHash("sha256").update(existing).digest("hex");
			if (actual === f.bytes && digest === f.sha256) {
				console.log(`${f.name}: present (${actual} bytes, sha256 ${digest.slice(0, 16)}…)`);
				continue;
			}
			console.error(
				`${f.name}: integrity mismatch (size ${actual}/${f.bytes}, sha256 ${digest}/${f.sha256})`,
			);
			if (check) process.exit(1);
		} else if (check) {
			console.error(`${f.name}: missing. Run \`node scripts/fetch-model.mjs\` — memory recall needs it.`);
			process.exit(1);
		}

		console.log(`fetching ${f.name} (${(f.bytes / 1024 / 1024).toFixed(1)} MB)…`);
		const res = await fetch(f.url);
		if (!res.ok) throw new Error(`${f.url} returned ${String(res.status)}`);
		const buf = Buffer.from(await res.arrayBuffer());
		const digest = createHash("sha256").update(buf).digest("hex");
		if (buf.byteLength !== f.bytes || digest !== f.sha256) {
			throw new Error(
				`${f.name}: integrity mismatch (size ${String(buf.byteLength)}/${String(f.bytes)}, sha256 ${digest}/${f.sha256})`,
			);
		}
		writeFileSync(path, buf);
		console.log(`  sha256 ${digest.slice(0, 16)}…`);
	}
	console.log("model ready — recall runs entirely locally from here");
}

await main();
