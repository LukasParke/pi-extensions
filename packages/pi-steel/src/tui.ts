import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";

type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
import { Text, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export function plain(value: unknown): string {
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

export function browserRenderers(title: string): Pick<ToolDefinition, "renderCall" | "renderResult"> {
	return {
		renderCall(args, nativeTheme, context) {
			const a = object(args);
			const target = [a.action ?? a.mode, a.url ?? a.query ?? a.selector]
				.filter(Boolean)
				.map(plain)
				.join(" · ")
				.replace(/\n/g, " ");
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
			const failed = context.isError || /^(Read failed:|Crawl failed\.)/.test(first) || d.refused === true;
			const limited = d.truncated === true || /too large|unrecognized image type|\[truncated/i.test(text);
			const empty =
				/^(No results|No live|\(no content|No URLs)/i.test(first) ||
				(title === "Steel Scrape" && Array.isArray(d.formats) && d.formats.length === 0);
			const idle = title === "Steel Session" && (empty || d.action === "end");
			const waiting =
				options.isPartial &&
				(object(context.args).action === "wait" || Number(object(context.args).waitMs) > 0);
			const tone = failed
				? "error"
				: waiting
					? "warning"
					: options.isPartial
						? "accent"
						: limited
							? "warning"
							: empty || idle
								? "muted"
								: "success";
			const label = failed
				? "Failed"
				: waiting
					? "Waiting"
					: options.isPartial
						? "Active"
						: limited
							? "Limited"
							: idle
								? "Closed"
								: empty
									? "Empty"
									: "Done";
			const summary = failed
				? first
				: options.isPartial
					? "Browser operation in progress"
					: typeof d.count === "number"
						? `${d.count} results`
						: (d.title ?? first);
			const images = result.content.filter((block) => block.type === "image");
			return nativeText(context, (width) => {
				const rows = [nativeTheme.fg(tone, `${label} · ${plain(summary).replace(/\n/g, " ")}`)];
				if (options.expanded && !options.isPartial) {
					rows.push(...bodyRows(text, width, nativeTheme));
					for (const image of images)
						rows.push(
							nativeTheme.fg(
								"muted",
								`Image · ${plain(image.mimeType)} · ${context.showImages ? "inline display enabled" : "inline display hidden"}`,
							),
						);
				}
				const tail = text.trimEnd().split("\n").at(-1);
				const pointer =
					tail?.startsWith("[truncated") && /output:|use steel_read/.test(tail) ? tail : undefined;
				if (pointer) rows.push(nativeTheme.fg("warning", plain(pointer)));
				return rows;
			});
		},
	};
}
