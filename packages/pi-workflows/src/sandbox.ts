/**
 * Host side of the workflow sandbox.
 *
 * Spawns lib/workflow-child.cjs under Node permission mode, ships it the
 * model-authored source over an authenticated IPC channel, and services its
 * `agent()` / `phase()` requests. Every message is validated: wrong token,
 * unknown kind, oversized payload or duplicate request id kills the run.
 *
 * The sandbox constrains the *orchestration script*. What each `agent()` call
 * is allowed to do is decided by the caller's `onAgent` handler — in this setup
 * that routes through the `subagent` tool, so children inherit worktree
 * isolation, budgets, profiles and capability gating rather than running with
 * ambient parent permissions.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_ARGS_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_AGENT_MESSAGE_BYTES = 512 * 1024;
const MAX_PHASE_BYTES = 4096;
/** Hard ceiling on agent calls per workflow run. */
export const MAX_AGENT_REQUESTS = 32;
/** Hard ceiling on concurrent agent calls inside parallel(). */
export const MAX_CONCURRENCY = 4;

export interface AgentRequestOptions {
	label?: unknown;
	phase?: unknown;
	schema?: unknown;
	model?: unknown;
	thinking?: unknown;
	profile?: unknown;
}

export interface AgentRunResult {
	ok: boolean;
	output: string;
	structured?: unknown;
	error?: string;
}

export interface SandboxOptions {
	source: string;
	args: unknown;
	cwd: string;
	signal: AbortSignal;
	/** Max agent() calls per run. Defaults to MAX_AGENT_REQUESTS. */
	maxAgentRequests?: number;
	/** Max concurrent agents inside parallel(). Defaults to MAX_CONCURRENCY. */
	maxConcurrency?: number;
	onAgent: (prompt: string, options: AgentRequestOptions, signal: AbortSignal) => Promise<AgentRunResult>;
	onPhase: (title: string) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const bytes = (value: string) => Buffer.byteLength(value, "utf8");

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Bounded JSON: refuse cycles, huge strings and pathological nesting. */
export function safeStringify(value: unknown, maxBytes: number): string {
	const seen = new WeakSet<object>();
	const json = JSON.stringify(value, (_key, item) => {
		if (typeof item === "bigint") return `${item}n`;
		if (typeof item === "string" && item.length > 128 * 1024) return `${item.slice(0, 128 * 1024)}…`;
		if (item && typeof item === "object") {
			if (seen.has(item as object)) return "[circular]";
			seen.add(item as object);
		}
		return item;
	});
	const out = json ?? "null";
	if (bytes(out) > maxBytes) throw new Error(`value exceeds the ${maxBytes} byte workflow IPC limit`);
	return out;
}

function terminate(child: ChildProcess): void {
	if (child.exitCode !== null || child.signalCode !== null) return;
	try {
		child.kill("SIGTERM");
	} catch {
		/* gone */
	}
	const force = setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) {
			try {
				child.kill("SIGKILL");
			} catch {
				/* gone */
			}
		}
	}, 1_000);
	force.unref?.();
}

function sanitizeOptions(value: unknown): AgentRequestOptions {
	if (!isRecord(value)) return {};
	const out: AgentRequestOptions = {};
	for (const key of ["label", "phase", "schema", "model", "thinking", "profile"] as const) {
		if (value[key] !== undefined) out[key] = value[key];
	}
	return out;
}

/**
 * Run a workflow script. Resolves with its return value (JSON-normalized) or
 * rejects with the first protocol/script failure.
 */
export function runWorkflowSandbox(options: SandboxOptions): Promise<unknown> {
	// Refuse to run untrusted code without the runtime-level guard.
	if (!process.allowedNodeEnvironmentFlags.has("--permission")) {
		return Promise.reject(
			new Error(
				"This Node runtime cannot enforce workflow sandbox permissions (--permission unsupported); refusing to run",
			),
		);
	}
	const maxAgentRequests = options.maxAgentRequests ?? MAX_AGENT_REQUESTS;
	const maxConcurrency = options.maxConcurrency ?? MAX_CONCURRENCY;
	if (bytes(options.source) > MAX_SOURCE_BYTES) {
		return Promise.reject(new Error(`Workflow script exceeds the ${MAX_SOURCE_BYTES} byte limit`));
	}

	let argsJson: string;
	try {
		argsJson = safeStringify({ defined: options.args !== undefined, value: options.args }, MAX_ARGS_BYTES);
	} catch (error) {
		return Promise.reject(new Error(`Workflow args rejected: ${errorText(error)}`));
	}

	return new Promise<unknown>((resolve, reject) => {
		const workerPath = fileURLToPath(new URL("./workflow-child.cjs", import.meta.url));
		const child = spawn(
			process.execPath,
			[
				"--permission",
				// Only the sandbox worker's own directory is readable; no writes anywhere.
				`--allow-fs-read=${path.dirname(workerPath)}`,
				"--max-old-space-size=128",
				"--stack-size=2048",
				workerPath,
			],
			{
				cwd: options.cwd,
				// Minimal env: no tokens, no API keys, nothing inherited.
				env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" },
				stdio: ["ignore", "ignore", "ignore", "ipc"],
			},
		);

		const token = randomBytes(24).toString("hex");
		const seenIds = new Set<number>();
		const active = new Map<number, AbortController>();
		let requestCount = 0;
		let finished = false;

		const cleanup = () => {
			for (const controller of active.values()) controller.abort(new Error("Workflow stopped"));
			active.clear();
			options.signal.removeEventListener("abort", onAbort);
			child.removeAllListeners();
			terminate(child);
		};
		const finish = (error?: Error, value?: unknown) => {
			if (finished) return;
			finished = true;
			cleanup();
			if (error) reject(error);
			else resolve(value);
		};
		const onAbort = () => finish(new Error("Workflow was cancelled"));

		options.signal.addEventListener("abort", onAbort, { once: true });
		if (options.signal.aborted) return onAbort();

		child.on("error", (error) => finish(error));
		child.on("exit", (code, signal) => {
			if (!finished) {
				finish(new Error(`Workflow sandbox exited before completion (${signal ?? code ?? "unknown"})`));
			}
		});

		child.on("message", (raw: unknown) => {
			// Any protocol deviation is fatal: this channel carries untrusted output.
			if (!isRecord(raw) || raw.token !== token || typeof raw.kind !== "string") {
				return finish(new Error("Workflow sandbox sent an invalid IPC message"));
			}

			if (raw.kind === "phase") {
				if (typeof raw.payloadJson !== "string" || bytes(raw.payloadJson) > MAX_PHASE_BYTES) {
					return finish(new Error("Workflow sandbox sent an invalid phase update"));
				}
				try {
					const payload: unknown = JSON.parse(raw.payloadJson);
					if (!isRecord(payload) || typeof payload.title !== "string") throw new Error("invalid title");
					options.onPhase(payload.title.slice(0, 160));
				} catch {
					finish(new Error("Workflow sandbox sent an invalid phase update"));
				}
				return;
			}

			if (raw.kind === "agent") {
				if (typeof raw.payloadJson !== "string" || bytes(raw.payloadJson) > MAX_AGENT_MESSAGE_BYTES) {
					return finish(new Error("Workflow sandbox sent an oversized agent request"));
				}
				let payload: unknown;
				try {
					payload = JSON.parse(raw.payloadJson);
				} catch {
					return finish(new Error("Workflow sandbox sent malformed agent JSON"));
				}
				if (
					!isRecord(payload) ||
					typeof payload.id !== "number" ||
					!Number.isSafeInteger(payload.id) ||
					payload.id < 1 ||
					typeof payload.prompt !== "string" ||
					payload.prompt.length > 100_000 ||
					!isRecord(payload.options)
				) {
					return finish(new Error("Workflow sandbox sent an invalid agent request"));
				}
				if (seenIds.has(payload.id)) return finish(new Error("Workflow sandbox reused an agent request id"));
				if (++requestCount > maxAgentRequests) {
					return finish(new Error(`Workflow exceeded its budget of ${maxAgentRequests} agent calls`));
				}
				seenIds.add(payload.id);

				const id = payload.id;
				const controller = new AbortController();
				active.set(id, controller);
				const reply = (result: AgentRunResult) => {
					if (!active.delete(id)) return;
					if (finished || !child.connected) return;
					let resultJson: string;
					try {
						resultJson = safeStringify(result, MAX_AGENT_MESSAGE_BYTES);
					} catch {
						resultJson = JSON.stringify({
							ok: false,
							output: "",
							error: "Agent result exceeded the workflow IPC output limit",
						});
					}
					child.send({ token, kind: "agentResult", id, resultJson });
				};
				void options
					.onAgent(payload.prompt, sanitizeOptions(payload.options), controller.signal)
					// onAgent must never throw into the script: agent() resolves
					// { ok:false } so workflows branch explicitly instead of crashing.
					.then(reply)
					.catch((error) => reply({ ok: false, output: "", error: errorText(error) }));
				return;
			}

			if (raw.kind === "result") {
				if (typeof raw.resultJson !== "string" || bytes(raw.resultJson) > MAX_RESULT_BYTES) {
					return finish(new Error("Workflow result exceeded the IPC limit"));
				}
				try {
					finish(undefined, JSON.parse(raw.resultJson));
				} catch (error) {
					finish(new Error(`Workflow returned invalid JSON: ${errorText(error)}`));
				}
				return;
			}

			if (raw.kind === "error" && typeof raw.error === "string") {
				return finish(new Error(raw.error.slice(0, 16 * 1024)));
			}
			finish(new Error("Workflow sandbox sent an unknown IPC message"));
		});

		child.send({ kind: "init", token, source: options.source, argsJson, maxConcurrency }, (error) => {
			if (error) finish(error);
		});
	});
}
