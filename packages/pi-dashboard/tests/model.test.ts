import { describe, expect, it } from "vitest";
import {
	createStreamTracker,
	estimateContentTokens,
	formatModelLabel,
	emptyModelSnapshot,
} from "../src/model.ts";

describe("estimateContentTokens", () => {
	it("ceil-divides by 4", () => {
		expect(estimateContentTokens(0)).toBe(0);
		expect(estimateContentTokens(1)).toBe(1);
		expect(estimateContentTokens(4)).toBe(1);
		expect(estimateContentTokens(5)).toBe(2);
	});
});

describe("createStreamTracker", () => {
	it("returns null on the first delta", () => {
		const t = createStreamTracker();
		expect(t.onContentDelta("hello", 1000)).toBeNull();
		expect(t.tokensPerSecond).toBeNull();
	});

	it("keeps the previous rate inside the live throttle window", () => {
		const t = createStreamTracker();
		t.onContentDelta("aaaa", 0);
		const rate = t.onContentDelta("bbbbbbbb", 250);
		expect(rate).not.toBeNull();
		// Another delta within LIVE_UPDATE_INTERVAL_MS must not recompute.
		expect(t.onContentDelta("cccc", 300)).toBe(rate);
	});

	it("computes live tok/s after throttle window", () => {
		const t = createStreamTracker();
		t.onContentDelta("aaaa", 0); // first chunk excluded from rate
		const rate = t.onContentDelta("bbbbbbbb", 250); // 8 chars / 0.25s = 8 tokens/s estimate
		expect(rate).not.toBeNull();
		expect(rate!).toBeCloseTo(estimateContentTokens(8) / 0.25);
	});

	it("averages across a run on endMessage", () => {
		const t = createStreamTracker();
		t.onContentDelta("xxxx", 0);
		t.onContentDelta("yyyyyyyy", 200);
		const finalRate = t.endMessage({ outputTokens: 20, now: 200 });
		expect(finalRate).not.toBeNull();
		// streamed tokens = max(0, 20 - estimate(4)) = 19 over 200ms
		expect(finalRate!).toBeCloseTo(19 / 0.2);
	});

	it("ignores sub-50ms bursts on endMessage", () => {
		const t = createStreamTracker();
		t.onContentDelta("aa", 0);
		t.onContentDelta("bb", 10);
		expect(t.endMessage({ outputTokens: 10, now: 10 })).toBeNull();
	});

	it("resetRun clears tok/s", () => {
		const t = createStreamTracker();
		t.onContentDelta("aaaa", 0);
		t.onContentDelta("bbbbbbbb", 250);
		expect(t.tokensPerSecond).not.toBeNull();
		t.resetRun();
		expect(t.tokensPerSecond).toBeNull();
	});
});

describe("formatModelLabel", () => {
	it("handles empty and thinking", () => {
		expect(formatModelLabel(emptyModelSnapshot())).toBe("no model");
		expect(
			formatModelLabel({
				...emptyModelSnapshot(),
				provider: "p",
				modelId: "m",
				thinking: "off",
			}),
		).toBe("p/m");
	});
});
