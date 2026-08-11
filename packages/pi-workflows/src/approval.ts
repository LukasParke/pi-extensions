/**
 * Launch approval gate.
 *
 * The model cannot self-approve: there is no `approved` tool parameter. Without
 * an interactive UI the gate fails closed unless config.approval is "never" or
 * the saved workflow is marked preApproved under trusted configuration.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowConfig } from "./config.ts";

export interface ApprovalRequest {
	label: string;
	description?: string;
	scriptPreview: string;
	maxAgentRequests: number;
	maxConcurrency: number;
	agentMaxCost: number;
	agentMaxTurns: number;
	workflowTimeoutMs: number;
	writersPossible: boolean;
	savedName?: string;
	/** Trusted config / saved-workflow pre-approval. */
	preApproved?: boolean;
}

export type ApprovalDecision = { ok: true } | { ok: false; reason: string };

export async function requestLaunchApproval(options: {
	config: WorkflowConfig;
	request: ApprovalRequest;
	ctx: ExtensionContext;
}): Promise<ApprovalDecision> {
	const { config, request, ctx } = options;

	if (request.preApproved) return { ok: true };
	if (config.approval === "never") return { ok: true };

	const needsUi = config.approval === "always" || config.approval === "auto";
	if (needsUi && !ctx.hasUI) {
		return {
			ok: false,
			reason:
				'Workflow approval required but no interactive UI is available. Set workflow.approval to "never" in trusted config, or run interactively.',
		};
	}

	const lines = [
		request.description ?? request.label,
		request.savedName ? `saved: ${request.savedName}` : "inline script",
		`max agents: ${request.maxAgentRequests} · concurrency: ${request.maxConcurrency}`,
		`per-agent: ≤${request.agentMaxTurns} turns · ≤$${request.agentMaxCost} · timeout ${Math.round(request.workflowTimeoutMs / 60000)}m workflow`,
		request.writersPossible
			? "writers: allowed (workflow-owned worktree)"
			: "writers: read-only profiles only",
		"",
		"Script preview:",
		truncate(request.scriptPreview, 1200),
	].join("\n");

	const confirmed = await ctx.ui.confirm("Run workflow?", lines);
	if (!confirmed) return { ok: false, reason: "User declined workflow launch" };
	return { ok: true };
}

function truncate(text: string, max: number) {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}…`;
}
