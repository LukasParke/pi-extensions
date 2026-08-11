/**
 * Full session cost accounting.
 *
 * Matches Pi's native footer sources:
 * - assistant message usage
 * - tool-result usage (subagent delivery, etc.)
 * - compaction / branch_summary entry usage
 *
 * Pure over a session entry list so tests do not need a live SessionManager.
 */

export interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

export interface SessionCostTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export function emptySessionCost(): SessionCostTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function add(totals: SessionCostTotals, usage: UsageLike | undefined) {
	if (!usage) return;
	totals.input += usage.input ?? 0;
	totals.output += usage.output ?? 0;
	totals.cacheRead += usage.cacheRead ?? 0;
	totals.cacheWrite += usage.cacheWrite ?? 0;
	totals.cost += usage.cost?.total ?? 0;
}

/**
 * Fold every billable usage record on the active session path.
 * Accepts loosely-typed entries so tests and live SessionEntry both work.
 */
export function sessionCost(entries: readonly unknown[]): SessionCostTotals {
	const totals = emptySessionCost();

	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as {
			type?: string;
			usage?: UsageLike;
			message?: { role?: string; usage?: UsageLike };
		};

		if (entry.type === "message") {
			const role = entry.message?.role;
			if (role === "assistant") {
				add(totals, entry.message?.usage);
			} else if (role === "toolResult") {
				add(totals, entry.message?.usage);
			}
			continue;
		}

		if (entry.type === "compaction" || entry.type === "branch_summary") {
			add(totals, entry.usage);
		}
	}

	return totals;
}

/** Memoize against full-session length + last entry id so render stays cheap. */
export function createSessionCostCache() {
	let key = "";
	let cached = emptySessionCost();

	return {
		get(entries: readonly { id?: string }[]): SessionCostTotals {
			const last = entries[entries.length - 1];
			const nextKey = `${entries.length}:${last?.id ?? ""}`;
			if (nextKey === key) return cached;
			key = nextKey;
			cached = sessionCost(entries);
			return cached;
		},
		reset() {
			key = "";
			cached = emptySessionCost();
		},
	};
}
