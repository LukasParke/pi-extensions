/**
 * Git + optional PR snapshot for the footer.
 *
 * Uses `@parke.dev/pi-git` library helpers only — never loads that package's
 * extension entry, so no git tools are registered as a side effect.
 */

import { LocalGitExec, status, type GitExec } from "@parke.dev/pi-git";
import { sanitizeTerminalLabel } from "./sanitize.ts";

export interface PullRequestInfo {
	number: number;
	url: string;
	isDraft: boolean;
}

export interface GitSnapshot {
	isRepository: boolean;
	branch: string | null;
	changedFiles: number;
	pullRequest: PullRequestInfo | null;
}

export function emptyGitSnapshot(): GitSnapshot {
	return {
		isRepository: false,
		branch: null,
		changedFiles: 0,
		pullRequest: null,
	};
}

export function parsePullRequestJson(value: string): PullRequestInfo | null {
	try {
		const parsed: unknown = JSON.parse(value);
		if (!parsed || typeof parsed !== "object") return null;
		const record = parsed as Record<string, unknown>;
		if (typeof record.number !== "number" || !Number.isFinite(record.number)) return null;
		if (typeof record.url !== "string" || /[\u0000-\u001f\u007f-\u009f]/.test(record.url)) return null;
		const url = new URL(record.url);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		if (record.state !== "OPEN") return null;
		return {
			number: record.number,
			url: url.toString(),
			isDraft: record.isDraft === true,
		};
	} catch {
		return null;
	}
}

export function formatGitLabel(snapshot: GitSnapshot, showPr: boolean) {
	if (!snapshot.isRepository || !snapshot.branch) return "";
	const branch = sanitizeTerminalLabel(snapshot.branch);
	const fileLabel = snapshot.changedFiles === 1 ? "file" : "files";
	let label = `${branch} · ${snapshot.changedFiles} ${fileLabel}`;
	if (showPr && snapshot.pullRequest) {
		label += ` · PR #${snapshot.pullRequest.number}`;
	}
	return label;
}

const GIT_TIMEOUT_MS = 3_000;
const GH_TIMEOUT_MS = 10_000;
const SAFE_GH_BRANCH = /^[A-Za-z0-9._/@{}+~^-]{1,255}$/;

export interface GitPollerOptions {
	exec?: GitExec;
	/** Override `gh` runner for tests. */
	runGh?: (
		args: readonly string[],
		cwd: string,
	) => Promise<{ stdout: string; stderr: string; code: number | null }>;
	showPr?: boolean;
}

/**
 * Coalescing git/PR poller with a generation counter so stale async work
 * after reload / session switch cannot clobber newer state.
 */
export function createGitPoller(options: GitPollerOptions = {}) {
	const exec = options.exec ?? new LocalGitExec();
	const showPr = options.showPr !== false;
	let generation = 0;
	let inFlight: Promise<void> | null = null;
	let queued: { cwd: string; forcePr: boolean } | null = null;
	let snapshot = emptyGitSnapshot();
	let queriedPrBranch: string | null = null;
	let onChange: ((next: GitSnapshot) => void) | undefined;

	const runGh =
		options.runGh ??
		(async (args, cwd) => {
			const result = await exec.run("gh", args, { cwd, timeoutMs: GH_TIMEOUT_MS });
			return { stdout: result.stdout, stderr: result.stderr, code: result.code };
		});

	function publish(next: GitSnapshot) {
		snapshot = next;
		onChange?.(next);
	}

	async function refreshOnce(cwd: string, forcePr: boolean, gen: number) {
		const st = await status(exec, cwd);
		if (gen !== generation) return;

		if (!st.isRepo) {
			queriedPrBranch = null;
			publish(emptyGitSnapshot());
			return;
		}

		const branch = st.detached ? null : st.branch ? sanitizeTerminalLabel(st.branch) : null;
		const branchLabel = branch ?? (st.detached ? "detached" : null);
		const branchChanged = branch !== queriedPrBranch;

		const next: GitSnapshot = {
			isRepository: true,
			branch: branchLabel,
			changedFiles: st.files.length,
			pullRequest: branchChanged ? null : snapshot.pullRequest,
		};
		publish(next);

		if (!showPr || !branch || branch.startsWith("-") || !SAFE_GH_BRANCH.test(branch)) {
			if (!branch || branch.startsWith("-") || !SAFE_GH_BRANCH.test(branch)) queriedPrBranch = null;
			return;
		}

		if (!forcePr && !branchChanged) return;

		queriedPrBranch = branch;
		try {
			const result = await runGh(["pr", "view", branch, "--json", "number,url,state,isDraft"], cwd);
			if (gen !== generation) return;
			const pr = result.code === 0 ? parsePullRequestJson(result.stdout) : null;
			publish({ ...snapshot, pullRequest: pr });
		} catch {
			// PR lookup is best-effort; leave pullRequest as-is (cleared on branch change).
			if (gen !== generation) return;
		}
	}

	async function drain() {
		while (queued) {
			const job = queued;
			queued = null;
			const gen = generation;
			try {
				await refreshOnce(job.cwd, job.forcePr, gen);
			} catch {
				// git failures are silent — footer just shows no git line
			}
		}
		inFlight = null;
	}

	return {
		get snapshot() {
			return snapshot;
		},
		setOnChange(handler: ((next: GitSnapshot) => void) | undefined) {
			onChange = handler;
		},
		/** Bump generation and clear state (session switch / shutdown). */
		invalidate() {
			generation += 1;
			queued = null;
			queriedPrBranch = null;
			snapshot = emptyGitSnapshot();
		},
		/** Coalesced refresh; never blocks the caller. */
		request(cwd: string, forcePr = false) {
			const prev = queued;
			queued = {
				cwd,
				forcePr: forcePr || (prev?.forcePr ?? false),
			};
			if (!inFlight) inFlight = drain();
			return inFlight;
		},
		/** Test helper: wait for the current drain. */
		idle() {
			return inFlight ?? Promise.resolve();
		},
	};
}

export type GitPoller = ReturnType<typeof createGitPoller>;
