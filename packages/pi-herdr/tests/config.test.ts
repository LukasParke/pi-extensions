import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import { resolve, sanitize } from "@parke.dev/pi-ext-config";
import { defaultConfig, schema, type HerdrConfig } from "../src/config.ts";

const load = (file: Partial<HerdrConfig> = {}, env: NodeJS.ProcessEnv = {}) =>
	resolve(schema, defaultConfig, file, env);

describe("defaults", () => {
	it("targets the conventional layout with no config at all", () => {
		expect(defaultConfig.repoRoots.some((p) => p.endsWith("/github"))).toBe(true);
		expect(defaultConfig.worktreeRoots.some((p) => p.includes(".herdr/worktrees"))).toBe(true);
		expect(defaultConfig.logPath).toMatch(/\.pi\/herdr-task\.log$/);
	});
});

describe("precedence and parsing", () => {
	it("accepts an array of roots from the config file", () => {
		expect(load({ repoRoots: ["/srv/repos"] }).repoRoots).toEqual(["/srv/repos"]);
	});

	it("splits a PATH-style env override", () => {
		const env = { HERDR_REPO_ROOTS: ["/a", "/b"].join(delimiter) };
		expect(load({ repoRoots: ["/file"] }, env).repoRoots).toEqual(["/a", "/b"]);
	});

	it("accepts an invocation log path override", () => {
		expect(load({}, { HERDR_LOG_PATH: "/tmp/herdr.jsonl" }).logPath).toBe("/tmp/herdr.jsonl");
	});

	it("expands ~ in configured paths", () => {
		const config = load(sanitize(schema, { repoRoots: ["~/code"], logPath: "~/logs/herdr.jsonl" }));
		const [root] = config.repoRoots;
		expect(root.startsWith("/")).toBe(true);
		expect(root.endsWith("/code")).toBe(true);
		expect(config.logPath).toMatch(/\/logs\/herdr\.jsonl$/);
	});

	it("falls back to defaults on an empty or malformed value", () => {
		expect(load({}, { HERDR_REPO_ROOTS: "" }).repoRoots).toEqual(defaultConfig.repoRoots);
		expect(sanitize(schema, { repoRoots: 42 })).toEqual({});
	});

	it("drops unknown keys from the config file", () => {
		expect(sanitize(schema, { nope: true, repoRoots: ["/x"] })).toEqual({ repoRoots: ["/x"] });
	});
});
