import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FALLBACK_MODELS, fetchApiModels } from "../src/catalog.ts";
import { openrouterConfig } from "../src/config.ts";
import type { ApiModel } from "../src/catalog.ts";
import type { OpenRouterConfig } from "../src/config.ts";
import { buildAllProviders, buildRoutedProvider } from "../src/provider.ts";

export function registerOpenRouterProviders(
	pi: Pick<ExtensionAPI, "registerProvider">,
	config: OpenRouterConfig,
	apiModels: ApiModel[],
) {
	for (const { id, ...provider } of [
		...buildAllProviders(config, apiModels),
		buildRoutedProvider(config, apiModels),
	]) {
		pi.registerProvider(id, provider);
	}
}

export default async function (pi: ExtensionAPI) {
	const config = await openrouterConfig();
	const apiModels = await fetchApiModels(config).catch(() => FALLBACK_MODELS);
	registerOpenRouterProviders(pi, config, apiModels);
}
