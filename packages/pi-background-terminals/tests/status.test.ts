import { describe, expect, it } from "vitest";
import { backgroundTerminalStatus } from "../extensions/background-terminals.ts";

describe("backgroundTerminalStatus", () => {
	it("is terse, actionable, and clears when idle", () => {
		expect(backgroundTerminalStatus(0)).toBeUndefined();
		expect(backgroundTerminalStatus(1)).toBe("● 1 background terminal · /ps");
		expect(backgroundTerminalStatus(3)).toBe("● 3 background terminals · /ps");
	});
});
