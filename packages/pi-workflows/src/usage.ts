import type { UsageStats } from "./subagent-sdk.ts";
import { addUsage, emptyUsage } from "./subagent-sdk.ts";

export type { UsageStats };
export { addUsage, emptyUsage };

export function formatUsageLine(usage: UsageStats, elapsedMs?: number) {
	const tokens = usage.input + usage.output;
	const parts = [
		usage.turns ? `${usage.turns} turns` : undefined,
		tokens ? `${formatCount(tokens)} tokens` : undefined,
		usage.cost > 0.00005 ? `$${usage.cost.toFixed(2)}` : undefined,
		elapsedMs !== undefined ? formatDuration(elapsedMs) : undefined,
	].filter(Boolean);
	return parts.join(" · ");
}

function formatCount(n: number) {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

export function formatDuration(ms: number) {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
	const h = Math.floor(m / 60);
	return `${h}h ${m % 60}m`;
}
