/**
 * Runs the same multi-turn agentic tool-loop through all three OpenRouter API
 * surfaces with the same model, N trials each, and writes:
 *
 *   docs/BENCHMARK.md          markdown report (mean per surface)
 *   docs/benchmark-<ts>.jsonl  raw per-trial results
 *
 * Usage:
 *   bun run scripts/benchmark.ts [model] [--trials N] [--surfaces a,b,c]
 *
 * Requires OPENROUTER_API_KEY. Uses pi-ai's stream implementations directly —
 * the exact code paths pi itself uses for each API surface.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { streamSimple as completionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as messagesStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import {
	fetchApiModels,
	providerId,
	SURFACE_API,
	SURFACES,
	surfaceBaseUrl,
	type Surface,
} from "../src/catalog.ts";
import { buildModelEntry } from "../src/generate.ts";
import { attributionHeaders, defaultConfig } from "../src/config.ts";
import { runTrial, summarize, renderReport, type StreamFn, type TrialResult } from "../src/benchmark.ts";

const STREAMS: Record<Surface, StreamFn> = {
	completions: completionsStream as StreamFn,
	responses: responsesStream as StreamFn,
	messages: messagesStream as StreamFn,
};

function parseArgs(argv: string[]) {
	const args = { model: "openai/gpt-5.2", trials: 3, surfaces: [...SURFACES] as Surface[] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--trials") args.trials = Number(argv[++i]);
		else if (arg === "--surfaces") {
			args.surfaces = argv[++i]!.split(",").filter((s): s is Surface =>
				(SURFACES as readonly string[]).includes(s),
			);
		} else if (!arg.startsWith("--")) args.model = arg;
	}
	if (!Number.isInteger(args.trials) || args.trials < 1) throw new Error("--trials must be >= 1");
	return args;
}

async function main() {
	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

	const args = parseArgs(process.argv.slice(2));
	const config = { ...defaultConfig, models: [args.model] };
	const apiModels = await fetchApiModels(config);
	const headers = attributionHeaders(config);

	const docsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "docs");
	await mkdir(docsDir, { recursive: true });
	const jsonlPath = join(docsDir, `benchmark-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);

	const allTrials: TrialResult[] = [];
	for (const surface of args.surfaces) {
		const apiModel = apiModels.find((m) => m.id === args.model);
		if (!apiModel) throw new Error(`Model ${args.model} not found in the OpenRouter models API`);
		const catalogModel = buildModelEntry(apiModel, config.baseUrl, surface);
		const model = {
			...catalogModel,
			api: SURFACE_API[surface] as Api,
			provider: providerId(surface),
			baseUrl: surfaceBaseUrl(surface, config.baseUrl),
		} as Model<Api>;

		for (let trial = 1; trial <= args.trials; trial++) {
			process.stderr.write(`[${surface}] trial ${trial}/${args.trials}... `);
			const result = await runTrial({
				surface,
				model,
				stream: STREAMS[surface],
				trial,
				apiKey,
				headers,
				maxTokens: 2048,
				reasoning: "low",
			});
			allTrials.push(result);
			await writeFile(jsonlPath, allTrials.map((t) => JSON.stringify(t)).join("\n") + "\n");
			process.stderr.write(
				result.error
					? `ERROR: ${result.error.slice(0, 120)}\n`
					: `${result.turns.length} turns, $${result.totalCost.toFixed(5)}, ${(result.totalWallMs / 1000).toFixed(1)}s, reasoning ${result.reasoningPreserved ? "replayed" : "NOT replayed"}\n`,
			);
		}
	}

	const summaries = args.surfaces.map((surface) =>
		summarize(
			surface,
			allTrials.filter((t) => t.surface === surface),
		),
	);
	const report = renderReport(args.model, summaries);
	await writeFile(join(docsDir, "BENCHMARK.md"), report);
	console.log(report);
	console.log(`Raw trials: ${jsonlPath}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
