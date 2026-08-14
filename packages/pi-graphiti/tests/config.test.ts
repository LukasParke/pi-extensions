import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { graphitiConfig, resetConfigCache } from "../src/config.ts";

// Keep tests hermetic: without this, load() reads the real ~/.pi/graphiti.json.
const ISOLATED_AGENT_DIR = path.join(os.tmpdir(), "pi-graphiti-test-nonexistent", "agent");

const ENV_KEYS = [
	"GRAPHITI_BASE_URL",
	"GRAPHITI_API_KEY",
	"GRAPHITI_GROUP_ID",
	"GRAPHITI_TIMEOUT_MS",
	"GRAPHITI_AUTO_RECALL_FACTS",
	"GRAPHITI_AUTO_RECALL_MIN_PROMPT",
	"GRAPHITI_RECALL_CACHE_TTL_MS",
];

describe("graphitiConfig", () => {
	beforeEach(() => {
		process.env.PI_CODING_AGENT_DIR = ISOLATED_AGENT_DIR;
	});

	afterEach(() => {
		for (const key of ENV_KEYS) delete process.env[key];
		delete process.env.PI_CODING_AGENT_DIR;
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
		expect(config.recallCacheTtlMs).toBe(120_000);
	});

	it("rejects a non-http baseUrl", async () => {
		process.env.GRAPHITI_BASE_URL = "not-a-url";
		resetConfigCache();
		const config = await graphitiConfig();
		expect(config.baseUrl).toBeUndefined();
	});
});
