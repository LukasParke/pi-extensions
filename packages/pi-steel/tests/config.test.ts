import { resolve, sanitize } from "@parke.dev/pi-ext-config";
import { describe, expect, it } from "vitest";
import { cdpBase, defaultConfig, looksRemote, schema, type SteelConfig } from "../src/config.ts";

const load = (file: Partial<SteelConfig> = {}, env: NodeJS.ProcessEnv = {}) =>
	resolve(schema, defaultConfig, file, env);

describe("defaults", () => {
	it("targets a stock local docker instance", () => {
		// The published default must work for someone following Steel's own
		// quickstart, with no config file and no env vars.
		expect(defaultConfig.baseUrl).toBe("http://localhost:3000");
	});

	it("does not ship an API key or a private hostname", () => {
		expect(defaultConfig.apiKey).toBeUndefined();
		expect(JSON.stringify(defaultConfig)).not.toMatch(/parke\.dev/);
	});
});

describe("precedence", () => {
	it("env overrides the config file, which overrides defaults", () => {
		const config = load(
			{ baseUrl: "https://file.example.com", timeoutMs: 10_000 },
			{ STEEL_BASE_URL: "https://env.example.com" },
		);
		expect(config.baseUrl).toBe("https://env.example.com");
		expect(config.timeoutMs).toBe(10_000);
		expect(config.screenshotTimeoutMs).toBe(defaultConfig.screenshotTimeoutMs);
	});

	it("ignores a malformed base URL rather than breaking the extension", () => {
		expect(load({}, { STEEL_BASE_URL: "not-a-url" }).baseUrl).toBe(defaultConfig.baseUrl);
	});

	it("accepts an API key from either source", () => {
		expect(load({ apiKey: "from-file" }).apiKey).toBe("from-file");
		expect(load({ apiKey: "from-file" }, { STEEL_API_KEY: "from-env" }).apiKey).toBe("from-env");
	});

	it("rejects a sub-second timeout", () => {
		expect(load({}, { STEEL_TIMEOUT_MS: "5" }).timeoutMs).toBe(defaultConfig.timeoutMs);
	});
});

describe("sanitize", () => {
	it("drops unknown keys from a user config file", () => {
		expect(sanitize(schema, { baseUrl: "https://a.example.com", nope: 1 })).toEqual({
			baseUrl: "https://a.example.com",
		});
	});

	it("survives a corrupt config file shape", () => {
		expect(sanitize(schema, "garbage")).toEqual({});
	});
});

describe("cdpBase", () => {
	it("falls back to the REST origin for the single-container image", () => {
		// `docker run -p 3000:3000 ghcr.io/steel-dev/steel-browser` serves CDP on
		// the same origin, so an unset cdpUrl must not be a configuration error.
		expect(cdpBase(load())).toBe("http://localhost:3000");
	});

	it("uses an explicit cdpUrl for split docker-compose deployments", () => {
		expect(cdpBase(load({ cdpUrl: "http://localhost:9223" }))).toBe("http://localhost:9223");
	});
});

describe("looksRemote", () => {
	it("treats loopback as local", () => {
		for (const host of ["http://localhost:3000", "http://127.0.0.1:3000"]) {
			expect(looksRemote(load({ baseUrl: host }))).toBe(false);
		}
	});

	it("treats any other host as remote", () => {
		expect(looksRemote(load({ baseUrl: "https://api.steel.dev" }))).toBe(true);
	});
});
