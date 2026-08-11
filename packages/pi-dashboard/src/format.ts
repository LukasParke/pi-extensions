import { relative, resolve, sep } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalLabel } from "./sanitize.ts";

export function formatTokens(n: number) {
	if (!Number.isFinite(n) || n < 0) return "0";
	if (n < 1_000) return String(Math.round(n));
	if (n < 1_000_000) {
		const k = n / 1_000;
		return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
	}
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatCost(cost: number) {
	if (!Number.isFinite(cost) || cost <= 0) return "$0.00";
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	return `$${cost.toFixed(2)}`;
}

export function formatTokPerSec(rate: number | null) {
	if (rate === null || !Number.isFinite(rate) || rate <= 0) return "— tok/s";
	return `${Math.round(rate)} tok/s`;
}

/** `~` for $HOME so long paths stay readable; sanitize for the terminal. */
export function formatDirectory(cwd: string, home: string | undefined) {
	const resolvedCwd = resolve(cwd);
	const cleaned = sanitizeTerminalLabel(resolvedCwd);
	if (!home) return cleaned;
	const resolvedHome = resolve(home);
	const rel = relative(resolvedHome, resolvedCwd);
	const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
	if (!inside) return cleaned;
	return sanitizeTerminalLabel(rel === "" ? "~" : `~${sep}${rel}`);
}

/** Left/right columns with ANSI-aware width, truncating when narrow. */
export function columns(left: string, right: string, width: number) {
	if (!right) return truncateToWidth(left, width);
	const naturalGap = width - visibleWidth(left) - visibleWidth(right);
	if (naturalGap >= 1) return `${left}${" ".repeat(naturalGap)}${right}`;

	const leftWidth = Math.max(1, Math.floor(width * 0.55));
	const rightWidth = Math.max(1, width - leftWidth - 1);
	const fittedLeft = truncateToWidth(left, leftWidth);
	const fittedRight = truncateToWidth(right, rightWidth);
	const gap = Math.max(1, width - visibleWidth(fittedLeft) - visibleWidth(fittedRight));
	return truncateToWidth(`${fittedLeft}${" ".repeat(gap)}${fittedRight}`, width);
}

export function center(text: string, width: number) {
	const pad = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
	return truncateToWidth(`${" ".repeat(pad)}${text}`, width);
}
