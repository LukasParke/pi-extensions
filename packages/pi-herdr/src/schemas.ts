import { Type } from "typebox";

export const dispatchSchema = Type.Union([
	Type.Object({
		agentName: Type.String(),
		paneId: Type.String(),
		workspaceId: Type.String(),
		worktreePath: Type.String(),
		branch: Type.String(),
		repoPath: Type.String(),
		briefPath: Type.Optional(Type.String()),
	}),
	Type.Object({ error: Type.String() }),
]);

export const statusSchema = Type.Object({
	status: Type.String(),
	cwd: Type.Optional(Type.String()),
	worktreePath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	matches: Type.Optional(Type.Array(Type.String())),
	note: Type.Optional(Type.String()),
	output: Type.String(),
});

export const cleanupSchema = Type.Object({
	cleaned: Type.Boolean(),
	problems: Type.Optional(Type.Array(Type.String())),
	reason: Type.Optional(Type.Union([Type.Literal("nothing-found"), Type.Literal("ambiguous")])),
	matches: Type.Optional(Type.Array(Type.String())),
	removal: Type.Optional(Type.Union([Type.Literal("herdr"), Type.Literal("git"), Type.Literal("gone")])),
	note: Type.Optional(Type.String()),
	workspaceId: Type.Union([Type.String(), Type.Null()]),
	worktreePath: Type.Union([Type.String(), Type.Null()]),
});
