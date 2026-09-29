import { Type } from "typebox";

const nullableString = Type.Union([Type.String(), Type.Null()]);
const nullableNumber = Type.Union([Type.Number(), Type.Null()]);
const rate = Type.Object({ remaining: nullableNumber, limit: nullableNumber, resetAt: nullableNumber });
const refusal = Type.Object({
	refused: Type.Literal(true),
	error: Type.String(),
	connected: Type.Optional(Type.Literal(false)),
	source: Type.Optional(Type.String()),
});
const issue = Type.Object({
	number: Type.Number(),
	title: Type.String(),
	author: Type.String(),
	state: Type.String(),
	labels: Type.Array(Type.String()),
	assignees: Type.Array(Type.String()),
	comments: Type.Number(),
	updatedAt: Type.Number(),
	url: Type.String(),
});
const pull = Type.Object({
	number: Type.Number(),
	title: Type.String(),
	author: Type.String(),
	state: Type.String(),
	review: Type.String(),
	checks: Type.String(),
	branch: Type.String(),
	baseBranch: Type.String(),
	updatedAt: Type.Number(),
	url: Type.String(),
	mergeable: nullableString,
});
const check = Type.Object({
	name: Type.String(),
	status: Type.String(),
	summary: nullableString,
	url: nullableString,
	durationSec: nullableNumber,
});
const description = Type.Object({
	kind: Type.Literal("github"),
	summary: Type.String(),
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

export const prsSchema = Type.Union([
	Type.Object({
		repo: Type.String(),
		segment: Type.Literal("prs"),
		rows: Type.Array(pull),
		rate,
		truncated: Type.Boolean(),
	}),
	// GitHub's search endpoint returns issue-shaped rows, including for PR searches.
	Type.Object({ repo: Type.String(), segment: Type.Literal("prs"), rows: Type.Array(issue), rate }),
	refusal,
]);
export const prSchema = Type.Union([
	Type.Object({
		repo: Type.String(),
		segment: Type.Literal("pr"),
		block: Type.Literal("pr"),
		rate,
		pr: Type.Object({
			number: Type.Number(),
			title: Type.String(),
			body: Type.String(),
			author: Type.String(),
			state: Type.String(),
			branch: Type.String(),
			baseBranch: Type.String(),
			url: Type.String(),
			additions: Type.Number(),
			deletions: Type.Number(),
			changedFiles: Type.Number(),
			mergeable: nullableString,
			filesTruncated: Type.Boolean(),
			checks: Type.Array(check),
			files: Type.Array(
				Type.Object({
					path: Type.String(),
					previousPath: nullableString,
					status: Type.String(),
					additions: Type.Number(),
					deletions: Type.Number(),
					patch: nullableString,
					patchOmitted: nullableString,
				}),
			),
			reviews: Type.Array(
				Type.Object({
					author: Type.String(),
					state: Type.String(),
					body: Type.String(),
					at: Type.Number(),
				}),
			),
		}),
	}),
	refusal,
]);
export const issuesSchema = Type.Union([
	Type.Object({ repo: Type.String(), segment: Type.Literal("issues"), rows: Type.Array(issue), rate }),
	refusal,
]);
export const checksSchema = Type.Union([
	Type.Object({
		repo: Type.String(),
		segment: Type.Literal("checks"),
		ref: Type.String(),
		rows: Type.Array(check),
		rollup: Type.String(),
		rate,
	}),
	refusal,
]);
export const commentSchema = Type.Union([
	Type.Object({ repo: Type.String(), posted: Type.Literal(true), url: Type.String(), rate }),
	refusal,
]);
export const reviewSchema = Type.Union([
	Type.Object({
		repo: Type.String(),
		posted: Type.Literal(true),
		url: Type.String(),
		state: Type.String(),
		rate,
	}),
	refusal,
]);
export const statusSchema = Type.Union([
	Type.Object({
		connected: Type.Literal(true),
		login: Type.String(),
		source: Type.String(),
		repo: nullableString,
		rate,
		describe: description,
	}),
	refusal,
]);
export const connectSchema = Type.Union([
	Type.Object({ connected: Type.Literal(true), login: Type.String() }),
	refusal,
]);
export const disconnectSchema = Type.Union([
	Type.Object({ disconnected: Type.Literal(true), hadStoredToken: Type.Boolean() }),
	refusal,
]);
