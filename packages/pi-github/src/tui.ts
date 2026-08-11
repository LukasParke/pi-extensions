export interface RenderedComponent {
	render(width: number): string[];
	invalidate(): void;
}

export function component(lines: (width: number) => string[]): RenderedComponent {
	return {
		render: (width: number) => lines(width),
		invalidate: () => undefined,
	};
}

const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

export function plain(s: string): string {
	return s.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
}

function tint(status: string): string {
	switch (status) {
		case "passing":
		case "approved":
			return `${GREEN}${status}${RESET}`;
		case "failing":
		case "changes requested":
			return `${RED}${status}${RESET}`;
		case "pending":
		case "review required":
			return `${YELLOW}${status}${RESET}`;
		default:
			return `${DIM}${status}${RESET}`;
	}
}

export function pullRowLines(
	rows: {
		number: number;
		title: string;
		author: string;
		state: string;
		review: string;
		checks: string;
	}[],
	width: number,
): string[] {
	if (rows.length === 0) return [`${DIM}no open pull requests${RESET}`];
	const numWidth = Math.max(...rows.map((r) => String(r.number).length));
	return rows.map((r) => {
		const num = `#${String(r.number).padStart(numWidth, " ")}`;
		const author = plain(r.author);
		const statuses = `${r.state === "open" ? "" : `${r.state}, `}${r.review}, ${r.checks}`;
		const fixed = `${num}  (${author}; ${statuses})`;
		const room = Math.max(8, width - fixed.length);
		const title = plain(r.title);
		const cut = title.length > room ? `${title.slice(0, Math.max(1, room - 1))}…` : title;
		const tinted = `${r.state === "open" ? "" : `${tint(r.state)}, `}${tint(r.review)}, ${tint(r.checks)}`;
		return `${BOLD}${num}${RESET} ${cut} ${DIM}(${author}; ${RESET}${tinted}${DIM})${RESET}`;
	});
}

export function checkRowLines(
	rows: { name: string; status: string; durationSec: number | null }[],
): string[] {
	if (rows.length === 0) return [`${DIM}no check runs${RESET}`];
	const pad = Math.max(...rows.map((r) => r.status.length));
	return rows.map((r) => {
		const dur = r.durationSec === null ? "" : ` ${DIM}${String(r.durationSec)}s${RESET}`;
		return `${tint(r.status)}${" ".repeat(pad - r.status.length)}  ${plain(r.name)}${dur}`;
	});
}

export function issueRowLines(
	rows: { number: number; title: string; labels: string[]; assignees: string[] }[],
	width: number,
): string[] {
	if (rows.length === 0) return [`${DIM}no matching issues${RESET}`];
	return rows.map((r) => {
		const labelText = r.labels.length === 0 ? "" : ` [${r.labels.map(plain).join(", ")}]`;
		const labels = r.labels.length === 0 ? "" : ` ${DIM}[${r.labels.map(plain).join(", ")}]${RESET}`;
		const who = r.assignees.length === 0 ? "unassigned" : r.assignees.map(plain).join(", ");
		const fixed = `#${String(r.number)} ${labelText} (${who})`;
		const room = Math.max(8, width - fixed.length);
		const title = plain(r.title);
		const cut = title.length > room ? `${title.slice(0, Math.max(1, room - 1))}…` : title;
		return `${BOLD}#${String(r.number)}${RESET} ${cut}${labels} ${DIM}(${who})${RESET}`;
	});
}

export function renderToolCall(tool: string, args: Record<string, unknown>): RenderedComponent {
	const repo = typeof args.repo === "string" ? ` ${plain(args.repo)}` : "";
	const number = typeof args.number === "number" ? ` #${String(args.number)}` : "";
	const ref = typeof args.ref === "string" ? ` ${plain(args.ref)}` : "";
	const label = tool.replace(/^github_/, "");
	return component(() => [`${DIM}github ${label}${repo}${number}${ref}${RESET}`]);
}

/* ------------------------- Component wrappers ------------------------- */

export function renderPullRows(rows: Parameters<typeof pullRowLines>[0]): RenderedComponent {
	return component((width) => pullRowLines(rows, width));
}

export function renderIssueRows(rows: Parameters<typeof issueRowLines>[0]): RenderedComponent {
	return component((width) => issueRowLines(rows, width));
}

export function renderCheckRows(rows: Parameters<typeof checkRowLines>[0]): RenderedComponent {
	return component(() => checkRowLines(rows));
}
