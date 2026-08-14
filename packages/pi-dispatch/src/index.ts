/**
 * Session-level notification queue for pi extensions.
 *
 * Sentinel events, subagent completions, watchdog escalations, and workflow
 * results all publish into one per-process queue; a single delivery path
 * drains it into the pi session. The queue lives on `globalThis` under a
 * well-known symbol so separately installed packages share one instance.
 *
 * Delivery semantics:
 *
 * - Items accumulate while the agent is busy and flush once the session is
 *   idle, after a coalescing quiet window that resets on every publish.
 * - One message per batch, grouped escalation → completion → info.
 * - `triggerTurn` only when at least one item is wake-urgent.
 * - A failed send keeps the batch queued for the next flush.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type DispatchPriority = "escalation" | "completion" | "info";
export type DispatchUrgency = "wake" | "next-turn";

export interface DispatchItem {
	/** Dedupe key: publishing the same id replaces the queued item and increments foldCount. */
	id: string;
	/** Publisher label, e.g. "sentinel:pr-24" or "subagent:run-ab12". */
	source: string;
	priority: DispatchPriority;
	urgency: DispatchUrgency;
	/** Markdown for the batch body. */
	message: string;
	details?: Record<string, unknown>;
	/** Number of publishes folded into this item. Starts at 1, maintained by the queue. */
	foldCount: number;
}

export interface DispatchQueue {
	publish(item: Omit<DispatchItem, "foldCount">): void;
	/** Drop queued items whose source === prefix or starts with prefix + ":". Returns the drop count. */
	suppress(sourcePrefix: string): number;
	peek(): DispatchItem[];
	size(): number;
}

const QUEUE_KEY = Symbol.for("parke.dev/pi-dispatch");
const MESSAGE_TYPE = "dispatch";
const DELIVERY_QUIET_MS = 2_000;

const PRIORITY_ORDER: DispatchPriority[] = ["escalation", "completion", "info"];
const PRIORITY_HEADERS: Record<DispatchPriority, string> = {
	escalation: "Escalations",
	completion: "Completions",
	info: "Info",
};

interface DispatchState {
	items: Map<string, DispatchItem>;
	wired: boolean;
	pi?: ExtensionAPI;
	ctx?: ExtensionContext;
	flushTimer?: NodeJS.Timeout;
}

function createState(): DispatchState {
	return { items: new Map(), wired: false };
}

function state(): DispatchState {
	const scope = globalThis as unknown as Record<symbol, DispatchState | undefined>;
	return (scope[QUEUE_KEY] ??= createState());
}

function sortedItems(items: Map<string, DispatchItem>): DispatchItem[] {
	return [...items.values()].sort(
		(a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority),
	);
}

export function formatBatch(items: DispatchItem[]): string {
	const lines = [`Dispatch (${items.length} item${items.length === 1 ? "" : "s"}):`];
	for (const priority of PRIORITY_ORDER) {
		const group = items.filter((item) => item.priority === priority);
		if (!group.length) continue;
		lines.push("", `## ${PRIORITY_HEADERS[priority]}`);
		for (const item of group) {
			lines.push(
				`- **${item.source}** — ${item.message}${item.foldCount > 1 ? ` (x${item.foldCount})` : ""}`,
			);
		}
	}
	return lines.join("\n");
}

export function dispatchQueue(): DispatchQueue {
	const current = state();
	return {
		publish(item) {
			const existing = current.items.get(item.id);
			current.items.set(item.id, { ...item, foldCount: existing ? existing.foldCount + 1 : 1 });
			scheduleFlush();
		},
		suppress(sourcePrefix) {
			let dropped = 0;
			for (const [id, item] of current.items) {
				if (item.source === sourcePrefix || item.source.startsWith(`${sourcePrefix}:`)) {
					current.items.delete(id);
					dropped++;
				}
			}
			return dropped;
		},
		peek: () => sortedItems(current.items),
		size: () => current.items.size,
	};
}

function flush(pi: ExtensionAPI) {
	const current = state();
	if (!current.items.size || !current.ctx?.isIdle()) return;
	const batch = sortedItems(current.items);
	try {
		pi.sendMessage(
			{
				customType: MESSAGE_TYPE,
				content: formatBatch(batch),
				display: true,
				details: { items: batch },
			},
			{
				deliverAs: "followUp",
				...(batch.some((item) => item.urgency === "wake") ? { triggerTurn: true } : {}),
			},
		);
		for (const item of batch) current.items.delete(item.id);
	} catch {
		// Keep the batch queued for the next idle flush.
	}
}

function scheduleFlush() {
	const current = state();
	if (!current.wired || !current.ctx) return;
	if (current.flushTimer) clearTimeout(current.flushTimer);
	current.flushTimer = setTimeout(() => {
		current.flushTimer = undefined;
		if (current.pi) flush(current.pi);
	}, DELIVERY_QUIET_MS);
	current.flushTimer.unref?.();
}

export function ensureDelivery(pi: ExtensionAPI): void {
	const current = state();
	if (current.wired) return;
	current.wired = true;
	current.pi = pi;
	pi.on("session_start", (_event, ctx) => {
		current.ctx = ctx;
		scheduleFlush();
	});
	pi.on("agent_settled", () => scheduleFlush());
	pi.on("session_shutdown", () => {
		if (current.flushTimer) clearTimeout(current.flushTimer);
		current.flushTimer = undefined;
		current.items.clear();
		current.ctx = undefined;
	});
}

/** Test-only: drop the shared queue and delivery wiring so each test starts clean. */
export function resetDispatchForTests(): void {
	const scope = globalThis as unknown as Record<symbol, DispatchState | undefined>;
	const current = scope[QUEUE_KEY];
	if (current?.flushTimer) clearTimeout(current.flushTimer);
	delete scope[QUEUE_KEY];
}
