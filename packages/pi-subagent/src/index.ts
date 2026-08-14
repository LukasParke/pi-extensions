/**
 * Stable public SDK for library consumers (e.g. pi-workflows).
 *
 * Import from `@parke.dev/pi-subagent` — do not reach into `src/*` internals.
 * The Pi extension entry remains `extensions/subagent.ts` via package `pi.extensions`.
 */

export { runTasks } from "./orchestrator.js";
export type { OrchestratedRun, OrchestratorDeps } from "./orchestrator.js";

export { ChildRunner, runSubagent } from "./runner.js";
export type { GetPiCommand, RunnerOptions, WatchdogEvent } from "./runner.js";

export { ensureDispatchDelivery, publishDispatch, suppressDispatch } from "./dispatch.js";
export type { DispatchPriority, DispatchUrgency, SubagentDispatch } from "./dispatch.js";

export type { WatchdogConfig } from "./config.js";

export { WorktreeManager } from "./worktree.js";
export type {
  CreateWorktreeOptions,
  GlobalSweepReport,
  SweepReport,
  WorktreeApplyResult,
  WorktreeDiffResult,
  WorktreeHandle,
} from "./worktree.js";

export { Semaphore } from "./semaphore.js";

export { ProcessLockManager } from "./process-lock.js";
export type {
  ProcessIdentity,
  ProcessLockOptions,
  RunProcessRecord,
  SessionLockOwner,
  SlotToken,
} from "./process-lock.js";

export type {
  BackendAdapter,
  BackendCapabilities,
  BackendName,
} from "./backend.js";

export {
  addUsage,
  buildUsageLedger,
  formatLedger,
  hasBilledUsage,
  normalizeUsage,
  toPiUsage,
} from "./usage.js";
export type { UsageLedger } from "./usage.js";

export { emptyUsage } from "./types.js";
export type {
  KeepAliveStatus,
  RunMode,
  RunSnapshot,
  RunState,
  TaskProfile,
  TaskResult,
  TaskSpec,
  UsageStats,
  WatchdogStatus,
} from "./types.js";
