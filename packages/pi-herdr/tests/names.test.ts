import { describe, expect, it } from "vitest";
import {
	AGENT_NAME_PATTERN,
	assertAgentName,
	assertAgentTarget,
	INVALID_AGENT_NAME_MESSAGE,
	isAgentName,
	isAgentTarget,
	isPaneId,
	normalizeGeneratedName,
	resolveHerdrTaskName,
	slugify,
} from "../src/names.ts";

const nameRe = new RegExp(AGENT_NAME_PATTERN);

describe("agent name contract", () => {
	it.each(["a", "a".repeat(31), "a".repeat(32), "fix-ci", "review_pr_1"])(
		"accepts boundary name %j",
		(name) => {
			expect(isAgentName(name)).toBe(true);
			expect(name).toMatch(nameRe);
			expect(() => assertAgentName(name)).not.toThrow();
		},
	);

	it.each([
		["", INVALID_AGENT_NAME_MESSAGE],
		[".", INVALID_AGENT_NAME_MESSAGE],
		["..", INVALID_AGENT_NAME_MESSAGE],
		["Afix", INVALID_AGENT_NAME_MESSAGE],
		["1bad", INVALID_AGENT_NAME_MESSAGE],
		["has space", INVALID_AGENT_NAME_MESSAGE],
		["has.dot", INVALID_AGENT_NAME_MESSAGE],
		["with/slash", INVALID_AGENT_NAME_MESSAGE],
		["with\\slash", INVALID_AGENT_NAME_MESSAGE],
		["a".repeat(33), INVALID_AGENT_NAME_MESSAGE],
	])("rejects %j", (name, message) => {
		expect(isAgentName(name)).toBe(false);
		expect(() => assertAgentName(name)).toThrow(message);
	});
});

describe("agent targets", () => {
	it("accepts Herdr pane ids for status and cleanup", () => {
		expect(isPaneId("w7:p3")).toBe(true);
		expect(isAgentTarget("w7:p3")).toBe(true);
		expect(() => assertAgentTarget("w7:p3")).not.toThrow();
		expect(isAgentName("w7:p3")).toBe(false);
	});

	it("rejects pane ids as dispatch names", () => {
		expect(() => assertAgentName("w7:p3")).toThrow(INVALID_AGENT_NAME_MESSAGE);
	});
});

describe("slugify", () => {
	it("keeps 31 and 32 character slugs and trims 33 without a trailing separator", () => {
		expect(slugify("a".repeat(31))).toBe("a".repeat(31));
		expect(slugify("a".repeat(32))).toBe("a".repeat(32));
		expect(slugify(`${"a".repeat(31)}-tail`)).toBe("a".repeat(31));
		expect(slugify("backport patch review this set of patch")).toBe("backport-patch-review-this-set-o");
	});

	it("falls back for empty, non-Latin, and digit-leading tasks", () => {
		expect(slugify("42 fix the thing")).toBe("task-42-fix-the-thing");
		expect(slugify("???")).toMatch(/^task-/);
		expect(slugify("日本語のタスク", () => 36)).toBe("task-10");
		expect(slugify("", () => 36)).toBe("task-10");
		expect(slugify("???".repeat(20), () => 36).length).toBeLessThanOrEqual(32);
	});
});

describe("normalizeGeneratedName", () => {
	it("strips quotes, backticks, and explanation then slugifies", () => {
		expect(normalizeGeneratedName("`Clickable File Paths` because that is the subject")).toBe(
			"clickable-file-paths",
		);
		expect(normalizeGeneratedName('"herdr-context-gate"\nignore this')).toBe("herdr-context-gate");
	});

	it("returns undefined for empty output", () => {
		expect(normalizeGeneratedName("")).toBeUndefined();
		expect(normalizeGeneratedName("   ")).toBeUndefined();
	});
});

describe("resolveHerdrTaskName", () => {
	it("rejects explicit invalid names without generating", async () => {
		let generated = 0;
		await expect(
			resolveHerdrTaskName({ task: "long task", name: "Fix" }, async () => {
				generated += 1;
				return "nope";
			}),
		).rejects.toThrow(INVALID_AGENT_NAME_MESSAGE);
		expect(generated).toBe(0);
	});

	it("uses generated names and falls back on failure", async () => {
		await expect(resolveHerdrTaskName({ task: "anything" }, async () => "agent-name-limit")).resolves.toBe(
			"agent-name-limit",
		);
		await expect(
			resolveHerdrTaskName({ task: "Add CI caching for Node builds" }, async () => {
				throw new Error("no model");
			}),
		).resolves.toBe("add-ci-caching-for-node-builds");
	});
});
