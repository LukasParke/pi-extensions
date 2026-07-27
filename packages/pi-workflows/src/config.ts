/**
 * Workflow configuration.
 *
 * Defaults are deliberately conservative: a workflow spawns child agents that
 * cost real money, so every budget has a ceiling and the default model is left
 * unset — meaning "inherit whatever the parent session uses" — rather than
 * hardcoding a model that may not exist for the installing user.
 */

import { load, nonEmptyString, number, oneOf, type Schema } from "@parke.dev/pi-ext-config";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const PROFILES = ["explore", "review", "general"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type Profile = (typeof PROFILES)[number];

export interface WorkflowConfig {
	/**
	 * Model for `agent()` calls that do not name one. Unset means inherit the
	 * parent session's model, which is the only portable default.
	 */
	defaultModel?: string;
	defaultThinking: ThinkingLevel;
	defaultProfile: Profile;
	/** Per-agent ceilings. A runaway script must not be able to spend unbounded. */
	agentMaxTurns: number;
	agentMaxCost: number;
	agentTimeoutMs: number;
	/** Whole-run ceilings. */
	workflowTimeoutMs: number;
	maxAgentRequests: number;
	maxConcurrency: number;
}

export const defaultConfig: WorkflowConfig = {
	defaultThinking: "medium",
	defaultProfile: "explore",
	agentMaxTurns: 20,
	agentMaxCost: 0.5,
	agentTimeoutMs: 10 * 60_000,
	workflowTimeoutMs: 45 * 60_000,
	maxAgentRequests: 32,
	maxConcurrency: 4,
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
