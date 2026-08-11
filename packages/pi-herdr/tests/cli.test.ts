import { describe, expect, it } from "vitest";
import { describeHerdrError, parseHerdrError } from "../src/cli.ts";

describe("parseHerdrError", () => {
	it("recovers the envelope from mixed CLI output", () => {
		const raw = 'some noise\n{"error":{"code":"agent_pane_busy","message":"pane has a process"}}\n';
		expect(parseHerdrError(raw)).toEqual({ code: "agent_pane_busy", message: "pane has a process" });
	});

	it("returns undefined when there is no JSON at all", () => {
		expect(parseHerdrError("Command failed: herdr")).toBeUndefined();
	});

	it("returns undefined for JSON without an error envelope", () => {
		expect(parseHerdrError('{"result":{"ok":true}}')).toBeUndefined();
		expect(parseHerdrError("{not json}")).toBeUndefined();
	});
});

describe("describeHerdrError", () => {
	it("names the command and includes the structured code", () => {
		expect(describeHerdrError(["agent", "start", "x"], { code: "agent_pane_busy", message: "busy" })).toBe(
			"herdr agent start: agent_pane_busy: busy",
		);
	});

	it("copes with single-word commands and codeless errors", () => {
		expect(describeHerdrError(["status"], { message: "down" })).toBe("herdr status: down");
	});
});
