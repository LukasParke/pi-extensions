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

	it("expands ~ in configured roots", () => {
		// The real pipeline sanitizes file content before resolving.
		const [root] = load(sanitize(schema, { repoRoots: ["~/code"] })).repoRoots;
		expect(root.startsWith("/")).toBe(true);
		expect(root.endsWith("/code")).toBe(true);
	});

	it("falls back to defaults on an empty or malformed value", () => {
		expect(load({}, { HERDR_REPO_ROOTS: "" }).repoRoots).toEqual(defaultConfig.repoRoots);
		expect(sanitize(schema, { repoRoots: 42 })).toEqual({});
	});

	it("drops unknown keys from the config file", () => {
		expect(sanitize(schema, { nope: true, repoRoots: ["/x"] })).toEqual({ repoRoots: ["/x"] });
	});
});
