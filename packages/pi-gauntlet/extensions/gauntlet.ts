/**
 * Gauntlet — a goal/check loop for pi.
 *
 * The user (or the model) sets a goal plus a gauntlet of named shell checks
 * that must all exit 0. After each agent run settles, the extension runs the
 * gauntlet; failures are injected back into the conversation as a follow-up
 * message and the agent keeps iterating until the whole gauntlet passes,
 * `maxIterations` is hit, or the loop is stopped.
 *
 * Design decisions:
 *
 * - **Exit-0 shell checks, nothing fancier.** Tests, typecheck, lint, a
 *   curl against a dev server — every project already has these as commands,
 *   so there is nothing new to learn or configure per project.
 * - **followUp injection.** `deliverAs: "followUp"` waits for the agent to
 *   finish its current work before the failure report lands, so the report
 *   never interrupts a turn mid-tool-call; `triggerTurn` then starts the next
 *   iteration immediately.
 * - **Session-scoped checks.** Checks live in session entries
 *   (`gauntlet-state`), not on disk, so branching/resuming a session carries
 *   the loop with it and nothing leaks between projects. A project may seed
 *   initial checks via `.pi/gauntlet.json`, but only in trusted projects —
 *   this extension runs arbitrary shell commands automatically.
 * - **The engine is pure** (`src/loop.ts`): exec, persistence, and UI are
 *   injected hooks, so the whole state machine is unit-tested without pi.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { truncateTail, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { defaultConfig, gauntletConfig } from "../src/config.ts";
import { GauntletEngine, type CheckExecResult, type GauntletState } from "../src/loop.ts";
import { parseCheckArgs, parseSeedChecks, parseStateEntry } from "../src/parse.ts";
import { checkListText, statusText, widgetLines } from "../src/report.ts";

const ENTRY_TYPE = "gauntlet-state";

const gauntletParams = Type.Object(
	{
		action: StringEnum(["start", "stop", "status", "add_check", "remove_check", "run"] as const),
		goal: Type.Optional(
			Type.String({ description: "Goal text. Required for start unless one is already set." }),
		),
		name: Type.Optional(Type.String({ description: "Check name, for add_check/remove_check." })),
		command: Type.Optional(Type.String({ description: "Shell command for the check, for add_check." })),
	},
	{ additionalProperties: false },
);
/** Per-check output kept in state and reports; tails are what matter for failures. */
const OUTPUT_TAIL_BYTES = 2_048;

export default function (pi: ExtensionAPI) {
	let engine: GauntletEngine | undefined;
	let maxIterations = defaultConfig.maxIterations;
	let lastCtx: ExtensionContext | undefined;

	function updateWidget(): void {
		if (!lastCtx?.hasUI) return;
		if (!engine?.state.active) {
			lastCtx.ui.setWidget("gauntlet", undefined);
			return;
		}
		lastCtx.ui.setWidget("gauntlet", widgetLines(engine.state, maxIterations));
	}

	function notify(message: string, type?: "info" | "warning" | "error"): void {
		if (lastCtx?.hasUI) lastCtx.ui.notify(message, type);
	}

	const execAdapter = async (command: string, timeoutMs: number): Promise<CheckExecResult> => {
		const result = await pi.exec("bash", ["-lc", command], { timeout: timeoutMs, cwd: lastCtx?.cwd });
		return {
			stdout: truncateTail(result.stdout, { maxBytes: OUTPUT_TAIL_BYTES }).content,
			stderr: truncateTail(result.stderr, { maxBytes: OUTPUT_TAIL_BYTES }).content,
			code: result.code,
		};
	};

	function restoreState(ctx: ExtensionContext): GauntletState | undefined {
		let state: GauntletState | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
				state = parseStateEntry(entry.data) ?? state;
			}
		}
		return state;
	}

	async function seedState(ctx: ExtensionContext): Promise<GauntletState | undefined> {
		if (!ctx.isProjectTrusted()) return undefined;
		try {
			const checks = parseSeedChecks(
				JSON.parse(await readFile(join(ctx.cwd, ".pi", "gauntlet.json"), "utf8")),
			);
			if (!checks) return undefined;
			return { active: false, iteration: 0, checks, results: {} };
		} catch {
			return undefined;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		const config = await gauntletConfig();
		maxIterations = config.maxIterations;
		engine = new GauntletEngine(
			{
				maxIterations: config.maxIterations,
				checkTimeoutMs: config.checkTimeoutMs,
				exec: execAdapter,
				hooks: {
					persist: (state) => pi.appendEntry(ENTRY_TYPE, state),
					error: (message) => notify(message, "error"),
					success: (state) => {
						notify(`Gauntlet passed — goal achieved after ${state.iteration} iteration(s).`, "info");
					},
					exhausted: (state) => {
						notify(
							`Gauntlet gave up after ${state.iteration} iterations with checks still failing. ` +
								`Fix manually or /goal stop and re-scope the goal.`,
							"error",
						);
					},
					inject: (report) => {
						pi.sendMessage(
							{ customType: "gauntlet", content: report, display: true },
							{ triggerTurn: true, deliverAs: "followUp" },
						);
					},
					changed: () => updateWidget(),
				},
			},
			restoreState(ctx) ?? (await seedState(ctx)),
		);
		updateWidget();
	});

	pi.on("agent_settled", async (_event, ctx) => {
		lastCtx = ctx;
		if (!ctx.isIdle()) return;
		await engine?.settle();
	});

	pi.registerCommand("gauntlet", {
		description: "Manage gauntlet checks: /gauntlet [add <name> <command…> | rm <name>]",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			if (!engine) {
				notify("Gauntlet is not initialized yet.", "warning");
				return;
			}
			const trimmed = args.trim();
			if (!trimmed) {
				notify(checkListText(engine.state));
				return;
			}
			if (trimmed.startsWith("add ")) {
				const parsed = parseCheckArgs(trimmed.slice(4));
				if (!parsed) {
					notify("Usage: /gauntlet add <name> <command…>", "warning");
					return;
				}
				engine.addCheck(parsed.name, parsed.command);
				notify(`Check "${parsed.name}" saved.`);
				return;
			}
			if (trimmed.startsWith("rm ")) {
				const name = trimmed.slice(3).trim();
				notify(engine.removeCheck(name) ? `Check "${name}" removed.` : `No check named "${name}".`, "info");
				return;
			}
			notify("Usage: /gauntlet [add <name> <command…> | rm <name>]", "warning");
		},
	});

	pi.registerCommand("goal", {
		description: "Set a goal and run the gauntlet loop: /goal <text> | stop | status",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			if (!engine) {
				notify("Gauntlet is not initialized yet.", "warning");
				return;
			}
			const trimmed = args.trim();
			if (trimmed === "stop") {
				engine.stop();
				notify("Gauntlet loop stopped.");
				return;
			}
			if (trimmed === "status" || !trimmed) {
				notify(statusText(engine.state, maxIterations));
				return;
			}
			if (engine.state.checks.length === 0) {
				notify("No gauntlet checks defined — add one first with /gauntlet add <name> <command…>.", "warning");
				return;
			}
			engine.start(trimmed);
			notify(`Goal set — gauntlet loop running with ${engine.state.checks.length} check(s).`);
		},
	});

	pi.registerTool({
		name: "gauntlet",
		label: "Gauntlet",
		description:
			"Drive the goal/gauntlet loop: named shell checks that must all exit 0. " +
			"start sets a goal and, after each agent run, runs every check and injects failures back until all pass, " +
			"max iterations are hit, or stop is called. run executes the checks once and returns results without starting the loop. " +
			"Use when the user asks you to keep working until tests/lint/typecheck pass.",
		promptSnippet: "Iterate toward a goal until named shell checks all pass",
		parameters: gauntletParams,
		async execute(_id, params: Static<typeof gauntletParams>, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			if (!engine) {
				return {
					content: [{ type: "text" as const, text: "Gauntlet is not initialized yet." }],
					details: {},
				};
			}
			const text = (t: string, details: Record<string, unknown> = {}) => ({
				content: [{ type: "text" as const, text: t }],
				details,
			});
			switch (params.action) {
				case "add_check": {
					const name = params.name?.trim();
					const command = params.command?.trim();
					if (!name || !command) return text("add_check needs both name and command.");
					engine.addCheck(name, command);
					return text(`Check "${name}" saved.`);
				}
				case "remove_check": {
					const name = params.name?.trim();
					if (!name) return text("remove_check needs a name.");
					return text(engine.removeCheck(name) ? `Check "${name}" removed.` : `No check named "${name}".`);
				}
				case "start": {
					const goal = params.goal?.trim() || engine.state.goal;
					if (!goal) return text("start needs a goal — pass one, or set one first.");
					if (engine.state.checks.length === 0) {
						return text("No gauntlet checks defined. Add checks with add_check before starting the loop.");
					}
					engine.start(goal);
					return text(
						`Gauntlet started. After each run, ${engine.state.checks.length} check(s) must exit 0; ` +
							`failures come back to you until they pass or ${maxIterations} iterations are hit.`,
					);
				}
				case "stop": {
					engine.stop();
					return text("Gauntlet loop stopped.");
				}
				case "status": {
					return text(statusText(engine.state, maxIterations), { state: engine.state });
				}
				case "run": {
					if (engine.state.checks.length === 0) return text("No gauntlet checks defined.");
					const results = await engine.runChecks();
					const lines: string[] = [];
					let passed = true;
					for (const check of engine.state.checks) {
						const outcome = results[check.name]!;
						if (outcome.code !== 0) passed = false;
						lines.push(`${outcome.code === 0 ? "✓" : "✗"} ${check.name} (exit ${outcome.code})`);
						const output = truncateTail(outcome.output, { maxBytes: OUTPUT_TAIL_BYTES }).content.trim();
						if (outcome.code !== 0 && output) lines.push("```", output, "```");
					}
					return text(lines.join("\n"), { passed, results });
				}
				default:
					return text(`Unknown action "${String(params.action)}".`);
			}
		},
	});
}
