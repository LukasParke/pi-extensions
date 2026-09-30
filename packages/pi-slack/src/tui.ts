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

import type { ChannelRow, MessageRow, SearchRow, ThreadDetail } from "./viewmodel.ts";
export function channelLines(rows: ChannelRow[], width: number, theme?: NativeTheme): string[] {
	return rows.length
		? rows.map((r) =>
				row(`#${r.name}`, r.latestText, `(${r.privacy}; ${String(r.replyCount)} replies)`, width, theme),
			)
		: [color(theme, "muted", "no matching channels")];
}
export function messageLines(
	messages: MessageRow[],
	width: number,
	theme?: NativeTheme,
	expanded = false,
): string[] {
	if (!messages.length) return [color(theme, "muted", "no messages")];
	return messages.flatMap((m) =>
		expanded
			? [
					color(theme, "accent", `${one(m.author)}${m.root ? " · root" : ""}`),
					...wrapTextWithAnsi(plain(m.text), width),
				]
			: [
					truncateToWidth(
						`${color(theme, m.root ? "accent" : "muted", one(m.author))}: ${one(m.text)}`,
						width,
					),
				],
	);
}
export function searchLines(rows: SearchRow[], width: number, theme?: NativeTheme): string[] {
	return rows.length
		? rows.map((r) =>
				truncateToWidth(
					`${color(theme, "accent", `#${one(r.channelName)} ${one(r.author)}`)} ${one(r.text)}`,
					width,
				),
			)
		: [color(theme, "muted", "no matching messages")];
}
export function renderChannels(
	rows: ChannelRow[],
	theme?: NativeTheme,
	options: Options = {},
): RenderedComponent {
	return component((w) => preview(channelLines(rows, w, theme), options.expanded));
}
export function renderMessages(
	rows: MessageRow[],
	theme?: NativeTheme,
	options: Options = {},
): RenderedComponent {
	return component((w) => preview(messageLines(rows, w, theme, options.expanded), options.expanded));
}
export function renderSearch(
	rows: SearchRow[],
	theme?: NativeTheme,
	options: Options = {},
): RenderedComponent {
	return component((w) => preview(searchLines(rows, w, theme), options.expanded));
}
export function renderToolCall(
	tool: string,
	args: Record<string, unknown>,
	theme?: NativeTheme,
	context?: RenderContext,
): RenderedComponent {
	const target = [
		args.channel,
		args.ref,
		args.ts,
		args.threadTs,
		args.query,
		args.label,
		Array.isArray(args.channels) ? args.channels.join(", ") : undefined,
	]
		.filter((v) => typeof v === "string")
		.map((v) => one(String(v)))
		.join(" · ");
	return component(
		() => [
			`${color(theme, "accent", tool.replace("slack_", "slack "))}${target ? ` ${color(theme, "muted", target)}` : ""}`,
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
		{ rows?: ChannelRow[] | SearchRow[]; thread?: ThreadDetail; truncated?: boolean } | undefined;
	const partial = d?.truncated === true || d?.thread?.truncated === true;
	const opts = { ...options, isPartial: options.isPartial || partial };
	if (d?.thread) {
		const t = d.thread;
		return finish(
			result,
			`${t.messages.length ? `${String(t.messages.length)} messages` : "no messages"} · #${t.channelName}${partial ? " · thread truncated" : ""}`,
			(w) => (t.messages.length ? messageLines(t.messages, w, theme) : []),
			opts,
			theme,
			context,
			"success",
			(w) =>
				t.messages.length
					? [
							color(theme, "muted", one(t.permalink)),
							...messageLines(t.messages, w, theme, true),
							...(partial ? ["thread truncated · more messages available"] : []),
						]
					: [],
		);
	}
	if (d?.rows) {
		const rows = d.rows;
		const channels = tool === "slack_channels";
		return finish(
			result,
			`${rows.length ? `${String(rows.length)} ${channels ? "channels" : "messages"}` : `no matching ${channels ? "channels" : "messages"}`}${partial ? " · more available" : ""}`,
			(w) =>
				!rows.length
					? []
					: channels
						? channelLines(rows as ChannelRow[], w, theme)
						: searchLines(rows as SearchRow[], w, theme),
			opts,
			theme,
			context,
			"success",
			() =>
				channels
					? (rows as ChannelRow[]).flatMap((r) => [
							color(theme, "accent", `#${one(r.name)} · ${one(r.privacy)}`),
							color(
								theme,
								"muted",
								`${String(r.replyCount)} replies${r.memberCount === null ? "" : ` · ${String(r.memberCount)} members`}`,
							),
							plain(r.topic ?? ""),
							plain(r.latestText),
						])
					: (rows as SearchRow[]).flatMap((r) => [
							color(theme, "accent", `#${one(r.channelName)} ${one(r.author)}`),
							plain(r.text),
							color(theme, "muted", one(r.permalink)),
						]),
		);
	}
	return finish(
		result,
		one(text(result).split("\n")[0] ?? "") || (options.isPartial ? "loading slack result" : "no result data"),
		() => [],
		options,
		theme,
		context,
		result.details?.disconnected
			? "muted"
			: result.details?.connected || result.details?.posted
				? "success"
				: "muted",
		() => plain(text(result)).split("\n"),
	);
}
