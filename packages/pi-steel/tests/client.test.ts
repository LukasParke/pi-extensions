import { resolve } from "@parke.dev/pi-ext-config";
import { describe, expect, it } from "vitest";
import { explain, headers, imageMime, isTransient, withRetry } from "../src/client.ts";
import { defaultConfig, schema, type SteelConfig } from "../src/config.ts";

const load = (file: Partial<SteelConfig> = {}) => resolve(schema, defaultConfig, file, {});

describe("headers", () => {
	it("omits auth headers when no key is configured", () => {
		expect(headers(load())).toEqual({ "content-type": "application/json" });
	});

	it("sends the key as both x-api-key and bearer", () => {
		// Steel cloud reads x-api-key; reverse proxies commonly want a bearer.
		// Sending both avoids a config knob for something the server ignores.
		const head = headers(load({ apiKey: "secret" }));
		expect(head["x-api-key"]).toBe("secret");
		expect(head.authorization).toBe("Bearer secret");
	});
});

describe("isTransient", () => {
	it("flags browser-race failures", () => {
		for (const message of [
			"Execution context was destroyed",
			"Navigation timeout of 30000 ms exceeded",
			"Target closed",
			"Session closed unexpectedly",
			"Attempted to use detached Frame",
		]) {
			expect(isTransient(new Error(message))).toBe(true);
		}
	});

	it("does not flag genuine client errors", () => {
		expect(isTransient(new Error("Steel /v1/scrape returned 404: not found"))).toBe(false);
		expect(isTransient(new Error("ECONNREFUSED"))).toBe(false);
	});
});

describe("withRetry", () => {
	it("retries a transient failure once and succeeds", async () => {
		let calls = 0;
		const result = await withRetry(async () => {
			calls++;
			if (calls === 1) throw new Error("Target closed");
			return "ok";
		});
		expect(result).toBe("ok");
		expect(calls).toBe(2);
	});

	it("does not retry a non-transient failure", async () => {
		let calls = 0;
		await expect(
			withRetry(async () => {
				calls++;
				throw new Error("Steel /v1/scrape returned 400: bad url");
			}),
		).rejects.toThrow("400");
		expect(calls).toBe(1);
	});

	it("gives up after the attempt budget", async () => {
		let calls = 0;
		await expect(
			withRetry(async () => {
				calls++;
				throw new Error("Target closed");
			}, 2),
		).rejects.toThrow("Target closed");
		expect(calls).toBe(2);
	});
});

describe("explain", () => {
	it("tells a local user how to start Steel", () => {
		const message = explain(new Error("fetch failed"), load());
		expect(message).toContain("docker run");
		expect(message).toContain("ghcr.io/steel-dev/steel-browser");
	});

	it("tells a remote user to check host and network", () => {
		const message = explain(new Error("ECONNREFUSED"), load({ baseUrl: "https://steel.example.com" }));
		expect(message).toContain("steel.example.com");
		expect(message).toMatch(/VPN|network/);
		expect(message).not.toContain("docker run");
	});

	it("distinguishes a missing key from a rejected key", () => {
		const missing = explain(new Error("401 Unauthorized"), load({ baseUrl: "https://api.steel.dev" }));
		expect(missing).toContain("STEEL_API_KEY");

		const rejected = explain(
			new Error("403 Forbidden"),
			load({ baseUrl: "https://api.steel.dev", apiKey: "bad" }),
		);
		expect(rejected).toContain("not accepted");
	});

	it("explains a timeout as a slow page, not a config problem", () => {
		const abort = new Error("aborted");
		abort.name = "AbortError";
		expect(explain(abort, load())).toContain("timed out");
	});

	it("never leaks the maintainer's private hostnames", () => {
		// Regression guard: these messages were written against a homelab and
		// referenced internal gateways by name.
		for (const error of [new Error("fetch failed"), new Error("401")]) {
			expect(explain(error, load())).not.toMatch(/parke\.dev|home-ops|home network/);
		}
	});
});

describe("imageMime", () => {
	it("sniffs png, jpeg and webp from magic bytes", () => {
		expect(imageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).toBe("image/png");
		expect(imageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
		expect(imageMime(Buffer.concat([Buffer.from("RIFF????WEBP"), Buffer.alloc(4)]))).toBe("image/webp");
	});

	it("falls back to octet-stream for anything unrecognized", () => {
		expect(imageMime(Buffer.from("not an image"))).toBe("application/octet-stream");
	});
});
