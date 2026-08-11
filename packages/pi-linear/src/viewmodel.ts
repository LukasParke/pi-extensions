import { type ApiComment, type ApiIssue, priorityWord } from "./client.ts";

export interface IssueRow {
	id: string;
	identifier: string;
	title: string;
	state: string;
	priority: string;
	assignee: string;
	team: string;
	url: string;
	updatedAt: number;
}

export interface CommentRow {
	author: string;
	body: string;
	at: number;
}

export interface IssueDetail extends Omit<IssueRow, never> {
	description: string;
	comments: CommentRow[];
}

const ts = (s: string | null | undefined): number => (s == null ? 0 : Date.parse(s) || 0);

export function toIssueRow(i: ApiIssue): IssueRow {
	return {
		id: i.id,
		identifier: i.identifier,
		title: i.title,
		state: i.state?.name ?? "no state",
		priority: priorityWord(i.priority),
		assignee: i.assignee?.name ?? "unassigned",
		team: i.team?.key ?? "no team",
		url: i.url,
		updatedAt: ts(i.updatedAt),
	};
}

export function toComment(c: ApiComment): CommentRow {
	return { author: c.user?.name ?? "unknown", body: c.body, at: ts(c.createdAt) };
}

export function toIssueDetail(i: ApiIssue, comments: ApiComment[]): IssueDetail {
	return {
		...toIssueRow(i),
		description: i.description ?? "",
		comments: comments.map(toComment).sort((a, b) => a.at - b.at),
	};
}
