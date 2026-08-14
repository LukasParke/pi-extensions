/**
 * Workflow configuration.
 *
 * Turn and time budgets have ceilings because they bound runaway loops
 * without pricing assumptions. Cost budgets are different: what an agent
 * should be allowed to spend is a pricing decision only the user can make, so
 * `agentMaxCost` has no default — unset means no cost ceiling at all. The
 * default model is likewise left unset — "inherit whatever the parent session
 * uses" — rather than hardcoding a model that may not exist for the
 * installing user.
 */

import { boolean, load, nonEmptyString, number, oneOf, type Schema } from "@parke.dev/pi-ext-config";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const PROFILES = ["explore", "review", "general"] as const;
const APPROVAL_MODES = ["auto", "always", "never"] as const;
const SIZES = ["small", "medium", "large", "unrestricted"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type Profile = (typeof PROFILES)[number];
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export type WorkflowSize = (typeof SIZES)[number];

export interface WorkflowConfig {
	/**
	 * Model for `agent()` calls that do not name one. Unset means inherit the
	 * parent session's model, which is the only portable default.
	 */
	defaultModel?: string;
	defaultThinking: ThinkingLevel;
	defaultProfile: Profile;
	/** Per-agent ceilings. A runaway script must not be able to loop unbounded. */
	agentMaxTurns: number;
	/**
	 * Per-agent cost ceiling. Unset by default: when undefined, `agent()` calls
	 * get no cost ceiling and script-supplied `maxCost` passes through unclamped
	 * (still validated ≥ 0). When set, it is both the default for calls that omit
	 * `maxCost` and the clamp for calls that set it higher.
	 */
	agentMaxCost?: number;
	agentTimeoutMs: number;
	/** Whole-run ceilings. */
	workflowTimeoutMs: number;
	maxAgentRequests: number;
	maxConcurrency: number;
	/**
	 * Launch approval:
	 * - `auto` — prompt in interactive UI; fail closed without UI
	 * - `always` — always require UI confirm (fail closed without UI)
	 * - `never` — skip approval (trusted automation only)
	 */
	approval: ApprovalMode;
	/** When true, tool launches return immediately and run in the background. */
	backgroundByDefault: boolean;
	/** Advisory size guideline injected into Ultracode policy. */
	defaultSize: WorkflowSize;
	/** Warn when a run's agent budget exceeds this (still subject to hard cap). */
	largeRunWarnAgents: number;
}

export const defaultConfig: WorkflowConfig = {
	defaultThinking: "medium",
	defaultProfile: "explore",
	agentMaxTurns: 20,
	agentTimeoutMs: 10 * 60_000,
	workflowTimeoutMs: 45 * 60_000,
	maxAgentRequests: 32,
	maxConcurrency: 4,
	approval: "auto",
	backgroundByDefault: true,
	defaultSize: "medium",
	largeRunWarnAgents: 15,
};

export const schema: Schema<WorkflowConfig> = {
	defaultModel: { validate: nonEmptyString, env: "PI_WORKFLOW_MODEL" },
	defaultThinking: { validate: oneOf(THINKING_LEVELS), env: "PI_WORKFLOW_THINKING" },
	defaultProfile: { validate: oneOf(PROFILES), env: "PI_WORKFLOW_PROFILE" },
	agentMaxTurns: { validate: number(1), env: "PI_WORKFLOW_AGENT_MAX_TURNS" },
	agentMaxCost: { validate: number(0), env: "PI_WORKFLOW_AGENT_MAX_COST" },
	agentTimeoutMs: { validate: number(10_000), env: "PI_WORKFLOW_AGENT_TIMEOUT_MS" },
	workflowTimeoutMs: { validate: number(60_000), env: "PI_WORKFLOW_TIMEOUT_MS" },
	// Hard-capped: the sandbox enforces these, and raising them without bound
	// turns one tool call into an unbounded fan-out of paid agents.
	maxAgentRequests: { validate: number(1, 200), env: "PI_WORKFLOW_MAX_AGENTS" },
	maxConcurrency: { validate: number(1, 16), env: "PI_WORKFLOW_MAX_CONCURRENCY" },
	approval: { validate: oneOf(APPROVAL_MODES), env: "PI_WORKFLOW_APPROVAL" },
	backgroundByDefault: { validate: boolean, env: "PI_WORKFLOW_BACKGROUND" },
	defaultSize: { validate: oneOf(SIZES), env: "PI_WORKFLOW_SIZE" },
	largeRunWarnAgents: { validate: number(1, 200), env: "PI_WORKFLOW_LARGE_WARN" },
};

let cached: Promise<WorkflowConfig> | undefined;

export function workflowConfig(): Promise<WorkflowConfig> {
	cached ??= load({ name: "workflow", schema, defaults: defaultConfig }).then((r) => r.config);
	return cached;
}

export function resetConfigCache(): void {
	cached = undefined;
}

export const THINKING = new Set<string>(THINKING_LEVELS);
export const VALID_PROFILES = new Set<string>(PROFILES);
export const VALID_SIZES = new Set<string>(SIZES);

/** Advisory generation targets for Ultracode — not hard limits. */
export const SIZE_GUIDELINES: Record<WorkflowSize, { agents: number; label: string }> = {
	small: { agents: 5, label: "prefer under 5 agent calls" },
	medium: { agents: 15, label: "prefer under 15 agent calls" },
	large: { agents: 50, label: "prefer under 50 agent calls" },
	unrestricted: { agents: Number.POSITIVE_INFINITY, label: "no generation target (hard cap still applies)" },
};
