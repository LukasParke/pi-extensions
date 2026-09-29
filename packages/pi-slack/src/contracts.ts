import { Type, type TSchema } from "typebox";

export const namespace = { name: "slack", description: "Slack conversations and credentials" };

const nullableNumber = Type.Union([Type.Number(), Type.Null()]);
const rate = Type.Object({ remaining: nullableNumber, limit: nullableNumber, resetAt: nullableNumber });
const refusal = Type.Object({
	refused: Type.Literal(true),
	error: Type.String(),
	connected: Type.Optional(Type.Literal(false)),
	source: Type.Optional(Type.String()),
});
const withRefusal = <T extends TSchema>(success: T) => Type.Union([success, refusal]);

const message = Type.Object({
	author: Type.String(),
	text: Type.String(),
	at: Type.Number(),
	ts: Type.String(),
	root: Type.Boolean(),
});

export const channelsSchema = withRefusal(
	Type.Object({
		segment: Type.Literal("channels"),
		rows: Type.Array(
			Type.Object({
				id: Type.String(),
				name: Type.String(),
				topic: Type.String(),
				privacy: Type.String(),
				memberCount: nullableNumber,
				latestText: Type.String(),
				latestAt: Type.Number(),
				replyCount: Type.Number(),
			}),
		),
		truncated: Type.Boolean(),
		rate,
	}),
);

export const threadSchema = withRefusal(
	Type.Object({
		segment: Type.Literal("thread"),
		block: Type.Literal("thread"),
		thread: Type.Object({
			channel: Type.String(),
			channelName: Type.String(),
			ts: Type.String(),
			permalink: Type.String(),
			messages: Type.Array(message),
			truncated: Type.Boolean(),
		}),
		rate,
	}),
);

export const searchSchema = withRefusal(
	Type.Object({
		segment: Type.Literal("search"),
		rows: Type.Array(
			Type.Object({
				channel: Type.String(),
				channelName: Type.String(),
				ts: Type.String(),
				author: Type.String(),
				text: Type.String(),
				permalink: Type.String(),
				at: Type.Number(),
			}),
		),
		truncated: Type.Boolean(),
		rate,
	}),
);

export const postSchema = withRefusal(
	Type.Object({ posted: Type.Literal(true), channel: Type.String(), ts: Type.String(), rate }),
);

export const statusSchema = withRefusal(
	Type.Object({
		connected: Type.Literal(true),
		who: Type.Object({
			team: Type.String(),
			user: Type.String(),
			userId: Type.String(),
			botId: Type.Union([Type.String(), Type.Null()]),
		}),
		source: Type.String(),
		describe: Type.Object({
			kind: Type.Literal("slack"),
			summary: Type.String(),
			needsCredential: Type.Literal(true),
			segments: Type.Array(
				Type.Object({
					id: Type.String(),
					label: Type.String(),
					description: Type.String(),
					searchable: Type.Boolean(),
					fields: Type.Array(Type.String()),
				}),
			),
			actions: Type.Array(
				Type.Object({
					id: Type.String(),
					description: Type.String(),
					params: Type.Record(Type.String(), Type.String()),
				}),
			),
			refuses: Type.Array(Type.Object({ id: Type.String(), reason: Type.String() })),
		}),
	}),
);

export const connectSchema = withRefusal(Type.Object({ connected: Type.Literal(true), who: Type.String() }));
export const disconnectSchema = withRefusal(
	Type.Object({ disconnected: Type.Literal(true), hadStoredKey: Type.Boolean() }),
);
