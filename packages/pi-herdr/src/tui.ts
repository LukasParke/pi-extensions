import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

type RenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
type Operation = "dispatch" | "status" | "cleanup";
const titles = { dispatch: "Herdr Task", status: "Herdr Status", cleanup: "Herdr Cleanup" };
const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const plain = (value: unknown) =>
	stripTerminalSequences(String(value ?? ""))
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
		.replace(/\t/g, "  ");
const label = (value: unknown) => plain(value).replace(/\n/g, " ");

class HerdrText extends Text {
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

function nativeText(context: RenderContext, rows: (width: number) => string[]) {
	const text = context.lastComponent instanceof HerdrText ? context.lastComponent : new HerdrText("", 0, 0);
	text.rows = rows;
	text.invalidate();
	return text;
}

function bodyRows(text: string, width: number, theme: Theme) {
	const rows = wrapTextWithAnsi(plain(text), width);
	return [
		...rows.slice(0, 40).map((row) => theme.fg("toolOutput", row)),
		...(rows.length > 40
			? [theme.fg("muted", `… ${rows.length - 40} more display rows; tool text retains the body`)]
			: []),
	];
}

export function herdrRenderers(operation: Operation): Pick<ToolDefinition, "renderCall" | "renderResult"> {
	return {
		renderCall(args, theme, context) {
			const a = object(args);
			const target =
				operation === "dispatch"
					? [a.name, a.repo, a.task].filter(Boolean).map(label).join(" · ")
					: [a.agent, a.wait ? "wait" : undefined, a.force ? "force discard" : undefined]
							.filter(Boolean)
							.map(label)
							.join(" · ");
			return nativeText(context, () => [
				theme.fg(
					context.executionStarted && context.isPartial ? "accent" : "toolTitle",
					theme.bold(titles[operation]),
				) + (target ? ` ${theme.fg("muted", target)}` : ""),
			]);
		},
		renderResult(result, options, theme, context) {
			const d = object(result.details);
			const a = object(context.args);
			const text = result.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			const first =
				plain(text)
					.split("\n")
					.find((line) => line.trim()) ?? "No outcome returned";
			const agent = label(d.agentName ?? a.agent ?? a.name ?? "Herdr task");
			const refused = operation === "cleanup" && d.cleaned === false && d.reason !== "nothing-found";
			const failed = context.isError || !!d.error || refused;
			const state = failed
				? refused
					? "Refused"
					: "Failed"
				: options.isPartial
					? a.wait
						? "Waiting"
						: "Active"
					: operation === "dispatch"
						? d.agentName
							? "Dispatched"
							: "Unknown"
						: operation === "cleanup"
							? d.cleaned
								? d.removal === "gone"
									? "Already gone"
									: "Cleaned"
								: "Nothing found"
							: label(d.status ?? "unknown");
			const tone =
				failed || state === "failed"
					? "error"
					: state === "Waiting" || d.note || d.matches || ["blocked", "unknown", "Unknown"].includes(state)
						? "warning"
						: ["gone", "idle", "cancelled", "Already gone", "Nothing found"].includes(state)
							? "muted"
							: ["Dispatched", "Active", "working", "running", "pending"].includes(state)
								? "accent"
								: "success";
			return nativeText(context, (width) => {
				const rows = [theme.fg(tone, `${agent} · ${state}`)];
				if (failed) rows.push(theme.fg("error", label(d.error ?? first)));
				if (!options.isPartial) {
					if (d.branch) rows.push(theme.fg("muted", `Branch · ${label(d.branch)}`));
					if (d.worktreePath || d.cwd)
						rows.push(theme.fg("muted", `Worktree · ${label(d.worktreePath ?? d.cwd)}`));
					if (d.note) rows.push(theme.fg("warning", label(d.note)));
					if (d.matches) rows.push(theme.fg("warning", "Multiple worktrees match; resolve before cleanup"));
					if (operation === "status" && text.includes("transcript: unavailable"))
						rows.push(theme.fg("warning", "Transcript unavailable; lifecycle state shown above"));
				}
				if (options.expanded && !options.isPartial) rows.push(...bodyRows(text, width, theme));
				return options.expanded ? rows : rows.slice(0, 5);
			});
		},
	};
}
