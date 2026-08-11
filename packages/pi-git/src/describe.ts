export interface SegmentDescription {
	id: string;
	label: string;
	description: string;
	searchable: boolean;
	fields: string[];
}

export interface GitDescription {
	kind: "git";
	summary: string;
	needsCredential: false;
	segments: SegmentDescription[];
	actions: { id: string; description: string; params: Record<string, string> }[];
	refuses: { id: string; reason: string }[];
}

export const GIT_DESCRIPTION: GitDescription = {
	kind: "git",
	summary:
		"Local git: parsed status, diffs, branches, commits, and a pre-PR readiness checklist. Needs no credential and makes " +
		"no network call. Every operation is a read.",
	needsCredential: false,
	segments: [
		{
			id: "changes",
			label: "Changes",
			description:
				"Working-tree status: the branch, its position against upstream, and every changed file with its state as a word " +
				"(modified, added, untracked, renamed) rather than a porcelain letter code.",
			searchable: false,
			fields: [
				"isRepo",
				"branch",
				"detached",
				"ahead",
				"behind",
				"upstream",
				"files",
				"conflicted",
				"conflictPaths",
			],
		},
		{
			id: "diff",
			label: "Diff",
			description:
				"A parsed diff for the working tree, the index, or a revision range. Renames are detected, so a refactor is not " +
				"reported as twice its real size. Binary files are labelled rather than rendered.",
			searchable: false,
			fields: ["files", "additions", "deletions", "truncated"],
		},
		{
			id: "branches",
			label: "Branches",
			description:
				"Local branches with upstream, ahead/behind counts and each last commit subject — scannable without a call per " +
				"branch. Optionally the linked worktrees too.",
			searchable: false,
			fields: ["name", "current", "upstream", "ahead", "behind", "subject", "at"],
		},
		{
			id: "checklist",
			label: "Checklist",
			description:
				"Pre-PR readiness: conflicts, working-tree cleanliness, and the verification commands the caller supplies. An " +
				"unconfigured check does NOT pass — a green checklist with nothing set up produces false confidence.",
			searchable: false,
			fields: ["ready", "checks"],
		},
		{
			id: "log",
			label: "Log",
			description: "Commits in a range, newest first, with their subject. For summarising what changed.",
			searchable: false,
			fields: ["sha", "subject"],
		},
	],
	actions: [],
	refuses: [
		{
			id: "commit",
			reason:
				"Writing history is the user's act. An agent that can commit can also commit something the user did not read, and " +
				"`git commit` is one keystroke away for them.",
		},
		{
			id: "push",
			reason:
				"Publishes to a remote and can trigger CI or a deploy. Irreversible in the sense that matters: others see it.",
		},
		{
			id: "checkout",
			reason:
				"Changes what every other tool in the session is looking at, including files the user has open. A silent working-tree " +
				"switch is the most confusing thing an agent can do to a repository.",
		},
		{
			id: "reset",
			reason: "Discards work with no undo. No confirmation dialog is sufficient protection for `--hard`.",
		},
		{
			id: "rebase",
			reason:
				"Rewrites history and can end mid-conflict, leaving a repository in a state the user did not ask for.",
		},
		{
			id: "clean",
			reason: "Deletes untracked files, which by definition git cannot recover.",
		},
	],
};
