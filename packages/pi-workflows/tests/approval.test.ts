import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requestLaunchApproval } from "../src/approval.ts";
import { defaultConfig } from "../src/config.ts";

function ctx(hasUI: boolean, confirmResult = true): ExtensionContext {
	return {
		hasUI,
		ui: {
			confirm: vi.fn(async () => confirmResult),
		},
	} as unknown as ExtensionContext;
}

const request = {
	label: "test",
	scriptPreview: "return 1",
	maxAgentRequests: 32,
	maxConcurrency: 4,
	agentMaxCost: 0.5,
	agentMaxTurns: 20,
	workflowTimeoutMs: 60_000,
	writersPossible: false,
};

describe("approval gate", () => {
	it("fails closed without UI when approval is auto", async () => {
		const decision = await requestLaunchApproval({
			config: { ...defaultConfig, approval: "auto" },
			request,
			ctx: ctx(false),
		});
		expect(decision.ok).toBe(false);
	});

	it("cannot be model-self-approved — only preApproved trusted flag", async () => {
		const decision = await requestLaunchApproval({
			config: { ...defaultConfig, approval: "always" },
			request: { ...request, preApproved: true },
			ctx: ctx(false),
		});
		expect(decision.ok).toBe(true);
	});

	it("prompts when UI is available", async () => {
		const c = ctx(true, true);
		const decision = await requestLaunchApproval({
			config: { ...defaultConfig, approval: "auto" },
			request,
			ctx: c,
		});
		expect(decision.ok).toBe(true);
		expect(c.ui.confirm).toHaveBeenCalled();
	});

	it("honors user decline", async () => {
		const decision = await requestLaunchApproval({
			config: { ...defaultConfig, approval: "auto" },
			request,
			ctx: ctx(true, false),
		});
		expect(decision.ok).toBe(false);
	});
});
