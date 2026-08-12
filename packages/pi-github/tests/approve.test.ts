import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPROVE_REFUSAL, approveRefusal } from "../src/approve.ts";
import { GitHubClient } from "../src/client.ts";

const resolveToken = vi.hoisted(() =>
	vi.fn(async () => ({ token: "t", source: "env" as const, detail: "test token" })),
);

vi.mock("../src/auth.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/auth.ts")>();
	return { ...actual, resolveToken };
});

import github from "../extensions/index.ts";

interface ToolResult {
	content: { type: "text"; text: string }[];
	details: { refused?: boolean; posted?: boolean; state?: string };
}

interface ReviewTool {
	execute(
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<ToolResult>;
}

function harness() {
	const tools = new Map<string, ReviewTool>();
	github({
		registerTool: (tool: ReviewTool & { name: string }) => tools.set(tool.name, tool),
		registerCommand: () => undefined,
	} as unknown as ExtensionAPI);
	return {
		review: (params: Record<string, unknown>) =>
			tools.get("github_review")!.execute("id", params, new AbortController().signal, undefined, {
				cwd: "/tmp",
				hasUI: false,
			} as ExtensionContext),
	};
}

const posted = {
	data: { url: "https://github.com/o/r/pull/7#review", state: "COMMENTED" },
	rate: { remaining: 4000, limit: 5000, resetAt: null },
};

describe("approveRefusal", () => {
	it("lets comment and request_changes through", () => {
		expect(approveRefusal({ event: "comment" })).toBeUndefined();
		expect(approveRefusal({ event: "request_changes" })).toBeUndefined();
		expect(approveRefusal({})).toBeUndefined();
	});

	it("refuses approve unless lukeApproved and yes are both set", () => {
		expect(approveRefusal({ event: "approve" })).toBe(APPROVE_REFUSAL);
		expect(approveRefusal({ event: "approve", lukeApproved: true })).toBe(APPROVE_REFUSAL);
		expect(approveRefusal({ event: "approve", yes: true })).toBe(APPROVE_REFUSAL);
		expect(approveRefusal({ event: "approve", lukeApproved: true, yes: true })).toBeUndefined();
	});

	it("names LukasParke so the refuse cannot be read as an agent vote", () => {
		expect(APPROVE_REFUSAL).toContain("LukasParke");
		expect(APPROVE_REFUSAL).toContain("lukeApproved: true");
	});
});

describe("github_review approve gate", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		resolveToken.mockClear();
	});

	it("refuses approve without lukeApproved and does not call GitHub", async () => {
		const review = vi.spyOn(GitHubClient.prototype, "review").mockResolvedValue(posted);
		const result = await harness().review({
			number: 7,
			event: "approve",
			repo: "o/r",
			yes: true,
		});
		expect(result.content[0]?.text).toBe(APPROVE_REFUSAL);
		expect(result.details.refused).toBe(true);
		expect(review).not.toHaveBeenCalled();
		expect(resolveToken).not.toHaveBeenCalled();
	});

	it("still posts a comment review", async () => {
		const review = vi.spyOn(GitHubClient.prototype, "review").mockResolvedValue(posted);
		const result = await harness().review({
			number: 7,
			event: "comment",
			body: "looks fine",
			repo: "o/r",
			yes: true,
		});
		expect(result.details.refused).toBeUndefined();
		expect(result.details.posted).toBe(true);
		expect(review).toHaveBeenCalledWith({ owner: "o", name: "r", slug: "o/r" }, 7, "COMMENT", "looks fine");
	});

	it("reaches the client when Luke opts in to approve", async () => {
		const review = vi.spyOn(GitHubClient.prototype, "review").mockResolvedValue({
			...posted,
			data: { ...posted.data, state: "APPROVED" },
		});
		const result = await harness().review({
			number: 7,
			event: "approve",
			repo: "o/r",
			lukeApproved: true,
			yes: true,
		});
		expect(result.details.posted).toBe(true);
		expect(result.details.state).toBe("APPROVED");
		expect(review).toHaveBeenCalledWith({ owner: "o", name: "r", slug: "o/r" }, 7, "APPROVE", "");
	});
});
