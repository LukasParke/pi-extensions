import type { WorktreeHandle, WorktreeManager } from "./subagent-sdk.ts";

export type IsolationMode = "workflow" | "worktree";

export interface LaneSnapshot {
	cwd: string;
	branch: string;
	baseCommit: string;
	changed: boolean;
	diffSummary?: string;
}

type Waiter = {
	kind: "read" | "write";
	resolve: () => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
};

/** A fair, abortable reader/writer lock around one workflow-owned worktree. */
export class WorkflowLane {
	private handle: WorktreeHandle | undefined;
	private creating: Promise<WorktreeHandle> | undefined;
	private writerActive = false;
	private activeReaders = 0;
	private readonly waiters: Waiter[] = [];

	constructor(
		private readonly worktrees: WorktreeManager,
		private readonly baseCwd: string,
		private readonly label: string,
	) {}

	get snapshot(): LaneSnapshot | undefined {
		return this.handle ? this.toSnapshot(this.handle) : undefined;
	}

	async ensure(signal?: AbortSignal): Promise<LaneSnapshot> {
		return this.toSnapshot(await this.ensureHandle(signal));
	}

	async withWriter<T>(fn: (lane: LaneSnapshot) => Promise<T>, signal?: AbortSignal): Promise<T> {
		await this.acquire("write", signal);
		try {
			return await fn(await this.ensure(signal));
		} finally {
			this.writerActive = false;
			this.drain();
		}
	}

	async withReader<T>(fn: (lane: LaneSnapshot) => Promise<T>, signal?: AbortSignal): Promise<T> {
		await this.acquire("read", signal);
		try {
			return await fn(await this.ensure(signal));
		} finally {
			this.activeReaders--;
			this.drain();
		}
	}

	async finalize(): Promise<LaneSnapshot | undefined> {
		if (!this.handle) return undefined;
		this.handle = await this.worktrees.finalize(this.handle);
		return this.toSnapshot(this.handle);
	}

	private acquire(kind: Waiter["kind"], signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(new Error("Workflow lane wait aborted"));
		if (kind === "read" && !this.writerActive && this.waiters.length === 0) {
			this.activeReaders++;
			return Promise.resolve();
		}
		if (kind === "write" && !this.writerActive && this.activeReaders === 0 && this.waiters.length === 0) {
			this.writerActive = true;
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			const waiter: Waiter = { kind, resolve, reject, signal };
			waiter.onAbort = () => {
				const index = this.waiters.indexOf(waiter);
				if (index >= 0) this.waiters.splice(index, 1);
				reject(new Error("Workflow lane wait aborted"));
				this.drain();
			};
			signal?.addEventListener("abort", waiter.onAbort, { once: true });
			this.waiters.push(waiter);
		});
	}

	private drain(): void {
		if (this.writerActive || this.activeReaders > 0 || this.waiters.length === 0) return;
		if (this.waiters[0]!.kind === "write") {
			const waiter = this.waiters.shift()!;
			this.writerActive = true;
			this.resolve(waiter);
			return;
		}
		while (this.waiters[0]?.kind === "read") {
			const waiter = this.waiters.shift()!;
			this.activeReaders++;
			this.resolve(waiter);
		}
	}

	private resolve(waiter: Waiter): void {
		waiter.signal?.removeEventListener("abort", waiter.onAbort!);
		waiter.resolve();
	}

	private async ensureHandle(signal?: AbortSignal): Promise<WorktreeHandle> {
		if (this.handle) return this.handle;
		this.creating ??= this.worktrees.create(this.baseCwd, this.label.slice(0, 20), signal).then((handle) => {
			this.handle = handle;
			return handle;
		});
		return this.creating;
	}

	private toSnapshot(handle: WorktreeHandle): LaneSnapshot {
		return {
			cwd: handle.cwd,
			branch: handle.branch,
			baseCommit: handle.baseCommit,
			changed: handle.changed,
			diffSummary: handle.diffSummary,
		};
	}
}
