import type { ApiChannel, ApiMessage, ApiSearchMatch, SlackClient } from "./client.ts";

export interface ChannelRow {
	id: string;
	name: string;
	topic: string;
	privacy: string;
	memberCount: number | null;
	latestText: string;
	latestAt: number;
	replyCount: number;
}

export interface MessageRow {
	author: string;
	text: string;
	at: number;
	ts: string;
	root: boolean;
}

export interface ThreadDetail {
	channel: string;
	channelName: string;
	ts: string;
	permalink: string;
	messages: MessageRow[];
	truncated: boolean;
}

export interface SearchRow {
	channel: string;
	channelName: string;
	ts: string;
	author: string;
	text: string;
	permalink: string;
	at: number;
}

const tsMs = (s: string | null | undefined): number => {
	if (s == null || s === "") return 0;
	const n = Number(s);
	return Number.isFinite(n) ? Math.floor(n * 1000) : 0;
};

export function toChannelRow(channel: ApiChannel, latest: ApiMessage | null): ChannelRow {
	return {
		id: channel.id,
		name: channel.name !== undefined && channel.name !== "" ? channel.name : channel.id,
		topic: channel.topic?.value ?? channel.purpose?.value ?? "",
		privacy: channel.is_private === true ? "private" : "public",
		memberCount: channel.num_members ?? null,
		latestText: latest?.text?.trim() ? latest.text.trim() : "no messages",
		latestAt: tsMs(latest?.ts),
		replyCount: latest?.reply_count ?? 0,
	};
}

export function toMessageRow(m: ApiMessage, author: string, root: boolean): MessageRow {
	return {
		author,
		text: m.text ?? "",
		at: tsMs(m.ts),
		ts: m.ts,
		root,
	};
}

export async function toThreadDetail(
	client: SlackClient,
	args: {
		channel: string;
		ts: string;
		messages: ApiMessage[];
		permalink: string | null;
		truncated: boolean;
		channelName?: string;
	},
): Promise<ThreadDetail> {
	const messages: MessageRow[] = [];
	for (const [i, m] of args.messages.entries()) {
		const author =
			m.username !== undefined && m.username !== ""
				? m.username
				: m.user !== undefined && m.user !== ""
					? await client.userName(m.user)
					: m.bot_id !== undefined
						? `bot:${m.bot_id}`
						: "unknown";
		messages.push(toMessageRow(m, author, i === 0));
	}
	return {
		channel: args.channel,
		channelName: args.channelName ?? args.channel,
		ts: args.ts,
		permalink: args.permalink ?? "",
		messages,
		truncated: args.truncated,
	};
}

export async function toSearchRow(client: SlackClient, m: ApiSearchMatch): Promise<SearchRow> {
	const author = m.username ?? (await client.userName(m.user));
	return {
		channel: m.channel?.id ?? "",
		channelName: m.channel?.name ?? m.channel?.id ?? "unknown",
		ts: m.ts,
		author,
		text: m.text ?? "",
		permalink: m.permalink ?? "",
		at: tsMs(m.ts),
	};
}
