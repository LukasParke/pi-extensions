export interface SegmentDescription {
	id: string;
	label: string;
	description: string;
	searchable: boolean;
	fields: string[];
}

export interface ActionDescription {
	id: string;
	description: string;
	params: Record<string, string>;
}

export interface GitHubDescription {
	kind: "github";
	summary: string;
	segments: SegmentDescription[];
	actions: ActionDescription[];
	refuses: { id: string; reason: string }[];
}

export const GITHUB_DESCRIPTION: GitHubDescription = {
	kind: "github",
	summary:
		"GitHub pull requests, reviews, checks and issues. Reads without a repository argument when run inside a checkout. " +
		"Writes (comments and reviews) ask the user first.",
	segments: [
		{
			id: "prs",
			label: "Pull requests",
			description:
				"Open pull requests, most recently updated first, each with its review state and check rollup. " +
				"Check and review state is fetched for the first rows only, to stay inside the rate budget; " +
				'later rows report "no checks" rather than guessing.',
			searchable: true,
			fields: [
				"number",
				"title",
				"author",
				"state",
				"review",
				"checks",
				"branch",
				"baseBranch",
				"updatedAt",
				"url",
				"mergeable",
			],
		},
		{
			id: "pr",
			label: "One pull request",
			description:
				"A single pull request in full: body, changed files with patches, check runs, and reviews. " +
				"Files are capped and large or binary patches are omitted with a stated reason.",
			searchable: false,
			fields: [
				"number",
				"title",
				"body",
				"author",
				"state",
				"branch",
				"baseBranch",
				"url",
				"additions",
				"deletions",
				"changedFiles",
				"files",
				"checks",
				"reviews",
				"mergeable",
				"filesTruncated",
			],
		},
		{
			id: "issues",
			label: "Issues",
			description:
				"Open issues, filterable by label and assignee. Pull requests are excluded, though GitHub returns them " +
				"from the same endpoint.",
			searchable: true,
			fields: ["number", "title", "author", "state", "labels", "assignees", "comments", "updatedAt", "url"],
		},
		{
			id: "checks",
			label: "Checks",
			description:
				"Check runs for a ref (a branch, tag or SHA), each with its conclusion as a word and a duration.",
			searchable: false,
			fields: ["name", "status", "summary", "url", "durationSec"],
		},
	],
	actions: [
		{
			id: "comment",
			description:
				"Post a comment on a pull request or an issue. The user is asked to confirm before anything is posted.",
			params: {
				number: "the pull request or issue number",
				body: "the comment text, as markdown",
				repo: 'optional "owner/name"; inferred from the current checkout when omitted',
			},
		},
		{
			id: "review",
			description:
				"Submit a review: comment, approve, or request changes. The user is asked to confirm. " +
				"Requesting changes requires a body, because a blocked review with no explanation cannot be acted on.",
			params: {
				number: "the pull request number",
				event: "one of comment | approve | request_changes",
				body: "the review text; optional only for approve",
				repo: 'optional "owner/name"',
			},
		},
	],
	refuses: [
		{
			id: "merge",
			reason:
				"A merge cannot be undone, and a confirmation dialog is not sufficient protection for it. Use `gh pr merge`, " +
				"which is better at it and where the user is unambiguously the actor.",
		},
		{
			id: "close",
			reason:
				"Closing a PR or issue discards review context that is tedious to reconstruct. Same reasoning as merge.",
		},
		{
			id: "workflow_dispatch",
			reason:
				"Triggering CI spends someone else's compute and can deploy. An operator action, not an agent one.",
		},
		{
			id: "secrets",
			reason:
				"Reading or writing repository secrets is a credential operation. This extension holds one token and does not broker others.",
		},
		{
			id: "webhooks",
			reason:
				"Webhooks need an inbound URL. Reads poll and report when data is stale, rather than pretending to be live.",
		},
	],
};
