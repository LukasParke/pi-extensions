import { describe, expect, it } from "vitest";
import { createSessionCostCache, emptySessionCost, sessionCost } from "../src/cost.ts";

describe("sessionCost", () => {
	it("starts empty", () => {
		expect(sessionCost([])).toEqual(emptySessionCost());
	});

	it("sums assistant usage", () => {
		const totals = sessionCost([
			{
				type: "message",
				id: "a1",
				message: {
					role: "assistant",
					usage: {
						input: 100,
						output: 50,
						cacheRead: 10,
						cacheWrite: 5,
						cost: { total: 0.12 },
					},
				},
			},
			{
				type: "message",
				id: "a2",
				message: {
					role: "assistant",
					usage: {
						input: 20,
						output: 30,
						cost: { total: 0.03 },
					},
				},
			},
		]);
		expect(totals.input).toBe(120);
		expect(totals.output).toBe(80);
		expect(totals.cacheRead).toBe(10);
		expect(totals.cacheWrite).toBe(5);
		expect(totals.cost).toBeCloseTo(0.15);
	});

	it("includes toolResult usage", () => {
		const totals = sessionCost([
			{
				type: "message",
				id: "t1",
				message: {
					role: "toolResult",
					usage: { input: 0, output: 0, cost: { total: 1.5 } },
				},
			},
		]);
		expect(totals.cost).toBe(1.5);
	});

	it("includes compaction and branch_summary usage", () => {
		const totals = sessionCost([
			{
				type: "compaction",
				id: "c1",
				usage: { input: 1, output: 2, cost: { total: 0.05 } },
			},
			{
				type: "branch_summary",
				id: "b1",
				usage: { input: 3, output: 4, cost: { total: 0.07 } },
			},
		]);
		expect(totals.input).toBe(4);
		expect(totals.output).toBe(6);
		expect(totals.cost).toBeCloseTo(0.12);
	});

	it("ignores user messages and entries without usage", () => {
		const totals = sessionCost([
			{ type: "message", id: "u", message: { role: "user" } },
			{ type: "model_change", id: "m" },
			{ type: "message", id: "tr", message: { role: "toolResult" } },
		]);
		expect(totals).toEqual(emptySessionCost());
	});

	it("folds the full set together", () => {
		const totals = sessionCost([
			{
				type: "message",
				message: { role: "assistant", usage: { cost: { total: 1 } } },
			},
			{
				type: "message",
				message: { role: "toolResult", usage: { cost: { total: 2 } } },
			},
			{ type: "compaction", usage: { cost: { total: 3 } } },
			{ type: "branch_summary", usage: { cost: { total: 4 } } },
		]);
		expect(totals.cost).toBe(10);
	});
});

describe("createSessionCostCache", () => {
	it("memoizes by length + last id", () => {
		const cache = createSessionCostCache();
		const entries = [
			{
				id: "1",
				type: "message",
				message: { role: "assistant", usage: { cost: { total: 1 } } },
			},
		];
		const first = cache.get(entries);
		entries[0]!.message.usage.cost.total = 99;
		const second = cache.get(entries);
		expect(second.cost).toBe(1);
		expect(second).toBe(first);

		const grown = [
			...entries,
			{
				id: "2",
				type: "message",
				message: { role: "assistant", usage: { cost: { total: 1 } } },
			},
		];
		expect(cache.get(grown).cost).toBe(100);
	});
});
