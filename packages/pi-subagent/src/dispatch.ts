/**
 * Integration with @parke.dev/pi-dispatch, the shared session-level
 * notification queue: items batch while the orchestrator is busy and drain
 * once on settle, grouped by priority, folded by id.
 *
 * pi-subagent publishes watchdog escalations and budget warnings here so the
 * orchestrator receives one coalesced dispatch batch instead of a peck of
 * separate messages. Delivery wiring (ensureDelivery) is the responsibility
 * of whichever extension calls it first; registerSubagent does so at setup.
 */

import { dispatchQueue, ensureDelivery } from "@parke.dev/pi-dispatch";
import type { DispatchPriority, DispatchUrgency } from "@parke.dev/pi-dispatch";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type { DispatchPriority, DispatchUrgency };

export interface SubagentDispatch {
  /** Stable dedupe key; repeat publishes fold with a count. */
  id: string;
  /** Run-scoped source, e.g. "subagent:ab12cd34". Cancelling suppresses by prefix. */
  source: string;
  priority: DispatchPriority;
  urgency: DispatchUrgency;
  message: string;
  details?: Record<string, unknown>;
}

/** Wire the shared delivery path (idempotent across extensions). */
export function ensureDispatchDelivery(pi: ExtensionAPI): void {
  ensureDelivery(pi);
}

/** Publish into the shared queue. Never throws; returns false on failure. */
export function publishDispatch(item: SubagentDispatch): boolean {
  try {
    dispatchQueue().publish(item);
    return true;
  } catch {
    return false;
  }
}

/** Drop queued items for a run (e.g. on cancel). Returns the drop count. */
export function suppressDispatch(sourcePrefix: string): number {
  try {
    return dispatchQueue().suppress(sourcePrefix);
  } catch {
    return 0;
  }
}
