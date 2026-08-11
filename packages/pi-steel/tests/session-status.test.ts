import { describe, expect, it } from "vitest";
import { steelSessionStatus } from "../extensions/steel-session.ts";

describe("steelSessionStatus", () => {
	it("shows only a short id and hostname, never a sensitive URL path", () => {
		expect(
			steelSessionStatus({
				id: "0123456789abcdef",
				startedAt: 1,
				lastUrl: "https://example.com/private/path?token=secret",
			}),
		).toBe("● Steel 01234567 · example.com · /steel-session");
		expect(steelSessionStatus(undefined)).toBeUndefined();
	});
});
