import { Type } from "typebox";

const nullableString = Type.Union([Type.String(), Type.Null()]);
const nullableNumber = Type.Union([Type.Number(), Type.Null()]);
const source = Type.Union([Type.Literal("env"), Type.Literal("integration-auth"), Type.Literal("cli")]);
const refusal = Type.Object(
	{
		refused: Type.Literal(true),
		error: Type.String(),
		connected: Type.Optional(Type.Literal(false)),
		source: Type.Optional(source),
	},
	{ additionalProperties: false },
);
const result = (properties: Parameters<typeof Type.Object>[0]) =>
	Type.Union([Type.Object(properties, { additionalProperties: false }), refusal]);
const rate = Type.Object({ remaining: nullableNumber, limit: nullableNumber, resetAt: nullableNumber });
const issueRow = {
	id: Type.String(),
	identifier: Type.String(),
	title: Type.String(),
	state: Type.String(),
	priority: Type.String(),
	assignee: Type.String(),
	team: Type.String(),
	url: Type.String(),
	updatedAt: Type.Number(),
};
const description = Type.Object({
	kind: Type.Literal("linear"),
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
});

export const issuesSchema = result({
	segment: Type.Literal("issues"),
	rows: Type.Array(Type.Object(issueRow)),
	rate,
});
export const issueSchema = result({
	segment: Type.Literal("issue"),
	block: Type.Literal("issue"),
	issue: Type.Object({
		...issueRow,
		description: Type.String(),
		comments: Type.Array(Type.Object({ author: Type.String(), body: Type.String(), at: Type.Number() })),
	}),
	rate,
});
export const statesSchema = result({
	segment: Type.Literal("states"),
	rows: Type.Array(Type.Object({ id: Type.String(), name: Type.String(), type: Type.String() })),
	rate,
});
export const commentSchema = result({
	posted: Type.Literal(true),
	id: Type.String(),
	url: nullableString,
	rate,
});
export const transitionSchema = result({ posted: Type.Literal(true), state: Type.String(), rate });
export const statusSchema = result({
	connected: Type.Literal(true),
	who: Type.Object({ name: Type.String(), email: nullableString }),
	source,
	describe: description,
});
export const connectSchema = result({ connected: Type.Literal(true), who: Type.String() });
export const disconnectSchema = result({ disconnected: Type.Literal(true), hadStoredKey: Type.Boolean() });
