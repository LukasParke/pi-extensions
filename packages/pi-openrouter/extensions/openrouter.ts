import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FALLBACK_MODELS, fetchApiModels } from "../src/catalog.ts";
import { openrouterConfig } from "../src/config.ts";
import { buildAllProviders } from "../src/provider.ts";

/**
 * Registers OpenRouter's three API surfaces as separate providers:
 *
 *   openrouter-completions  /api/v1/chat/completions  (openai-completions)
 *   openrouter-responses    /api/v1/responses         (openai-responses)
 *   openrouter-messages     /api/v1/messages          (anthropic-messages)
 *
 * Same key ($OPENROUTER_API_KEY), same curated models, same attribution
 * headers — the only variable is the wire protocol, which is exactly what
 * makes them comparable (see scripts/benchmark.ts).
 */
export default async function (pi: ExtensionAPI) {
	const config = await openrouterConfig();
	const apiModels = await fetchApiModels(config).catch(() => FALLBACK_MODELS);

	for (const { id, ...provider } of buildAllProviders(config, apiModels)) {
		pi.registerProvider(id, provider);
	}
}
