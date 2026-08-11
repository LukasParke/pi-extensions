export interface SlackDescription {
	kind: "slack";
	summary: string;
	needsCredential: true;
	segments: {
		id: string;
		label: string;
		description: string;
		searchable: boolean;
		fields: string[];
	}[];
	actions: { id: string; description: string; params: Record<string, string> }[];
	refuses: { id: string; reason: string }[];
}

export const SLACK_DESCRIPTION: SlackDescription = {
	kind: "slack",
	summary:
		"Slack channels and threads: list channels with their latest message, read a whole thread, search messages, and post. " +
		"Writes ask the user first.",
	needsCredential: true,
	segments: [
		{
			id: "channels",
			label: "Channels",
			description:
				"Channels this token can see, each with its latest message. Prefer an explicit `channels` list — listing every " +
				"channel in a workspace burns rate budget and is bounded + reported truncated when it runs. Privacy is a word " +
				"(`private` / `public`), never an icon alone.",
			searchable: true,
			fields: ["id", "name", "topic", "privacy", "memberCount", "latestText", "latestAt", "replyCount"],
		},
		{
			id: "thread",
			label: "One thread",
			description:
				"A whole thread in one call: every reply, the authors resolved to names, and a permalink when the token can make " +
				"one. This is the main read — a 40-message thread is one payload, not forty follow-ups.",
			searchable: false,
			fields: ["channel", "channelName", "ts", "permalink", "messages", "truncated"],
		},
		{
			id: "search",
			label: "Search",
			description:
				"Message search (`search.messages`). Needs a user token with `search:read` — a bot token is rejected by Slack " +
				"with a clear forbidden error rather than an empty hit list.",
			searchable: true,
			fields: ["channel", "channelName", "ts", "author", "text", "permalink", "at"],
		},
	],
	actions: [
		{
			id: "post",
			description:
				"Post a message to a channel, or reply in a thread when `threadTs` is set. The user confirms and sees the full " +
				"text first; nothing is posted if they decline.",
			params: {
				channel: "channel id (C…) or name",
				text: "the message body",
				threadTs: "optional parent message ts — set this to reply in-thread rather than top-level",
			},
		},
	],
	refuses: [
		{
			id: "delete_messages",
			reason:
				"Destroying a message erases a public record other people may be relying on. A mistaken post is corrected with a " +
				"follow-up, not memory-holed by an agent that misread a request.",
		},
		{
			id: "manage_channels",
			reason:
				"Creating, renaming or archiving a channel restructures a workspace other people live in. That is a governance " +
				"decision, not a side effect of a coding session.",
		},
		{
			id: "invite_users",
			reason:
				"Inviting someone into a channel is a social act and can expose private conversation. It belongs to whoever owns " +
				"the channel, not to a tool call.",
		},
		{
			id: "admin",
			reason:
				"Workspace admin — kick, suspend, change roles, install apps — is far outside the scope of a coding agent, and a " +
				"token that can do it should not be handed to one.",
		},
	],
};
