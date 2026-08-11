import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { withBlockedSignal } from "../extensions/blocked.ts";

function fakePi() {
	const emit = vi.fn();
	return { emit, pi: { events: { emit } } as unknown as ExtensionAPI };
}

const expected = [
	["herdr:blocked", { active: true, label: "waiting" }],
	["herdr:blocked", { active: false }],
];

describe("withBlockedSignal", () => {
	it("balances the signal on return", async () => {
		const { pi, emit } = fakePi();
		await withBlockedSignal(pi, "waiting", async () => undefined);
		expect(emit.mock.calls).toEqual(expected);
	});

	it("balances the signal on throw", async () => {
		const { pi, emit } = fakePi();
		await expect(
			withBlockedSignal(pi, "waiting", async () => {
				throw new Error("failed");
			}),
		).rejects.toThrow("failed");
		expect(emit.mock.calls).toEqual(expected);
	});

	it("balances the signal on abort", async () => {
		const { pi, emit } = fakePi();
		const controller = new AbortController();
		const result = withBlockedSignal(
			pi,
			"waiting",
			() =>
				new Promise((_resolve, reject) => {
					controller.signal.addEventListener("abort", () => reject(controller.signal.reason));
				}),
		);
		controller.abort(new Error("cancelled"));
		await expect(result).rejects.toThrow("cancelled");
		expect(emit.mock.calls).toEqual(expected);
	});
});
