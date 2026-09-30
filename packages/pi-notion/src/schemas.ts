import { Type } from "typebox";

const nullableNumber = Type.Union([Type.Number(), Type.Null()]);
const rate = Type.Object({ remaining: nullableNumber, limit: nullableNumber, resetAt: nullableNumber });
const refusal = Type.Object({
	refused: Type.Literal(true),
	error: Type.String(),
	connected: Type.Optional(Type.Literal(false)),
	source: Type.Optional(Type.String()),
});
const pageFields = {
	id: Type.String(),
	title: Type.String(),
	url: Type.String(),
	lastEditedAt: Type.Number(),
	parent: Type.String(),
};
const block = Type.Union([
	Type.Object({
		type: Type.Literal("heading"),
		level: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
		text: Type.String(),
	}),
	Type.Object({ type: Type.Literal("paragraph"), text: Type.String() }),
	Type.Object({ type: Type.Literal("list"), ordered: Type.Boolean(), items: Type.Array(Type.String()) }),
	Type.Object({
		type: Type.Literal("code"),
		language: Type.Union([Type.String(), Type.Null()]),
		source: Type.String(),
	}),
	Type.Object({ type: Type.Literal("quote"), text: Type.String() }),
	Type.Object({ type: Type.Literal("divider") }),
	Type.Object({
		type: Type.Literal("table"),
		headers: Type.Array(Type.String()),
		rows: Type.Array(Type.Array(Type.String())),
	}),
	Type.Object({ type: Type.Literal("unsupported"), label: Type.String() }),
]);
const description = Type.Object({
	kind: Type.Literal("notion"),
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

export const searchSchema = Type.Union([
	Type.Object({
		segment: Type.Literal("pages"),
		rows: Type.Array(Type.Object(pageFields)),
		truncated: Type.Boolean(),
		rate,
	}),
	refusal,
]);
export const pageSchema = Type.Union([
	Type.Object({
		segment: Type.Literal("page"),
		block: Type.Literal("page"),
		rate,
		page: Type.Object({ ...pageFields, blocks: Type.Array(block), truncated: Type.Boolean() }),
	}),
	refusal,
]);
export const appendSchema = Type.Union([
	Type.Object({
		posted: Type.Literal(true),
		firstBlockId: Type.Union([Type.String(), Type.Null()]),
		paragraphs: Type.Number(),
		rate,
	}),
	refusal,
]);
export const statusSchema = Type.Union([
	Type.Object({
		connected: Type.Literal(true),
		who: Type.Object({ name: Type.String(), type: Type.String() }),
		source: Type.String(),
		describe: description,
	}),
	refusal,
]);
export const connectSchema = Type.Union([
	Type.Object({ connected: Type.Literal(true), who: Type.String() }),
	refusal,
]);
export const disconnectSchema = Type.Union([
	Type.Object({ disconnected: Type.Literal(true), hadStoredKey: Type.Boolean() }),
	refusal,
]);
