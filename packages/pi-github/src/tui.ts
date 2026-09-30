import type { Theme as NativeTheme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import {
	Text as NativeText,
	stripTerminalSequences,
	truncateToWidth,
	wrapTextWithAnsi,
	visibleWidth,
} from "@earendil-works/pi-tui";

export interface RenderedComponent {
	render(width: number): string[];
	invalidate(): void;
}
type RenderContext = { lastComponent?: RenderedComponent; isError?: boolean };
type Options = Partial<ToolRenderResultOptions>;
type Tone = "accent" | "success" | "warning" | "error" | "muted";
type Result = {
	content?: { type: string; text?: string }[];
	details?: Record<string, unknown>;
	isError?: boolean;
};

class NativeRows extends NativeText {
	constructor(public lines: (width: number) => string[]) {
		super("", 0, 0);
	}
	override render(width: number): string[] {
		const w = Math.max(1, width);
		this.setText(
			this.lines(w)
				.map((line) => truncateToWidth(line, w))
				.join("\n"),
		);
		const rows = super.render(w);
		return rows.length <= 200 ? rows : [...rows.slice(0, 199), truncateToWidth("… more in tool content", w)];
	}
}
export function component(lines: (width: number) => string[], context?: RenderContext): RenderedComponent {
	if (context?.lastComponent instanceof NativeRows) {
		context.lastComponent.lines = lines;
		context.lastComponent.invalidate();
		return context.lastComponent;
	}
	return new NativeRows(lines);
}
export function plain(s: string): string {
	return stripTerminalSequences(s).replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
}
function one(s: string): string {
	return plain(s).replace(/\s+/g, " ").trim();
}
function color(theme: NativeTheme | undefined, tone: Tone, text: string): string {
	return theme?.fg(tone, text) ?? text;
}
function stateTone(state: string): Tone {
	return /failing|conflict|changes requested/.test(state)
		? "error"
		: /warning|not configured|not ready|timed out|pending|review required/.test(state)
			? "warning"
			: /passing|ready|clean|approved/.test(state)
				? "success"
				: "muted";
}
function preview(rows: string[], expanded?: boolean): string[] {
	return expanded || rows.length <= 5
		? rows
		: [...rows.slice(0, 5), `… ${String(rows.length - 5)} more · expand`];
}
function text(result: Result): string {
	return (result.content ?? [])
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}
function failure(result: Result, options: Options, theme?: NativeTheme, context?: RenderContext) {
	if (!(result.isError || context?.isError || result.details?.refused || result.details?.error)) return;
	return component(
		() => [
			color(theme, "error", `error · ${one(text(result) || String(result.details?.error ?? "Tool failed"))}`),
		],
		context,
	);
}
function finish(
	result: Result,
	summary: string,
	rows: (width: number) => string[],
	options: Options,
	theme?: NativeTheme,
	context?: RenderContext,
	tone: Tone = "success",
	full?: (width: number) => string[],
) {
	return component(
		(w) => [
			color(
				theme,
				options.isPartial ? "warning" : tone,
				`${options.isPartial ? "partial · " : ""}${one(summary)}`,
			),
			...preview(
				options.expanded && full ? full(w).flatMap((line) => wrapTextWithAnsi(line, w)) : rows(w),
				options.expanded,
			),
		],
		context,
	);
}

function row(primary: string, body: string, metadata: string, width: number, theme?: NativeTheme): string {
	const head = truncateToWidth(
		plain(primary).replace(/[\n\t]/g, " "),
		Math.max(1, Math.floor(width / 3)),
		"…",
	);
	const meta = truncateToWidth(one(metadata), Math.max(1, Math.floor(width / 2)), "…");
	const room = Math.max(0, width - visibleWidth(head) - visibleWidth(meta) - 2);
	return truncateToWidth(
		`${color(theme, "accent", head)} ${truncateToWidth(one(body), room, "…")} ${color(theme, "muted", meta)}`,
		width,
		"…",
	);
}

import type { PullDetail } from "./viewmodel.ts";
export function pullRowLines(
	rows: {
		number: number;
		title: string;
		author: string;
		state: string;
		review?: string;
		checks?: string;
		labels?: string[];
		assignees?: string[];
	}[],
	width: number,
	theme?: NativeTheme,
): string[] {
	if (!rows.length) return [color(theme, "muted", "no open pull requests")];
	const pad = Math.max(...rows.map((r) => String(r.number).length));
	return rows.map((r) =>
		row(
			`#${String(r.number).padStart(pad)}`,
			r.title,
			`(${r.review ? `${r.review}, ` : ""}${r.checks ? `${r.checks}, ` : ""}${r.state}; ${r.author ?? r.assignees?.join(", ") ?? "unassigned"})`,
			width,
			theme,
		),
	);
}
export function checkRowLines(
	rows: { name: string; status: string; durationSec: number | null; summary?: string | null }[],
	width = 80,
	theme?: NativeTheme,
): string[] {
	return rows.length
		? rows.map((r) =>
				truncateToWidth(
					`${color(theme, stateTone(r.status), one(r.status))} ${one(r.name)}${r.durationSec === null ? "" : ` ${color(theme, "muted", `${String(r.durationSec)}s`)}`}`,
					width,
				),
			)
		: [color(theme, "muted", "no check runs")];
}
export function issueRowLines(
	rows: { number: number; title: string; labels: string[]; assignees: string[] }[],
	width: number,
	theme?: NativeTheme,
): string[] {
	return rows.length
		? rows.map((r) =>
				row(
					`#${String(r.number)}`,
					r.title,
					`${r.labels.length ? `[${r.labels.join(", ")}] ` : ""}(${r.assignees.length ? r.assignees.join(", ") : "unassigned"})`,
					width,
					theme,
				),
			)
		: [color(theme, "muted", "no matching issues")];
}
export function renderPullRows(
	rows: Parameters<typeof pullRowLines>[0],
	theme?: NativeTheme,
	options: Options = {},
): RenderedComponent {
	return component((w) => preview(pullRowLines(rows, w, theme), options.expanded));
}
export function renderIssueRows(
	rows: Parameters<typeof issueRowLines>[0],
	theme?: NativeTheme,
	options: Options = {},
): RenderedComponent {
	return component((w) => preview(issueRowLines(rows, w, theme), options.expanded));
}
export function renderCheckRows(
	rows: Parameters<typeof checkRowLines>[0],
	theme?: NativeTheme,
	options: Options = {},
): RenderedComponent {
	return component((w) => preview(checkRowLines(rows, w, theme), options.expanded));
}
export function renderToolCall(
	tool: string,
	args: Record<string, unknown>,
	theme?: NativeTheme,
	context?: RenderContext,
): RenderedComponent {
	const target = [
		args.repo,
		typeof args.number === "number" ? `#${String(args.number)}` : undefined,
		args.ref,
		args.search,
		args.event,
		args.label,
	]
		.filter((v) => typeof v === "string")
		.map((v) => one(String(v)))
		.join(" · ");
	return component(
		() => [
			`${color(theme, "accent", tool.replace("github_", "github "))}${target ? ` ${color(theme, "muted", target)}` : ""}`,
		],
		context,
	);
}
export function renderToolResult(
	tool: string,
	value: unknown,
	options: Options = {},
	theme?: NativeTheme,
	context?: RenderContext,
): RenderedComponent {
	const result = (value ?? {}) as Result;
	const error = failure(result, options, theme, context);
	if (error) return error;
	const d = result.details as
		| {
				rows?:
					| Parameters<typeof pullRowLines>[0]
					| Parameters<typeof checkRowLines>[0]
					| Parameters<typeof issueRowLines>[0];
				pr?: PullDetail;
				truncated?: boolean;
				rollup?: string;
				repo?: string;
		  }
		| undefined;
	const partial = d?.truncated === true || d?.pr?.filesTruncated === true;
	const opts = { ...options, isPartial: options.isPartial || partial };
	if (d?.rows) {
		const rows = d.rows;
		const kind = tool === "github_prs" ? "pull requests" : tool === "github_checks" ? "checks" : "issues";
		const summary = `${d.rollup ? `${d.rollup} · ` : ""}${rows.length ? `${String(rows.length)} ${kind}` : `no ${kind}`}${d.repo ? ` · ${d.repo}` : ""}${partial ? " · more available" : ""}`;
		const lines = (w: number) =>
			!rows.length
				? []
				: tool === "github_prs"
					? pullRowLines(rows as Parameters<typeof pullRowLines>[0], w, theme)
					: tool === "github_checks"
						? checkRowLines(rows as Parameters<typeof checkRowLines>[0], w, theme)
						: issueRowLines(rows as Parameters<typeof issueRowLines>[0], w, theme);
		return finish(result, summary, lines, opts, theme, context, stateTone(d.rollup ?? "ready"), () =>
			rows.length ? plain(text(result)).split("\n") : [],
		);
	}
	if (d?.pr) {
		const p = d.pr;
		const rows = (w: number) => [
			color(theme, "muted", `${one(p.author)} · ${one(p.state)} · ${one(p.branch)} → ${one(p.baseBranch)}`),
			`+${String(p.additions)}/−${String(p.deletions)} · ${String(p.changedFiles)} files`,
			...checkRowLines(p.checks, w, theme),
			...(p.mergeable ? [color(theme, "warning", `cannot merge: ${one(p.mergeable)}`)] : []),
		];
		const full = () => [
			color(theme, "muted", `${one(p.author)} · ${one(p.branch)} → ${one(p.baseBranch)}`),
			color(theme, "muted", one(p.url)),
			color(theme, "accent", "Description"),
			plain(p.body) || "(no description)",
			color(theme, "accent", "Checks"),
			...p.checks.map(
				(c) =>
					`${color(theme, stateTone(c.status), one(c.status))} ${one(c.name)}${c.durationSec === null ? "" : ` · ${String(c.durationSec)}s`}`,
			),
			...p.checks.flatMap((c) => (c.summary ? [plain(c.summary)] : [])),
			color(theme, "accent", "Reviews"),
			...p.reviews.flatMap((r) => [`${one(r.author)} · ${one(r.state)}`, plain(r.body)]),
			color(theme, "accent", "Files"),
			...p.files.flatMap((f) => [
				color(
					theme,
					"accent",
					`${one(f.path)} · ${one(f.status)} +${String(f.additions)}/−${String(f.deletions)}`,
				),
				...(f.patch === null
					? [`patch omitted: ${one(f.patchOmitted ?? "unknown reason")}`]
					: plain(f.patch)
							.split("\n")
							.map((l) =>
								color(theme, l.startsWith("+") ? "success" : l.startsWith("-") ? "error" : "muted", l),
							)),
			]),
			...(p.filesTruncated ? [`file list truncated · ${one(p.url)}`] : []),
		];
		return finish(
			result,
			`${p.state} · #${String(p.number)} ${p.title}`,
			rows,
			opts,
			theme,
			context,
			"success",
			full,
		);
	}
	return finish(
		result,
		one(text(result).split("\n")[0] ?? "") ||
			(options.isPartial ? "loading github result" : "no result data"),
		() => [],
		options,
		theme,
		context,
		result.details?.disconnected
			? "muted"
			: result.details?.connected || result.details?.posted
				? "success"
				: "muted",
		() => plain(text(result)).split("\n").slice(1),
	);
}
