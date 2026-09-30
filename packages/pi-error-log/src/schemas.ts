import { Type } from "typebox";

export const errorLogEntrySchema = Type.Object({
	ts: Type.String(),
	session: Type.Optional(Type.String()),
	cwd: Type.String(),
	kind: Type.Union([Type.Literal("tool"), Type.Literal("extension")]),
	tool: Type.Optional(Type.String()),
	toolCallId: Type.Optional(Type.String()),
	parentToolCallId: Type.Optional(Type.String()),
	args: Type.Optional(Type.String()),
	error: Type.Object({ message: Type.String(), stack: Type.Optional(Type.String()) }),
	model: Type.Optional(Type.Object({ provider: Type.String(), id: Type.String() })),
});

export const errorLogResultSchema = Type.Object({
	path: Type.Union([Type.String(), Type.Null()]),
	entries: Type.Array(errorLogEntrySchema),
});
