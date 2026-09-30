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
	const message = plain(text(result) || String(result.details?.error ?? "Tool failed"));
	return component(
		(width) =>
			options.expanded
				? [
						color(theme, "error", "error"),
						...wrapTextWithAnsi(message, width).map((line) => color(theme, "error", line)),
					]
				: [color(theme, "error", `error · ${one(message)}`)],
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
	const head = truncateToWidth(one(primary), Math.max(1, Math.floor(width / 3)), "…");
	const meta = truncateToWidth(one(metadata), Math.max(1, Math.floor(width / 2)), "…");
	const room = Math.max(0, width - visibleWidth(head) - visibleWidth(meta) - 2);
	return truncateToWidth(
		`${color(theme, "accent", head)} ${truncateToWidth(one(body), room, "…")} ${color(theme, "muted", meta)}`,
		width,
		"…",
	);
}

export function statusLines(
	st: {
		branch: string | null;
		ahead: number;
		behind: number;
		files: { path: string; status: string; staged: boolean }[];
		conflicted: boolean;
	},
	width: number,
	theme?: NativeTheme,
): string[] {
	const head = `${st.branch === null ? "(detached)" : one(st.branch)}${st.ahead ? ` ↑${String(st.ahead)}` : ""}${st.behind ? ` ↓${String(st.behind)}` : ""}`;
	return [
		color(theme, "accent", head),
		...(st.conflicted ? [color(theme, "error", "conflicts unresolved")] : []),
		...(st.files.length
			? st.files.map((f) =>
					truncateToWidth(
						`${color(theme, "muted", one(f.status))} ${one(f.path)}${f.staged ? " (staged)" : " (unstaged)"}`,
						width,
					),
				)
			: [color(theme, "success", "clean")]),
	];
}
export function branchLines(
	rows: { name: string; current: boolean; ahead: number; behind: number; upstream: string | null }[],
	width: number,
	theme?: NativeTheme,
): string[] {
	return rows.length
		? rows.map((r) =>
				truncateToWidth(
					`${r.current ? "* " : ""}${one(r.name)} ${color(theme, "muted", `${r.upstream === null ? "no upstream" : one(r.upstream)}${r.ahead ? ` ↑${String(r.ahead)}` : ""}${r.behind ? ` ↓${String(r.behind)}` : ""}`)}`,
					width,
				),
			)
		: [color(theme, "muted", "no branches")];
}
export function checklistLines(
	result: { ready: boolean; checks: { name: string; state: string; detail: string | null }[] },
	theme?: NativeTheme,
): string[] {
	return [
		color(theme, result.ready ? "success" : "warning", result.ready ? "ready" : "not ready"),
		...result.checks.map(
			(c) =>
				`${color(theme, stateTone(c.state), one(c.state))} ${one(c.name)}${c.detail === null ? "" : ` · ${color(theme, "muted", one(c.detail))}`}`,
		),
	];
}
export function diffLines(
	files: { path: string; status: string; additions: number; deletions: number }[],
	width: number,
	theme?: NativeTheme,
): string[] {
	return files.length
		? files.map((f) =>
				truncateToWidth(
					`${one(f.path)} ${color(theme, "success", `+${String(f.additions)}`)}/${color(theme, "error", `−${String(f.deletions)}`)} ${color(theme, "muted", one(f.status))}`,
					width,
				),
			)
		: [color(theme, "muted", "no changes")];
}
export function renderStatus(
	st: Parameters<typeof statusLines>[0],
	theme?: NativeTheme,
	options: Options = {},
): RenderedComponent {
	return component((w) => preview(statusLines(st, w, theme), options.expanded));
}
export function renderBranches(
	rows: Parameters<typeof branchLines>[0],
	theme?: NativeTheme,
	options: Options = {},
): RenderedComponent {
	return component((w) => preview(branchLines(rows, w, theme), options.expanded));
}
export function renderChecklist(
	r: Parameters<typeof checklistLines>[0],
	theme?: NativeTheme,
	options: Options = {},
): RenderedComponent {
	return component(() => preview(checklistLines(r, theme), options.expanded));
}
export function renderDiff(
	files: Parameters<typeof diffLines>[0],
	theme?: NativeTheme,
	options: Options = {},
): RenderedComponent {
	return component((w) => preview(diffLines(files, w, theme), options.expanded));
}
export function renderToolCall(
	tool: string,
	args: Record<string, unknown>,
	theme?: NativeTheme,
	context?: RenderContext,
): RenderedComponent {
	const target = [args.path, args.ref, args.file, args.from, args.to]
		.filter((v) => typeof v === "string")
		.map((v) => one(String(v)))
		.join(" · ");
	return component(
		() => [
			`${color(theme, "accent", tool.replace("git_", "git "))}${target ? ` ${color(theme, "muted", target)}` : ""}`,
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
				status?: Parameters<typeof statusLines>[0];
				diff?: { files: Parameters<typeof diffLines>[0] };
				branches?: Parameters<typeof branchLines>[0];
				checks?: Parameters<typeof checklistLines>[0]["checks"];
				ready?: boolean;
				commits?: { sha: string; subject: string }[];
				worktrees?: { path: string; branch: string | null }[];
		  }
		| undefined;
	const full = () => plain(text(result)).split("\n");
	if (tool === "git_status" && d?.status) {
		const st = d.status;
		return finish(
			result,
			`${st.conflicted ? "conflicts unresolved" : st.files.length ? `${String(st.files.length)} changes` : "clean"} · ${st.branch ?? "(detached)"}`,
			(w) => (st.files.length ? statusLines(st, w, theme).slice(st.conflicted ? 2 : 1) : []),
			options,
			theme,
			context,
			st.conflicted ? "error" : "success",
			full,
		);
	}
	if (tool === "git_diff" && d?.diff)
		return finish(
			result,
			d.diff.files.length ? `${String(d.diff.files.length)} changed files` : "no changes",
			(w) => (d.diff ? diffLines(d.diff.files, w, theme).filter(() => d.diff!.files.length > 0) : []),
			options,
			theme,
			context,
			"success",
			full,
		);
	if (tool === "git_branches" && d?.branches)
		return finish(
			result,
			d.branches.length ? `${String(d.branches.length)} branches` : "no branches",
			(w) => (d.branches!.length ? branchLines(d.branches!, w, theme) : []),
			options,
			theme,
			context,
			"success",
			full,
		);
	if (tool === "git_checklist" && d?.checks)
		return finish(
			result,
			d.ready ? "ready" : "not ready",
			() => checklistLines({ ready: d.ready === true, checks: d.checks! }, theme).slice(1),
			options,
			theme,
			context,
			d.ready ? "success" : "warning",
			full,
		);
	if (tool === "git_log" && d?.commits)
		return finish(
			result,
			d.commits.length ? `${String(d.commits.length)} commits` : "no commits in that range",
			() => d.commits!.map((c) => `${color(theme, "accent", one(c.sha.slice(0, 8)))} ${one(c.subject)}`),
			options,
			theme,
			context,
			"success",
			full,
		);
	return finish(
		result,
		text(result)
			? one(text(result).split("\n")[0] ?? "")
			: options.isPartial
				? "loading git result"
				: "no result data",
		() => [],
		options,
		theme,
		context,
		"muted",
	);
}
