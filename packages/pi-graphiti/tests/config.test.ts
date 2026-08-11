import { afterEach, describe, expect, it } from "vitest";
import { graphitiConfig, resetConfigCache } from "../src/config.ts";

const ENV_KEYS = [
	"GRAPHITI_BASE_URL",
	"GRAPHITI_API_KEY",
	"GRAPHITI_GROUP_ID",
	"GRAPHITI_TIMEOUT_MS",
	"GRAPHITI_AUTO_RECALL_FACTS",
	"GRAPHITI_AUTO_RECALL_MIN_PROMPT",
];

describe("graphitiConfig", () => {
	afterEach(() => {
		for (const key of ENV_KEYS) delete process.env[key];
		resetConfigCache();
	});

	it("applies defaults and env overrides", async () => {
		process.env.GRAPHITI_BASE_URL = "https://memory.test/mcp";
		process.env.GRAPHITI_AUTO_RECALL_FACTS = "0";
		resetConfigCache();
		const config = await graphitiConfig();
		expect(config.baseUrl).toBe("https://memory.test/mcp");
		expect(config.groupId).toBe("main");
		expect(config.timeoutMs).toBe(15_000);
		expect(config.autoRecallFacts).toBe(0);
	});

	it("rejects a non-http baseUrl", async () => {
		process.env.GRAPHITI_BASE_URL = "not-a-url";
		resetConfigCache();
		const config = await graphitiConfig();
		expect(config.baseUrl).toBeUndefined();
	});
});
