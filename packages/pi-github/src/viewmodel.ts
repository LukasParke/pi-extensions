export interface PullRow {
	number: number;
	title: string;
	author: string;
	state: string;
	review: string;
	checks: string;
	branch: string;
	baseBranch: string;
	updatedAt: number;
	url: string;
	mergeable: string | null;
}

export interface IssueRow {
	number: number;
	title: string;
	author: string;
	state: string;
	labels: string[];
	assignees: string[];
	comments: number;
	updatedAt: number;
	url: string;
}

export interface CheckRow {
	name: string;
	status: string;
	summary: string | null;
	url: string | null;
	durationSec: number | null;
}

export interface ReviewRow {
	author: string;
	state: string;
	body: string;
	at: number;
}

export interface PullFile {
	path: string;
	previousPath: string | null;
	status: string;
	additions: number;
	deletions: number;
	patch: string | null;
	patchOmitted: string | null;
}

export interface PullDetail {
	number: number;
	title: string;
	body: string;
	author: string;
	state: string;
	branch: string;
	baseBranch: string;
	url: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	files: PullFile[];
	checks: CheckRow[];
	reviews: ReviewRow[];
	mergeable: string | null;
	filesTruncated: boolean;
}

/* ----------------------------- mapping ------------------------------ */

export interface ApiPull {
	number: number;
	title: string;
	body?: string | null;
	draft?: boolean;
	state: string;
	merged_at?: string | null;
	updated_at: string;
	html_url: string;
	user?: { login?: string } | null;
	head?: { ref?: string; sha?: string } | null;
	base?: { ref?: string } | null;
	additions?: number;
	deletions?: number;
	changed_files?: number;
	mergeable?: boolean | null;
	mergeable_state?: string | null;
	requested_reviewers?: { login?: string }[] | null;
}

export interface ApiIssue {
	number: number;
	title: string;
	body?: string | null;
	state: string;
	updated_at: string;
	html_url: string;
	comments?: number;
	user?: { login?: string } | null;
	labels?: ({ name?: string } | string)[] | null;
	assignees?: { login?: string }[] | null;
	pull_request?: unknown;
}

export interface ApiCheckRun {
	name: string;
	status: string;
	conclusion?: string | null;
	output?: { title?: string | null; summary?: string | null } | null;
	html_url?: string | null;
	started_at?: string | null;
	completed_at?: string | null;
}

export interface ApiReview {
	state: string;
	body?: string | null;
	submitted_at?: string | null;
	user?: { login?: string } | null;
}

export interface ApiFile {
	filename: string;
	previous_filename?: string | null;
	status: string;
	additions: number;
	deletions: number;
	patch?: string | null;
}

const ts = (s: string | null | undefined): number => (s == null ? 0 : Date.parse(s) || 0);
const login = (u: { login?: string } | null | undefined): string => u?.login ?? "unknown";

export function pullState(p: ApiPull): string {
	if (p.merged_at != null) return "merged";
	if (p.state === "closed") return "closed";
	return p.draft === true ? "draft" : "open";
}

export function mergeability(p: ApiPull): string | null {
	const state = p.mergeable_state;
	if (state == null) {
		return p.mergeable === false ? "conflicts with the base branch" : null;
	}
	switch (state) {
		case "clean":
		case "has_hooks":
		case "unstable":
			return null;
		case "dirty":
			return "conflicts with the base branch";
		case "blocked":
			return "blocked: a required review or check is missing";
		case "behind":
			return "behind the base branch";
		case "draft":
			return "still a draft";
		case "unknown":
			return null;
		default:
			return `GitHub reports "${state}"`;
	}
}

export function checkStatus(c: ApiCheckRun): string {
	if (c.status !== "completed") return "pending";
	switch (c.conclusion) {
		case "success":
			return "passing";
		case "failure":
		case "timed_out":
		case "action_required":
			return "failing";
		case "cancelled":
			return "cancelled";
		case "skipped":
			return "skipped";
		case "neutral":
			return "neutral";
		default:
			return c.conclusion == null ? "pending" : String(c.conclusion);
	}
}

export function checksRollup(runs: CheckRow[]): string {
	if (runs.length === 0) return "no checks";
	if (runs.some((r) => r.status === "failing")) return "failing";
	if (runs.some((r) => r.status === "pending")) return "pending";
	if (runs.some((r) => r.status === "passing")) return "passing";
	return "no checks";
}

export function reviewState(reviews: ReviewRow[], requestedReviewers: number): string {
	const latest = new Map<string, ReviewRow>();
	for (const r of reviews) {
		if (r.state === "commented" || r.state === "dismissed") continue;
		const prev = latest.get(r.author);
		if (prev === undefined || r.at >= prev.at) latest.set(r.author, r);
	}
	const states = [...latest.values()].map((r) => r.state);
	if (states.includes("changes requested")) return "changes requested";
	if (states.includes("approved")) return "approved";
	if (requestedReviewers > 0) return "review required";
	return "no reviews";
}

function reviewWord(state: string): string {
	switch (state.toUpperCase()) {
		case "APPROVED":
			return "approved";
		case "CHANGES_REQUESTED":
			return "changes requested";
		case "COMMENTED":
			return "commented";
		case "DISMISSED":
			return "dismissed";
		case "PENDING":
			return "pending";
		default:
			return state.toLowerCase();
	}
}

export function toReviewRow(r: ApiReview): ReviewRow {
	return {
		author: login(r.user),
		state: reviewWord(r.state),
		body: r.body ?? "",
		at: ts(r.submitted_at),
	};
}

export function toCheckRow(c: ApiCheckRun): CheckRow {
	const started = ts(c.started_at);
	const done = ts(c.completed_at);
	return {
		name: c.name,
		status: checkStatus(c),
		summary: c.output?.title ?? c.output?.summary ?? null,
		url: c.html_url ?? null,
		durationSec: started > 0 && done > started ? Math.round((done - started) / 1000) : null,
	};
}

export const MAX_PATCH_BYTES = 64 * 1024;

export function toPullFile(f: ApiFile): PullFile {
	const patch = f.patch ?? null;
	if (patch === null) {
		return {
			path: f.filename,
			previousPath: f.previous_filename ?? null,
			status: f.status,
			additions: f.additions,
			deletions: f.deletions,
			patch: null,
			patchOmitted: "binary, or larger than GitHub inlines",
		};
	}
	if (patch.length > MAX_PATCH_BYTES) {
		return {
			path: f.filename,
			previousPath: f.previous_filename ?? null,
			status: f.status,
			additions: f.additions,
			deletions: f.deletions,
			patch: null,
			patchOmitted: `${String(Math.round(patch.length / 1024))}KB — too large to inline; open it on GitHub`,
		};
	}
	return {
		path: f.filename,
		previousPath: f.previous_filename ?? null,
		status: f.status,
		additions: f.additions,
		deletions: f.deletions,
		patch,
		patchOmitted: null,
	};
}

export function toPullRow(p: ApiPull, checks: string, review: string): PullRow {
	return {
		number: p.number,
		title: p.title,
		author: login(p.user),
		state: pullState(p),
		review,
		checks,
		branch: p.head?.ref ?? "unknown",
		baseBranch: p.base?.ref ?? "unknown",
		updatedAt: ts(p.updated_at),
		url: p.html_url,
		mergeable: mergeability(p),
	};
}

export function toIssueRow(i: ApiIssue): IssueRow {
	return {
		number: i.number,
		title: i.title,
		author: login(i.user),
		state: i.state,
		labels: (i.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter((s) => s !== ""),
		assignees: (i.assignees ?? []).map(login),
		comments: i.comments ?? 0,
		updatedAt: ts(i.updated_at),
		url: i.html_url,
	};
}
