import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve, sanitize } from "@parke.dev/pi-ext-config";
import { defaults, schema, sentinelConfig } from "../src/config.ts";

const directories: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("Sentinel config", () => {
	it("is opt-in, validates values, and lets env override the file", () => {
		expect(resolve(schema, defaults, {}, {})).toEqual({ cmuxStatus: false });
		expect(resolve(schema, defaults, {}, { PI_SENTINEL_CMUX_STATUS: "1" })).toEqual({ cmuxStatus: true });
		expect(resolve(schema, defaults, { cmuxStatus: true }, { PI_SENTINEL_CMUX_STATUS: "0" })).toEqual({
			cmuxStatus: false,
		});
		expect(
			resolve(schema, defaults, sanitize(schema, { cmuxStatus: "typo" }), {
				PI_SENTINEL_CMUX_STATUS: "typo",
			}),
		).toEqual({ cmuxStatus: false });
	});

	it("loads sentinel.json beside the configured agent dir and tolerates malformed files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sentinel-config-"));
		directories.push(dir);
		vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
		vi.stubEnv("PI_SENTINEL_CMUX_STATUS", undefined);
		expect(await sentinelConfig()).toEqual({ cmuxStatus: false });
		await writeFile(join(dir, "sentinel.json"), '{"cmuxStatus":true}');
		expect(await sentinelConfig()).toEqual({ cmuxStatus: true });
		vi.stubEnv("PI_SENTINEL_CMUX_STATUS", "0");
		expect(await sentinelConfig()).toEqual({ cmuxStatus: false });
		vi.stubEnv("PI_SENTINEL_CMUX_STATUS", undefined);
		await writeFile(join(dir, "sentinel.json"), '{"cmuxStatus":');
		expect(await sentinelConfig()).toEqual({ cmuxStatus: false });
	});
});
