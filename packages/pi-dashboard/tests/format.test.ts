import { describe, expect, it } from "vitest";
import {
	center,
	columns,
	formatCost,
	formatDirectory,
	formatTokens,
	formatTokPerSec,
} from "../src/format.ts";
import { sanitizeTerminalLabel } from "../src/sanitize.ts";
import { formatModelLabel, emptyModelSnapshot } from "../src/model.ts";
import { formatGitLabel, emptyGitSnapshot } from "../src/git.ts";

describe("sanitizeTerminalLabel", () => {
	it("strips CSI / OSC / control chars", () => {
		expect(sanitizeTerminalLabel("hello\x1b[31mred\x1b[0m")).toBe("hellored");
		expect(sanitizeTerminalLabel("a\u0007b\nc")).toBe("abc");
		expect(sanitizeTerminalLabel("\x1b]8;;http://x\x07link\x1b]8;;\x07")).toBe("link");
	});
});

describe("format helpers", () => {
	it("formatTokens", () => {
		expect(formatTokens(42)).toBe("42");
		expect(formatTokens(1500)).toBe("1.5k");
		expect(formatTokens(12_400)).toBe("12k");
		expect(formatTokens(2_500_000)).toBe("2.5M");
	});

	it("formatCost", () => {
		expect(formatCost(0)).toBe("$0.00");
		expect(formatCost(0.0042)).toBe("$0.0042");
		expect(formatCost(1.234)).toBe("$1.23");
	});

	it("formatTokPerSec", () => {
		expect(formatTokPerSec(null)).toBe("— tok/s");
		expect(formatTokPerSec(12.6)).toBe("13 tok/s");
	});

	it("formatDirectory uses ~ and sanitizes the relative path", () => {
		expect(formatDirectory("/home/luke", "/home/luke")).toBe("~");
		expect(formatDirectory("/home/luke/src", "/home/luke")).toBe("~/src");
		expect(formatDirectory("/home/luke/\u001b[31mred", "/home/luke")).toBe("~/red");
		expect(formatDirectory("/tmp", "/home/luke")).toBe("/tmp");
	});

	it("columns and center are width-aware", () => {
		const line = columns("left", "right", 20);
		expect(line.startsWith("left")).toBe(true);
		expect(line.endsWith("right")).toBe(true);
		expect(center("x", 5).trim()).toBe("x");
	});

	it("formatModelLabel", () => {
		expect(formatModelLabel(emptyModelSnapshot())).toBe("no model");
		expect(
			formatModelLabel({
				...emptyModelSnapshot(),
				provider: "openrouter",
				modelId: "claude",
				thinking: "high",
			}),
		).toBe("openrouter/claude · high");
	});

	it("formatGitLabel", () => {
		expect(formatGitLabel(emptyGitSnapshot(), true)).toBe("");
		expect(
			formatGitLabel(
				{
					isRepository: true,
					branch: "main",
					changedFiles: 3,
					pullRequest: { number: 12, url: "https://example.com", isDraft: false },
				},
				true,
			),
		).toBe("main · 3 files · PR #12");
		expect(
			formatGitLabel(
				{
					isRepository: true,
					branch: "main",
					changedFiles: 1,
					pullRequest: { number: 12, url: "https://example.com", isDraft: false },
				},
				false,
			),
		).toBe("main · 1 file");
	});
});
