import type { PageBlock, PageRow } from "./viewmodel.ts";

export interface RenderedComponent {
	render(width: number): string[];
	invalidate(): void;
}

export function component(lines: (width: number) => string[]): RenderedComponent {
	return { render: (width) => lines(width), invalidate: () => undefined };
}

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

export function plain(s: string): string {
	return s.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
}

export function pageLines(rows: PageRow[], width: number): string[] {
	if (rows.length === 0) return [`${DIM}no matching pages${RESET}`];
	return rows.map((r) => {
		const title = plain(r.title);
		const meta = plain(r.parent);
		const fixed = `  (${meta})`;
		const room = Math.max(8, width - fixed.length);
		const cut = title.length > room ? `${title.slice(0, Math.max(1, room - 1))}…` : title;
		return `${BOLD}${cut}${RESET} ${DIM}(${meta})${RESET}`;
	});
}

export function renderPages(rows: PageRow[]): RenderedComponent {
	return component((w) => pageLines(rows, w));
}

export function blockLines(blocks: PageBlock[], width: number): string[] {
	if (blocks.length === 0) return [`${DIM}(empty page)${RESET}`];
	const out: string[] = [];
	for (const b of blocks) {
		switch (b.type) {
			case "heading": {
				const t = plain(b.text);
				out.push(`${BOLD}${plain("#".repeat(b.level))} ${t}${RESET}`);
				break;
			}
			case "paragraph": {
				out.push(...wrap(plain(b.text), width));
				break;
			}
			case "list": {
				for (let i = 0; i < b.items.length; i++) {
					const item = b.items[i] ?? "";
					const bullet = b.ordered ? `${String(i + 1)}.` : "•";
					out.push(...wrap(`${bullet} ${plain(item)}`, width));
				}
				break;
			}
			case "code": {
				out.push(`${DIM}\`\`\`${plain(b.language ?? "")}${RESET}`);
				for (const line of plain(b.source).split("\n")) out.push(`  ${line}`);
				out.push(`${DIM}\`\`\`${RESET}`);
				break;
			}
			case "quote": {
				for (const line of wrap(plain(b.text), Math.max(4, width - 2))) out.push(`${DIM}│${RESET} ${line}`);
				break;
			}
			case "divider":
				out.push(`${DIM}${"─".repeat(Math.max(4, Math.min(width, 40)))}${RESET}`);
				break;
			case "table": {
				out.push(`${DIM}[table]${RESET} ${plain(b.headers.join(" | "))}`);
				for (const row of b.rows) out.push(`  ${plain(row.join(" | "))}`);
				break;
			}
			case "unsupported":
				out.push(`${DIM}[unsupported: ${plain(b.label)}]${RESET}`);
				break;
			default: {
				const never: never = b;
				out.push(String(never));
			}
		}
	}
	return out;
}

export function renderBlocks(blocks: PageBlock[]): RenderedComponent {
	return component((w) => blockLines(blocks, w));
}

export function renderToolCall(tool: string, args: Record<string, unknown>): RenderedComponent {
	const label = tool.replace(/^notion_/, "");
	const target =
		typeof args.page === "string"
			? ` ${plain(args.page)}`
			: typeof args.query === "string"
				? ` ${plain(args.query)}`
				: "";
	return component(() => [`${DIM}notion ${label}${target}${RESET}`]);
}

function wrap(text: string, width: number): string[] {
	if (text === "") return [""];
	if (width < 8) return [text];
	const words = text.split(/\s+/);
	const lines: string[] = [];
	let cur = "";
	for (const w of words) {
		if (cur === "") {
			cur = w;
			continue;
		}
		if (`${cur} ${w}`.length <= width) {
			cur = `${cur} ${w}`;
		} else {
			lines.push(cur);
			cur = w;
		}
	}
	if (cur !== "") lines.push(cur);
	return lines;
}
