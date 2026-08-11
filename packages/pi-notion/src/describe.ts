export interface NotionDescription {
	kind: "notion";
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

export const NOTION_DESCRIPTION: NotionDescription = {
	kind: "notion",
	summary:
		"Notion pages: search the ones an integration can see, read one page as structured blocks, and append plain-text " +
		"paragraphs. Writes ask the user first. Unsupported block types are labelled rather than dropped, so a page never " +
		"looks complete when it is not.",
	needsCredential: true,
	segments: [
		{
			id: "pages",
			label: "Pages",
			description:
				"Pages this integration can see, most recently edited first. Pass a query to search titles and body text. The list " +
				"is bounded and reports when it was cut short — a partial list that does not say so makes a count a lie.",
			searchable: true,
			fields: ["id", "title", "url", "lastEditedAt", "parent"],
		},
		{
			id: "page",
			label: "One page",
			description:
				"A single page in full: title, parent, url, and its direct child blocks reduced to a small union. Blocks Notion " +
				"has and this package does not render appear as `unsupported` with the original type as the label — never as a " +
				"silent gap. Nested children past the first level are not recursed; truncation is reported when the block list " +
				"hits the page budget.",
			searchable: false,
			fields: ["id", "title", "url", "lastEditedAt", "parent", "blocks", "truncated"],
		},
	],
	actions: [
		{
			id: "append",
			description:
				"Append plain-text paragraphs to a page, one per non-empty line. The user confirms and sees the full text first. " +
				"Not a markdown converter: headings arrive as paragraphs containing `#`, which is ugly and honest rather than a " +
				"half-parsed tree.",
			params: {
				page: "the page id to append to",
				text: "the content to append; blank lines separate paragraphs",
			},
		},
	],
	refuses: [
		{
			id: "delete_page",
			reason:
				"Deleting a page destroys its history and every backlink that pointed at it. A confirmation dialog is not enough " +
				"protection for that; it belongs to a human in Notion's own UI, which at least shows what else will break.",
		},
		{
			id: "create_database",
			reason:
				"A database is a shared schema other people's views and automations depend on. An agent-created one is almost " +
				"always the wrong shape, and cleaning it up costs the team more than creating it saved.",
		},
		{
			id: "modify_schema",
			reason:
				"Renaming a property or changing its type quietly breaks every filter, rollup and integration that keyed on the " +
				"old one. Schema edits are an owner action, not a turn in a conversation.",
		},
		{
			id: "admin",
			reason:
				"Workspace membership, permissions and billing are not page content. This package holds a content token and does " +
				"not pretend it is an admin console.",
		},
	],
};
