import type { IssueRow } from "./viewmodel.ts";

export interface RenderedComponent {
	render(width: number): string[];
	invalidate(): void;
}

export function component(lines: (width: number) => string[]): RenderedComponent {
	return { render: (width) => lines(width), invalidate: () => undefined };
}

const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

export function plain(s: string): string {
	return s.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
}

function tint(priority: string): string {
	switch (priority) {
		case "urgent":
			return `${RED}${priority}${RESET}`;
		case "high":
			return `${YELLOW}${priority}${RESET}`;
		default:
			return `${DIM}${priority}${RESET}`;
	}
}

export function issueLines(rows: IssueRow[], width: number): string[] {
	if (rows.length === 0) return [`${DIM}no matching issues${RESET}`];
	const idPad = Math.max(...rows.map((r) => r.identifier.length));
	return rows.map((r) => {
		const id = plain(r.identifier).padEnd(idPad);
		const meta = `${r.state}, ${r.priority}, ${r.assignee}`;
		const fixed = `${id}  (${meta})`;
		const room = Math.max(8, width - fixed.length);
		const title = plain(r.title);
		const cut = title.length > room ? `${title.slice(0, Math.max(1, room - 1))}…` : title;
		return `${BOLD}${id}${RESET} ${cut} ${DIM}(${plain(r.state)}, ${RESET}${tint(r.priority)}${DIM}, ${plain(r.assignee)})${RESET}`;
	});
}

export function renderIssues(rows: IssueRow[]): RenderedComponent {
	return component((w) => issueLines(rows, w));
}

export function renderToolCall(tool: string, args: Record<string, unknown>): RenderedComponent {
	const label = tool.replace(/^linear_/, "");
	const target = typeof args.issue === "string" ? ` ${plain(args.issue)}` : "";
	return component(() => [`${DIM}linear ${label}${target}${RESET}`]);
}
