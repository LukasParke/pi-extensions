import type { ChannelRow, MessageRow, SearchRow } from "./viewmodel.ts";

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

export function channelLines(rows: ChannelRow[], width: number): string[] {
	if (rows.length === 0) return [`${DIM}no matching channels${RESET}`];
	const namePad = Math.max(...rows.map((r) => r.name.length + 1));
	return rows.map((r) => {
		const name = `#${plain(r.name)}`.padEnd(namePad);
		const meta = `${r.privacy}${r.replyCount > 0 ? `, ${String(r.replyCount)} ${r.replyCount === 1 ? "reply" : "replies"}` : ""}`;
		const fixed = `${name}  (${meta})`;
		const room = Math.max(8, width - fixed.length);
		const latest = plain(r.latestText).replace(/\s+/g, " ");
		const cut = latest.length > room ? `${latest.slice(0, Math.max(1, room - 1))}…` : latest;
		return `${BOLD}${name}${RESET} ${cut} ${DIM}(${plain(meta)})${RESET}`;
	});
}

export function messageLines(messages: MessageRow[], width: number): string[] {
	if (messages.length === 0) return [`${DIM}no messages${RESET}`];
	return messages.map((m) => {
		const who = plain(m.author);
		const marker = m.root ? `${BOLD}${who}${RESET}` : `${DIM}${who}${RESET}`;
		const body = plain(m.text).replace(/\s+/g, " ");
		const prefix = `${who}: `;
		const room = Math.max(8, width - prefix.length);
		const cut = body.length > room ? `${body.slice(0, Math.max(1, room - 1))}…` : body;
		return `${marker}: ${cut}`;
	});
}

export function searchLines(rows: SearchRow[], width: number): string[] {
	if (rows.length === 0) return [`${DIM}no matching messages${RESET}`];
	return rows.map((r) => {
		const head = `#${plain(r.channelName)} ${plain(r.author)}`;
		const body = plain(r.text).replace(/\s+/g, " ");
		const room = Math.max(8, width - head.length - 3);
		const cut = body.length > room ? `${body.slice(0, Math.max(1, room - 1))}…` : body;
		return `${BOLD}${head}${RESET} ${cut}`;
	});
}

export function renderChannels(rows: ChannelRow[]): RenderedComponent {
	return component((w) => channelLines(rows, w));
}

export function renderMessages(messages: MessageRow[]): RenderedComponent {
	return component((w) => messageLines(messages, w));
}

export function renderSearch(rows: SearchRow[]): RenderedComponent {
	return component((w) => searchLines(rows, w));
}

export function renderToolCall(tool: string, args: Record<string, unknown>): RenderedComponent {
	const label = tool.replace(/^slack_/, "");
	const channel =
		typeof args.channel === "string" ? ` #${plain(String(args.channel).replace(/^#/, ""))}` : "";
	const query = typeof args.query === "string" ? ` ${plain(args.query).slice(0, 40)}` : "";
	return component(() => [`${DIM}slack ${label}${channel}${query}${RESET}`]);
}
