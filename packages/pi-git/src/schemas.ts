import { Type } from "typebox";

const nullableString = Type.Union([Type.String(), Type.Null()]);
const nullableNumber = Type.Union([Type.Number(), Type.Null()]);
const refusal = Type.Object(
	{ refused: Type.Literal(true), error: Type.String() },
	{ additionalProperties: false },
);
const result = (properties: Parameters<typeof Type.Object>[0]) =>
	Type.Union([Type.Object(properties, { additionalProperties: false }), refusal]);

const fileChange = Type.Object({
	path: Type.String(),
	status: Type.String(),
	staged: Type.Boolean(),
	oldPath: nullableString,
});
const diffLine = Type.Object({
	kind: Type.Union([Type.Literal("add"), Type.Literal("del"), Type.Literal("ctx"), Type.Literal("meta")]),
	text: Type.String(),
	oldLine: nullableNumber,
	newLine: nullableNumber,
});
const diffHunk = Type.Object({
	header: Type.String(),
	oldStart: Type.Number(),
	oldCount: Type.Number(),
	newStart: Type.Number(),
	newCount: Type.Number(),
	lines: Type.Array(diffLine),
	anchor: Type.String(),
});
const diffFile = Type.Object({
	path: Type.String(),
	oldPath: nullableString,
	status: Type.Union([
		Type.Literal("added"),
		Type.Literal("deleted"),
		Type.Literal("modified"),
		Type.Literal("renamed"),
		Type.Literal("copied"),
		Type.Literal("mode_changed"),
		Type.Literal("type_changed"),
	]),
	additions: Type.Number(),
	deletions: Type.Number(),
	hunks: Type.Array(diffHunk),
	binary: Type.Boolean(),
	oldMode: nullableString,
	newMode: nullableString,
	noNewlineAtEof: Type.Boolean(),
	truncated: Type.Boolean(),
});

export const statusSchema = result({
	cwd: Type.String(),
	status: Type.Object({
		isRepo: Type.Boolean(),
		branch: nullableString,
		detached: Type.Boolean(),
		ahead: Type.Number(),
		behind: Type.Number(),
		upstream: nullableString,
		files: Type.Array(fileChange),
		conflicted: Type.Boolean(),
		conflictPaths: Type.Array(Type.String()),
	}),
});
export const diffSchema = result({
	cwd: Type.String(),
	summary: Type.String(),
	diff: Type.Object({
		files: Type.Array(diffFile),
		additions: Type.Number(),
		deletions: Type.Number(),
		truncated: Type.Boolean(),
	}),
});
export const branchesSchema = result({
	cwd: Type.String(),
	branches: Type.Array(
		Type.Object({
			name: Type.String(),
			current: Type.Boolean(),
			upstream: nullableString,
			ahead: Type.Number(),
			behind: Type.Number(),
			subject: nullableString,
			at: nullableNumber,
		}),
	),
	worktrees: Type.Array(
		Type.Object({
			path: Type.String(),
			branch: nullableString,
			main: Type.Boolean(),
			detached: Type.Boolean(),
			locked: Type.Boolean(),
		}),
	),
});
export const checklistSchema = result({
	cwd: Type.String(),
	ready: Type.Boolean(),
	checks: Type.Array(
		Type.Object({
			name: Type.String(),
			state: Type.String(),
			detail: nullableString,
		}),
	),
});
export const logSchema = result({
	cwd: Type.String(),
	commits: Type.Array(Type.Object({ sha: Type.String(), subject: Type.String() })),
});
