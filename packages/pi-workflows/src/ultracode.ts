/**
 * Ultracode — thin policy layer: xhigh thinking + workflow consideration.
 *
 * One-shot interactive keyword + session /ultracode on|off|status.
 * Does not invent a new model or Pi core effort level.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowConfig, WorkflowSize } from "./config.ts";
import { SIZE_GUIDELINES } from "./config.ts";

const ULTRACODE_RE = /^\s*ultracode\b[:\s-]*/i;

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

export interface UltracodeState {
	sessionEnabled: boolean;
	oneShot: boolean;
	previousThinking?: ThinkingLevel;
	size: WorkflowSize;
}

export function createUltracodeState(defaultSize: WorkflowSize): UltracodeState {
	return { sessionEnabled: false, oneShot: false, size: defaultSize };
}

export function isUltracodeActive(state: UltracodeState) {
	return state.sessionEnabled || state.oneShot;
}

export function ultracodePolicyText(config: WorkflowConfig, size: WorkflowSize) {
	const guide = SIZE_GUIDELINES[size] ?? SIZE_GUIDELINES[config.defaultSize];
	return [
		"Ultracode is active.",
		"For each substantive task, determine whether a dynamic workflow is warranted.",
		"Use the workflow tool when control flow depends on runtime discoveries, independent verification, iterative repair, or broad fan-out.",
		"Do not use it for fixed small task lists or routine edits — prefer the subagent tool's tasks array there.",
		`Size guideline (${size}): ${guide.label}. Hard cap remains ${config.maxAgentRequests} agents / concurrency ${config.maxConcurrency}.`,
		`Warn the user before launching runs that may exceed ~${config.largeRunWarnAgents} agents.`,
		"Prefer structured args and saved workflow names over huge inline scripts when a definition already exists.",
	].join(" ");
}

export function registerUltracode(pi: ExtensionAPI, state: UltracodeState, config: WorkflowConfig) {
	pi.on("input", (event) => {
		// Only direct interactive input — never RPC, extension, or agent-injected text.
		if (event.source !== "interactive") return { action: "continue" as const };
		if (!ULTRACODE_RE.test(event.text)) return { action: "continue" as const };
		state.oneShot = true;
		if (!state.sessionEnabled) {
			state.previousThinking = pi.getThinkingLevel();
			pi.setThinkingLevel("xhigh");
		}
		const text = event.text.replace(ULTRACODE_RE, "").trim();
		return {
			action: "transform" as const,
			text: text || "Decide whether a dynamic workflow is warranted for the task I am about to describe.",
		};
	});

	pi.on("before_agent_start", (event) => {
		if (!isUltracodeActive(state)) return;
		const active = isUltracodeActive(state);
		// Consume one-shot after this turn's policy injection is prepared.
		if (state.oneShot && !state.sessionEnabled) {
			// Keep oneShot true through the turn; clear on agent_end.
		}
		if (!active) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${ultracodePolicyText(config, state.size)}`,
		};
	});

	pi.on("agent_end", () => {
		if (state.oneShot && !state.sessionEnabled) {
			state.oneShot = false;
			restoreThinking(pi, state);
		}
	});

	pi.registerCommand("ultracode", {
		description: "Ultracode mode: on | off | status",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const cmd = (parts[0] ?? "status").toLowerCase();

			if (cmd === "on") {
				if (!state.sessionEnabled) {
					state.previousThinking ??= pi.getThinkingLevel();
					pi.setThinkingLevel("xhigh");
				}
				state.sessionEnabled = true;
				state.oneShot = false;
				if (parts[1] && SIZE_GUIDELINES[parts[1] as WorkflowSize]) {
					state.size = parts[1] as WorkflowSize;
				}
				ctx.ui.notify(
					`Ultracode on (thinking xhigh, size ${state.size}). Prefix a prompt with "ultracode" for one-shot.`,
					"info",
				);
				return;
			}

			if (cmd === "off") {
				state.sessionEnabled = false;
				state.oneShot = false;
				restoreThinking(pi, state);
				ctx.ui.notify("Ultracode off", "info");
				return;
			}

			if (cmd === "status") {
				const mode = state.sessionEnabled ? "session on" : state.oneShot ? "one-shot pending" : "off";
				ctx.ui.notify(`Ultracode: ${mode} · thinking ${pi.getThinkingLevel()} · size ${state.size}`, "info");
				return;
			}

			if (cmd === "size" && parts[1] && SIZE_GUIDELINES[parts[1] as WorkflowSize]) {
				state.size = parts[1] as WorkflowSize;
				ctx.ui.notify(`Ultracode size → ${state.size}`, "info");
				return;
			}

			ctx.ui.notify(
				"Usage: /ultracode on [size] | off | status | size <small|medium|large|unrestricted>",
				"info",
			);
		},
	});
}

function restoreThinking(pi: ExtensionAPI, state: UltracodeState) {
	if (state.previousThinking !== undefined) {
		pi.setThinkingLevel(state.previousThinking);
		state.previousThinking = undefined;
	}
}

/** Call when enabling session mode from outside the command (tests). */
export function enableUltracodeSession(pi: ExtensionAPI, state: UltracodeState) {
	if (!state.sessionEnabled) {
		state.previousThinking = pi.getThinkingLevel();
		pi.setThinkingLevel("xhigh");
	}
	state.sessionEnabled = true;
	state.oneShot = false;
}

export function disableUltracodeSession(pi: ExtensionAPI, state: UltracodeState) {
	state.sessionEnabled = false;
	state.oneShot = false;
	restoreThinking(pi, state);
}
