import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
import { Text, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ErrorLogEntry } from "./log.ts";

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

export const errorLogRenderers: Pick<ToolDefinition, "renderCall" | "renderResult"> = {
	renderCall(args, nativeTheme, context) {
		const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
		const target = [a.tool ?? "all tools", a.since, a.kind]
			.filter(Boolean)
			.map(plain)
			.join(" · ")
			.replace(/\n/g, " ");
		return nativeText(context, () => [
			nativeTheme.fg(
				context.executionStarted && context.isPartial ? "accent" : "toolTitle",
				nativeTheme.bold("Error Log"),
			) + ` ${nativeTheme.fg("muted", target)}`,
		]);
	},
	renderResult(result, options, nativeTheme, context) {
		const d = result.details as { path?: string; entries?: ErrorLogEntry[] } | undefined;
		const entries = d?.entries ?? [];
		const text = result.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		const disabled = /^Error log is disabled/.test(text);
		const tone = context.isError
			? "error"
			: options.isPartial
				? "accent"
				: disabled
					? "warning"
					: entries.length
						? "success"
						: "muted";
		const label = context.isError
			? `Failed · ${plain(text).split("\n")[0]}`
			: options.isPartial
				? "Reading error log"
				: disabled
					? "Disabled · error logging is off"
					: entries.length
						? `Ready · ${entries.length} captured errors`
						: "Empty · no matching errors";
		return nativeText(context, (width) => {
			const rows = [nativeTheme.fg(tone, label)];
			if (options.isPartial) return rows;
			if (options.expanded) {
				const body = context.isError
					? [text]
					: entries.flatMap((entry) => [
							`${entry.ts} · ${entry.kind}${entry.tool ? ` · ${entry.tool}` : ""}`,
							entry.error.message,
							...(entry.args ? [`Args: ${entry.args}`] : []),
							...(entry.error.stack ? [`Stack:\n${entry.error.stack}`] : []),
							...(entry.cwd ? [`Cwd: ${entry.cwd}`] : []),
						]);
				const display = body.flatMap((line) => wrapTextWithAnsi(plain(line), width));
				rows.push(...display.slice(0, 40).map((line) => nativeTheme.fg("toolOutput", line)));
				if (display.length > 40)
					rows.push(nativeTheme.fg("muted", `… ${display.length - 40} more display rows; full log below`));
			} else {
				for (const entry of entries.slice(0, 3))
					rows.push(
						nativeTheme.fg(
							"error",
							`${plain(entry.tool ?? entry.kind)} · ${plain(entry.error.message).split("\n")[0]}`,
						),
					);
				if (entries.length > 3)
					rows.push(nativeTheme.fg("muted", `… ${entries.length - 3} more errors; expand`));
			}
			if (options.expanded && d?.path) rows.push(nativeTheme.fg("muted", `Full log: ${plain(d.path)}`));
			return rows;
		});
	},
};
