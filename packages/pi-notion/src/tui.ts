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
	const head = truncateToWidth(one(primary), Math.max(1, Math.floor(width / 3)), "…");
	const meta = truncateToWidth(one(metadata), Math.max(1, Math.floor(width / 2)), "…");
	const room = Math.max(0, width - visibleWidth(head) - visibleWidth(meta) - 2);
	return truncateToWidth(
		`${color(theme, "accent", head)} ${truncateToWidth(one(body), room, "…")} ${color(theme, "muted", meta)}`,
		width,
		"…",
	);
}

import type { PageBlock, PageDetail, PageRow } from "./viewmodel.ts";
export function pageLines(rows: PageRow[], width: number, theme?: NativeTheme): string[] {
	return rows.length
		? rows.map((r) => row(r.id, r.title, `(${r.parent})`, width, theme))
		: [color(theme, "muted", "no matching pages")];
}
export function blockLines(blocks: PageBlock[], width: number, theme?: NativeTheme): string[] {
	if (!blocks.length) return [color(theme, "muted", "(empty page)")];
	return blocks.flatMap((b): string[] => {
		switch (b.type) {
			case "heading":
				return wrapTextWithAnsi(color(theme, "accent", `${"#".repeat(b.level)} ${plain(b.text)}`), width);
			case "paragraph":
				return wrapTextWithAnsi(plain(b.text), width);
			case "list":
				return b.items.flatMap((item, i) =>
					wrapTextWithAnsi(`${b.ordered ? `${String(i + 1)}.` : "•"} ${plain(item)}`, width),
				);
			case "code":
				return [
					color(theme, "muted", `\`\`\`${one(b.language ?? "")}`),
					...plain(b.source)
						.split("\n")
						.flatMap((l) => wrapTextWithAnsi(l, width)),
					color(theme, "muted", "```"),
				];
			case "quote":
				return wrapTextWithAnsi(`${color(theme, "muted", "│")} ${plain(b.text)}`, width);
			case "divider":
				return [color(theme, "muted", "─".repeat(Math.max(1, Math.min(width, 40))))];
			case "table":
				return [b.headers.join(" | "), ...b.rows.map((r) => r.join(" | "))].flatMap((r) =>
					wrapTextWithAnsi(plain(r), width),
				);
			case "unsupported":
				return wrapTextWithAnsi(color(theme, "warning", `[unsupported: ${one(b.label)}]`), width);
		}
	});
}
export function renderPages(rows: PageRow[], theme?: NativeTheme, options: Options = {}): RenderedComponent {
	return component((w) => preview(pageLines(rows, w, theme), options.expanded));
}
export function renderBlocks(
	blocks: PageBlock[],
	theme?: NativeTheme,
	options: Options = {},
): RenderedComponent {
	return component((w) => preview(blockLines(blocks, w, theme), options.expanded));
}
export function renderToolCall(
	tool: string,
	args: Record<string, unknown>,
	theme?: NativeTheme,
	context?: RenderContext,
): RenderedComponent {
	const target = [args.page, args.query, args.label]
		.filter((v) => typeof v === "string")
		.map((v) => one(String(v)))
		.join(" · ");
	return component(
		() => [
			`${color(theme, "accent", tool.replace("notion_", "notion "))}${target ? ` ${color(theme, "muted", target)}` : ""}`,
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
	const d = result.details as { rows?: PageRow[]; page?: PageDetail; truncated?: boolean } | undefined;
	const partial = d?.truncated === true || d?.page?.truncated === true;
	const opts = { ...options, isPartial: options.isPartial || partial };
	if (d?.page) {
		const p = d.page;
		return finish(
			result,
			`${p.title} · ${p.blocks.length ? `${String(p.blocks.length)} blocks` : "empty page"}${partial ? " · page truncated" : ""}`,
			() => (p.blocks.length ? [color(theme, "muted", `${one(p.parent)} · ${one(p.url || p.id)}`)] : []),
			opts,
			theme,
			context,
			"success",
			(w) => [
				color(theme, "muted", `${one(p.parent)} · ${one(p.url || p.id)}`),
				...blockLines(p.blocks, w, theme),
				...(partial ? ["page truncated · more blocks available"] : []),
			],
		);
	}
	if (d?.rows)
		return finish(
			result,
			`${d.rows.length ? `${String(d.rows.length)} pages` : "no matching pages"}${partial ? " · more available" : ""}`,
			(w) => (d.rows!.length ? pageLines(d.rows!, w, theme) : []),
			opts,
			theme,
			context,
			"success",
			() =>
				d.rows!.flatMap((r) => [
					color(theme, "accent", one(r.title)),
					color(theme, "muted", `${one(r.parent)} · ${one(r.url || r.id)}`),
				]),
		);
	return finish(
		result,
		one(text(result).split("\n")[0] ?? "") ||
			(options.isPartial ? "loading notion result" : "no result data"),
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
