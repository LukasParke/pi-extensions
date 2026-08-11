export interface LinearDescription {
	kind: "linear";
	summary: string;
	needsCredential: true;
	segments: {
		id: string;
		label: string;
		description: string;
		searchable: boolean;
		fields: string[];
	}[];
	actions: { id: string; description: string; params: Record<string, string> }[];
	refuses: { id: string; reason: string }[];
}

export const LINEAR_DESCRIPTION: LinearDescription = {
	kind: "linear",
	summary:
		"Linear issues: read and search them, read one with its comments, comment, and move an issue between workflow states. " +
		"Writes ask the user first.",
	needsCredential: true,
	segments: [
		{
			id: "issues",
			label: "Issues",
			description:
				"Issues, defaulting to assigned-to-me and not-done — the set a developer acts on. Pass mine:false for the whole " +
				"workspace, or a state name to filter. Priority is reported as a word, not Linear's 0-4.",
			searchable: true,
			fields: ["id", "identifier", "title", "state", "priority", "assignee", "team", "url", "updatedAt"],
		},
		{
			id: "issue",
			label: "One issue",
			description: "A single issue in full with its comments, so reviewing one costs a single call.",
			searchable: false,
			fields: [
				"id",
				"identifier",
				"title",
				"description",
				"state",
				"priority",
				"assignee",
				"team",
				"url",
				"comments",
			],
		},
		{
			id: "states",
			label: "Workflow states",
			description:
				"The workflow states a team has. Read this before transitioning: it is what makes a state name a real choice " +
				"rather than a guess.",
			searchable: false,
			fields: ["id", "name", "type"],
		},
	],
	actions: [
		{
			id: "comment",
			description: "Post a comment on an issue. The user confirms before anything is posted.",
			params: {
				issue: "the issue id or identifier, e.g. DEV-412",
				body: "the comment, as markdown",
			},
		},
		{
			id: "transition",
			description:
				"Move an issue to a different workflow state, by name. The user confirms. Read `states` first if unsure — the " +
				"error lists the valid names, but a wasted call is still a wasted call.",
			params: {
				issue: "the issue id or identifier",
				state: 'the target state name, e.g. "In Review"',
			},
		},
	],
	refuses: [
		{
			id: "create",
			reason:
				"A created issue notifies a team and enters someone else's backlog. An agent that misunderstands a request creates " +
				"work for people who did not ask, and deleting it does not un-notify them.",
		},
		{
			id: "delete",
			reason: "Destroys an issue and its comment history, which is often the only record of a decision.",
		},
		{
			id: "assign",
			reason:
				"Assigning work to a person is a social act, not a data edit. It belongs to whoever is accountable for it.",
		},
		{
			id: "estimate",
			reason: "An estimate an agent invented is worse than no estimate, because it will be planned against.",
		},
	],
};
