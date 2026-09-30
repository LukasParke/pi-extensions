import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";

type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
import { Text, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

function plain(value: unknown): string {
	return stripTerminalSequences(String(value ?? ""))
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
		.replace(/\t/g, "  ");
}

class NativeText extends Text {
	rows: (width: number) => string[] = () => [];
	render(width: number) {
		if (width < 1) return [];
		this.setText(
			this.rows(width)
				.map((row) => truncateToWidth(row, width))
				.join("\n"),
		);
		return super.render(width);
	}
}

function nativeText(context: ToolRenderContext, rows: (width: number) => string[]) {
	const text = context.lastComponent instanceof NativeText ? context.lastComponent : new NativeText("", 0, 0);
	text.rows = rows;
	text.invalidate();
	return text;
}

const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" ? (value as Record<string, unknown>) : {};

function bodyRows(text: string, width: number, nativeTheme: Theme) {
	const rows = wrapTextWithAnsi(plain(text), width);
	return [
		...rows.slice(0, 40).map((row) => nativeTheme.fg("toolOutput", row)),
		...(rows.length > 40
			? [nativeTheme.fg("muted", `… ${rows.length - 40} more display rows; tool text retains the body`)]
			: []),
	];
}

export function firecrawlRenderers(title: string): Pick<ToolDefinition, "renderCall" | "renderResult"> {
	return {
		renderCall(args, nativeTheme, context) {
			const a = object(args);
			const target = plain(a.url ?? a.query).replace(/\n/g, " ");
			return nativeText(context, () => [
				nativeTheme.fg(
					context.executionStarted && context.isPartial ? "accent" : "toolTitle",
					nativeTheme.bold(title),
				) + (target ? ` ${nativeTheme.fg("muted", target)}` : ""),
			]);
		},
		renderResult(result, options, nativeTheme, context) {
			const d = object(result.details);
			const text = result.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			const first =
				plain(text)
					.split("\n")
					.find((line) => line.trim()) ?? "No content returned";
			const crawl = title === "Firecrawl Crawl";
			const failed = context.isError || d.refused === true || d.status === "failed";
			const partial = crawl && !options.isPartial && d.status !== undefined && d.status !== "completed";
			const waiting = options.isPartial && /waiting|queued|paused/.test(String(d.status));
			const empty =
				/^(No results|No URLs|\(no content)/i.test(first) ||
				(crawl && d.status === "completed" && Array.isArray(d.data) && d.data.length === 0);
			const tone = failed
				? "error"
				: partial || waiting
					? "warning"
					: options.isPartial
						? "accent"
						: empty
							? "muted"
							: "success";
			const label = failed
				? d.refused
					? "Refused"
					: "Failed"
				: partial
					? "Partial / timeout"
					: waiting
						? "Waiting"
						: options.isPartial
							? "Active"
							: empty
								? "Empty"
								: "Done";
			const list = Array.isArray(d.links) ? d.links : Array.isArray(d.data) ? d.data : undefined;
			const summary = crawl
				? `${plain(d.status ?? "starting")} · ${d.completed ?? 0}/${d.total ?? "?"} pages`
				: list
					? `${list.length} ${title === "Firecrawl Map" ? "URLs" : "results"}`
					: (object(d.metadata).title ?? first);
			return nativeText(context, (width) => [
				nativeTheme.fg(tone, `${label} · ${plain(summary).replace(/\n/g, " ")}`),
				...(options.expanded && !options.isPartial
					? bodyRows(d.error ? `${plain(d.error)}\n${text}` : text, width, nativeTheme)
					: []),
			]);
		},
	};
}
