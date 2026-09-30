import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

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

export function searchRenderers(title: string): Pick<ToolDefinition, "renderCall" | "renderResult"> {
	return {
		renderCall(args, nativeTheme, context) {
			const a = object(args);
			const target = [a.pattern ?? "all entries", a.path ?? "."].map(plain).join(" · ").replace(/\n/g, " ");
			return nativeText(context, () => [
				nativeTheme.fg(
					context.executionStarted && context.isPartial ? "accent" : "toolTitle",
					nativeTheme.bold(title),
				) + ` ${nativeTheme.fg("muted", target)}`,
			]);
		},
		renderResult(result, options, nativeTheme, context) {
			const d = object(result.details);
			const text = result.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			const notes = Array.isArray(d.notes) ? d.notes.map(plain) : [];
			const limited = d.partial === true || d.truncated === true;
			const tone = context.isError
				? "error"
				: options.isPartial
					? "accent"
					: limited
						? "warning"
						: d.matches === 0
							? "muted"
							: "success";
			const label = context.isError
				? "Failed"
				: options.isPartial
					? "Searching"
					: d.partial
						? "Partial"
						: d.truncated
							? "Truncated"
							: d.matches === 0
								? "Empty"
								: "Done";
			const summary = context.isError
				? plain(text).split("\n")[0]
				: `${d.matches ?? "?"} ${title === "Find Files" ? "paths" : "output lines (matches + context)"}`;
			return nativeText(context, (width) => {
				const rows = [nativeTheme.fg(tone, `${label} · ${summary}`)];
				if (!options.isPartial && (context.isError || d.matches !== 0)) {
					const raw = plain(
						text.replace(/\n\n\[note: [^\n]*\]$/, "").replace(/\n\n\[truncated: [\s\S]*$/, ""),
					).split("\n");
					const display = options.expanded
						? raw.flatMap((line) => wrapTextWithAnsi(line, width))
						: raw.filter((line) => line.trim());
					const cap = options.expanded ? 40 : Math.max(0, 3 - notes.length - (d.file ? 1 : 0));
					rows.push(...display.slice(0, cap).map((line) => nativeTheme.fg("toolOutput", line)));
					if (display.length > cap)
						rows.push(
							nativeTheme.fg(
								"muted",
								`… ${display.length - cap} more ${options.expanded ? "display rows; tool text retains raw context" : "lines; expand"}`,
							),
						);
					rows.push(...notes.map((note) => nativeTheme.fg(d.partial ? "warning" : "muted", note)));
					if (d.file) rows.push(nativeTheme.fg("warning", `Full results: ${plain(d.file)}`));
				}
				return rows;
			});
		},
	};
}
