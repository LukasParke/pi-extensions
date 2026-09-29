import { Type } from "typebox";

export const sentinelSchema = Type.Object({
	name: Type.String(),
	kind: Type.Union([Type.Literal("watch"), Type.Literal("sleep"), Type.Literal("pr")]),
	mode: Type.Optional(Type.Union([Type.Literal("poll"), Type.Literal("stream")])),
	command: Type.Optional(Type.String()),
	note: Type.Optional(Type.String()),
	state: Type.Union(
		["waiting", "running", "passing", "failing", "failed", "complete", "timeout"].map((state) =>
			Type.Literal(state),
		),
	),
	createdAt: Type.Number(),
	nextPollAt: Type.Optional(Type.Number()),
	lastOutput: Type.Optional(Type.String()),
});

export const gateSchema = Type.Object({
	active: Type.Boolean(),
	complete: Type.Boolean(),
	quietForMs: Type.Number(),
	passingSince: Type.Optional(Type.Number()),
	nextPollAt: Type.Optional(Type.Number()),
	criteria: Type.Array(
		Type.Object({
			name: Type.String(),
			state: Type.Union([Type.Literal("waiting"), Type.Literal("passing"), Type.Literal("failing")]),
			lastOutput: Type.Optional(Type.String()),
		}),
	),
});

export const statusSchema = Type.Object({
	items: Type.Array(sentinelSchema),
	gate: Type.Optional(gateSchema),
});
