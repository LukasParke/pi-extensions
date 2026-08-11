/**
 * The dispatch flow: resolve repo → ensure worktree → ensure pi agent →
 * prompt with verification.
 *
 * Every step is written against an injected `HerdrRunner` so the reliability
 * logic — worktree reuse, agent adoption, transient-error retry, and the
 * prompt-swallow guard — is unit-testable without the herdr CLI.
 */

import { herdr as realHerdr } from "./cli.ts";

/** Runs a herdr command and returns the parsed `result` from its envelope. */
export type HerdrRunner = (args: string[]) => Promise<any>;

export interface DispatchOptions {
	herdr?: HerdrRunner;
	sleep?: (ms: number) => Promise<void>;
	/** How long to keep retrying transient agent-start failures, ms. */
	startDeadlineMs?: number;
	now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const PR_URL = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/;

export function parsePrUrl(text: string): { org: string; repo: string; num: string } | undefined {
	const match = text.match(PR_URL);
	return match ? { org: match[1], repo: match[2], num: match[3] } : undefined;
}

export function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
	// Herdr agent names must match [a-z][a-z0-9_-]*; never emit an empty or
	// digit-leading slug (e.g. an all-punctuation or non-Latin task title).
	return /^[a-z]/.test(slug) ? slug : `task-${slug || Date.now().toString(36)}`.slice(0, 40);
}

/**
 * Agent-start failures that resolve themselves: the pane is still checking
 * out the worktree (busy / "not an available shell"), or herdr misdetects the
 * agent kind while the shell settles (agent_kind_mismatch).
 */
export function isTransientStartError(message: string): boolean {
	return (
		message.includes("agent_pane_busy") ||
		message.includes("not an available shell") ||
		message.includes("agent_kind_mismatch")
	);
}

/**
 * Prompt failures worth a re-send: the lifecycle never flipped to working.
 *
 * Only herdr's own envelope errors qualify (our CLI wrapper prefixes them
 * with the command). A process-level exec timeout is NOT re-sendable — the
 * prompt may have reached the agent even though the CLI died waiting.
 */
export function isPromptStallError(message: string): boolean {
	return (
		message.includes("stall") || (message.startsWith("herdr agent prompt") && message.includes("timeout"))
	);
}

export interface WorktreeHandle {
	paneId: string;
	workspaceId: string;
	worktreePath: string;
}

/**
 * Create the worktree, or reuse an existing one for the same branch — a
 * previous dispatch may have created it and failed later. Returns the pane
 * hosting the worktree's workspace.
 */
export async function ensureWorktree(
	repoPath: string,
	branch: string,
	label: string,
	options: DispatchOptions = {},
): Promise<WorktreeHandle> {
	const herdr = options.herdr ?? realHerdr;
	try {
		const created = await herdr([
			"worktree",
			"create",
			"--cwd",
			repoPath,
			"--branch",
			branch,
			"--label",
			label,
			"--no-focus",
		]);
		return {
			paneId: created.root_pane.pane_id,
			workspaceId: created.workspace.workspace_id,
			worktreePath: created.worktree.path,
		};
	} catch (error) {
		// Branch/worktree already exists → find and reuse it.
		const listed = await herdr(["worktree", "list", "--cwd", repoPath]);
		const existing = listed.worktrees?.find(
			(w: any) => w.branch === branch && w.is_linked_worktree && w.open_workspace_id,
		);
		if (!existing) throw error;
		const panes = await herdr(["pane", "list", "--workspace", existing.open_workspace_id]);
		const pane = panes.panes?.[0];
		if (!pane) throw error;
		return {
			paneId: pane.pane_id,
			workspaceId: existing.open_workspace_id,
			worktreePath: existing.path,
		};
	}
}

/**
 * A pi agent already attached to the pane (e.g. auto-started by the shell) is
 * just as good as one we start — starting would fail with pane_busy.
 */
async function existingPiAgent(herdr: HerdrRunner, paneId: string): Promise<string | undefined> {
	try {
		const info = await herdr(["agent", "get", paneId]);
		if (info.agent?.agent === "pi") return info.agent.name ?? paneId;
	} catch {
		// No agent on the pane; start one below.
	}
	return undefined;
}

/**
 * Start pi in the pane, adopting an already-running pi if present. Retries
 * transient states until the deadline; other errors are real and propagate.
 */
export async function ensurePiAgent(
	name: string,
	paneId: string,
	task: string,
	options: DispatchOptions = {},
): Promise<{ agentName: string; launchedWithTask: boolean }> {
	const herdr = options.herdr ?? realHerdr;
	const sleep = options.sleep ?? defaultSleep;
	const now = options.now ?? Date.now;
	const deadline = now() + (options.startDeadlineMs ?? 5 * 60_000);
	for (;;) {
		const existing = await existingPiAgent(herdr, paneId);
		if (existing) {
			if (existing === paneId) {
				try {
					await herdr(["agent", "rename", paneId, name]);
					return { agentName: name, launchedWithTask: false };
				} catch {
					// Rename is cosmetic; the adopted agent still answers to its pane id.
				}
			}
			return { agentName: existing, launchedWithTask: false };
		}
		try {
			const started = await herdr(["agent", "start", name, "--kind", "pi", "--pane", paneId, "--", task]);
			return { agentName: started.agent.name, launchedWithTask: true };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!isTransientStartError(message) || now() >= deadline) throw error;
			await sleep(3_000);
		}
	}
}

/**
 * Submit the prompt and verify it took. Pi silently drops prompts sent while
 * it is still loading (P1 in the herdr-pi-orchestration skill): the tell is
 * the agent staying idle. `--wait --until working` confirms the lifecycle
 * actually flipped; on a stall, re-send — unless the agent is already working,
 * in which case the prompt landed just before a slow state flip.
 */
export async function promptWithVerify(
	target: string,
	task: string,
	options: DispatchOptions = {},
): Promise<void> {
	const herdr = options.herdr ?? realHerdr;
	const sleep = options.sleep ?? defaultSleep;
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		if (attempt > 0) await sleep(5_000);
		try {
			await herdr(["agent", "prompt", target, task, "--wait", "--until", "working"]);
			return;
		} catch (error) {
			lastError = error;
			const message = error instanceof Error ? error.message : String(error);
			if (!isPromptStallError(message)) throw error;
			try {
				const info = await herdr(["agent", "get", target]);
				if (info.agent?.agent_status === "working") return;
			} catch {
				// Can't confirm either way; treat as swallowed and re-send.
			}
		}
	}
	throw lastError instanceof Error
		? new Error(`prompt not accepted after 3 attempts: ${lastError.message}`)
		: lastError;
}

export interface HerdrTaskResult {
	agentName: string;
	paneId: string;
	workspaceId: string;
	worktreePath: string;
	branch: string;
	repoPath: string;
}

export async function dispatchHerdrTask(
	input: { repoPath: string; task: string; name?: string },
	options: DispatchOptions = {},
): Promise<HerdrTaskResult> {
	const slug = slugify(input.name ?? input.task);
	const name = input.name ?? slug;
	const branch = `agent/${slug}`;

	const worktree = await ensureWorktree(input.repoPath, branch, name, options);
	const { agentName, launchedWithTask } = await ensurePiAgent(name, worktree.paneId, input.task, options);
	const herdr = options.herdr ?? realHerdr;
	if (launchedWithTask) {
		try {
			await herdr(["agent", "wait", agentName, "--until", "working", "--timeout", "30000"]);
		} catch {
			const info = await herdr(["agent", "get", agentName]);
			if (info.agent?.agent_status === "idle") await promptWithVerify(agentName, input.task, options);
		}
	} else {
		await promptWithVerify(agentName, input.task, options);
	}

	return {
		agentName,
		paneId: worktree.paneId,
		workspaceId: worktree.workspaceId,
		worktreePath: worktree.worktreePath,
		branch,
		repoPath: input.repoPath,
	};
}
