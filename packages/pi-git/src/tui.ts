export interface RenderedComponent {
	render(width: number): string[];
	invalidate(): void;
}

export function component(lines: (width: number) => string[]): RenderedComponent {
	return { render: (width) => lines(width), invalidate: () => undefined };
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

function tint(state: string): string {
	switch (state) {
		case "passing":
			return `${GREEN}${state}${RESET}`;
		case "failing":
		case "timed out":
			return `${RED}${state}${RESET}`;
		case "warning":
		case "not configured":
			return `${YELLOW}${state}${RESET}`;
		default:
			return `${DIM}${state}${RESET}`;
	}
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
): string[] {
	const head: string[] = [];
	const branch = st.branch === null ? "(detached)" : plain(st.branch);
	const tracking =
		st.ahead === 0 && st.behind === 0
			? ""
			: ` ${DIM}(${st.ahead > 0 ? `↑${String(st.ahead)}` : ""}${st.behind > 0 ? `↓${String(st.behind)}` : ""})${RESET}`;
	head.push(`${BOLD}${branch}${RESET}${tracking}`);
	if (st.conflicted) head.push(`${RED}conflicts unresolved${RESET}`);
	if (st.files.length === 0) {
		head.push(`${DIM}clean${RESET}`);
		return head;
	}

	const pad = Math.max(...st.files.map((f) => f.status.length));
	for (const f of st.files.slice(0, 50)) {
		const room = Math.max(8, width - pad - 4);
		const path = plain(f.path);
		const cut = path.length > room ? `…${path.slice(-(room - 1))}` : path;
		const staged = f.staged ? "" : `${DIM} (unstaged)${RESET}`;
		head.push(`${DIM}${f.status.padEnd(pad)}${RESET}  ${cut}${staged}`);
	}
	if (st.files.length > 50) head.push(`${DIM}… and ${String(st.files.length - 50)} more${RESET}`);
	return head;
}

export function branchLines(
	rows: {
		name: string;
		current: boolean;
		ahead: number;
		behind: number;
		upstream: string | null;
	}[],
	width: number,
): string[] {
	if (rows.length === 0) return [`${DIM}no branches${RESET}`];
	const pad = Math.min(40, Math.max(...rows.map((r) => r.name.length)));
	return rows.map((r) => {
		const mark = r.current ? `${BOLD}*${RESET}` : " ";
		const name = plain(r.name);
		const shown = name.length > pad ? `${name.slice(0, pad - 1)}…` : name.padEnd(pad);
		const track =
			r.upstream === null
				? `${DIM}no upstream${RESET}`
				: `${DIM}${plain(r.upstream)}${r.ahead > 0 ? ` ↑${String(r.ahead)}` : ""}${r.behind > 0 ? ` ↓${String(r.behind)}` : ""}${RESET}`;
		void width;
		return `${mark} ${shown}  ${track}`;
	});
}

export function checklistLines(result: {
	ready: boolean;
	checks: { name: string; state: string; detail: string | null }[];
}): string[] {
	const pad = Math.max(...result.checks.map((c) => c.state.length), 1);
	const rows = result.checks.map((c) => {
		const detail = c.detail === null ? "" : `  ${DIM}${plain(c.detail).split("\n")[0] ?? ""}${RESET}`;
		return `${tint(c.state)}${" ".repeat(Math.max(0, pad - c.state.length))}  ${c.name}${detail}`;
	});
	rows.unshift(result.ready ? `${GREEN}ready${RESET}` : `${YELLOW}not ready${RESET}`);
	return rows;
}

export function diffLines(
	files: { path: string; status: string; additions: number; deletions: number }[],
	width: number,
): string[] {
	if (files.length === 0) return [`${DIM}no changes${RESET}`];
	const pad = Math.min(50, Math.max(...files.map((f) => f.path.length)));
	return files.map((f) => {
		const path = plain(f.path);
		const shown = path.length > pad ? `…${path.slice(-(pad - 1))}` : path.padEnd(pad);
		void width;
		return `${shown}  ${GREEN}+${String(f.additions)}${RESET}/${RED}−${String(f.deletions)}${RESET} ${DIM}${f.status}${RESET}`;
	});
}

export function renderStatus(st: Parameters<typeof statusLines>[0]): RenderedComponent {
	return component((w) => statusLines(st, w));
}
export function renderBranches(rows: Parameters<typeof branchLines>[0]): RenderedComponent {
	return component((w) => branchLines(rows, w));
}
export function renderChecklist(r: Parameters<typeof checklistLines>[0]): RenderedComponent {
	return component(() => checklistLines(r));
}
export function renderDiff(files: Parameters<typeof diffLines>[0]): RenderedComponent {
	return component((w) => diffLines(files, w));
}

export function renderToolCall(tool: string, args: Record<string, unknown>): RenderedComponent {
	const label = tool.replace(/^git_/, "");
	const target =
		typeof args.path === "string"
			? ` ${plain(args.path)}`
			: typeof args.ref === "string"
				? ` ${plain(args.ref)}`
				: "";
	return component(() => [`${DIM}git ${label}${target}${RESET}`]);
}
