#!/usr/bin/env bun
/**
 * pi-openrouter sync — regenerate the OpenRouter section of models.json from
 * the live catalog and the routing rules in src/rules.ts.
 *
 *   pi-openrouter sync              write models.json if it changed
 *   pi-openrouter sync --check      exit 1 if models.json is stale (CI mode)
 *   pi-openrouter sync --stdout     print the merged file instead of writing
 *   pi-openrouter sync --file PATH  target a different models.json
 *
 * The whole catalog is regenerated on every run; entries are deterministic
 * given the same (catalog, rules), so diffs are meaningful review artifacts.
 */

import { piAgentDir } from "@parke.dev/pi-ext-config";
import { join } from "node:path";
import { fetchApiModels } from "./catalog.ts";
import { openrouterConfig } from "./config.ts";
import { generateModels } from "./generate.ts";
import { staleExceptions } from "./rules.ts";
import { syncModelsJson } from "./sync.ts";

function parseArgs(argv: string[]) {
	const args = { check: false, stdout: false, file: join(piAgentDir(), "models.json") };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--check") args.check = true;
		else if (arg === "--stdout") args.stdout = true;
		else if (arg === "--file") args.file = argv[++i]!;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return args;
}

async function main() {
	const [command, ...rest] = process.argv.slice(2);
	if (command !== "sync") {
		throw new Error(`Usage: pi-openrouter sync [--check] [--stdout] [--file PATH]`);
	}
	const args = parseArgs(rest);
	const config = await openrouterConfig();

	// Fetch failure aborts the sync: never generate from a partial snapshot.
	const apiModels = await fetchApiModels(config);
	const models = generateModels(apiModels, config.baseUrl);

	for (const exception of staleExceptions()) {
		console.error(
			`warning: exception "${exception.pattern}" is past its revalidateAfter ${exception.revalidateAfter} — re-benchmark it (${exception.reason})`,
		);
	}

	const result = await syncModelsJson({
		modelsPath: args.file,
		models,
		write: !args.check && !args.stdout,
	});

	if (args.stdout) {
		process.stdout.write(result.output);
	} else if (args.check) {
		if (result.changed) {
			console.error(`${args.file} is stale (${result.modelCount} models). Run: pi-openrouter sync`);
			process.exit(1);
		}
		console.log(`${args.file} is up to date (${result.modelCount} models)`);
	} else {
		console.log(
			result.changed
				? `wrote ${args.file} (${result.modelCount} models)`
				: `${args.file} already up to date (${result.modelCount} models)`,
		);
	}
}

main().catch((error) => {
	console.error(`pi-openrouter: ${error instanceof Error ? error.message : error}`);
	process.exit(1);
});
