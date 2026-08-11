import type { HttpClient } from "@parke.dev/pi-integration-http";
import { type ApiOptions, githubApi, HttpError, type RateInfo } from "./api.ts";
import type { RepoRef } from "./repo.ts";
import {
	type ApiCheckRun,
	type ApiFile,
	type ApiIssue,
	type ApiPull,
	type ApiReview,
	type CheckRow,
	checksRollup,
	type IssueRow,
	mergeability,
	type PullDetail,
	type PullRow,
	pullState,
	type ReviewRow,
	reviewState,
	toCheckRow,
	toIssueRow,
	toPullFile,
	toPullRow,
	toReviewRow,
} from "./viewmodel.ts";

export interface WithRate<T> {
	data: T;
	rate: RateInfo;
	truncated?: boolean;
}

export const MAX_FILES = 50;

export class GitHubClient {
	private readonly api: HttpClient;

	constructor(opts: ApiOptions) {
		this.api = githubApi(opts);
	}

	async viewer(): Promise<WithRate<{ login: string; name: string | null }>> {
		const res = await this.api.request<{ login: string; name?: string | null }>({
			method: "GET",
			path: "/user",
		});
		return { data: { login: res.data.login, name: res.data.name ?? null }, rate: res.rate };
	}

	async pulls(
		repo: RepoRef,
		opts: { limit?: number; state?: "open" | "closed" | "all"; enrich?: number } = {},
	): Promise<WithRate<PullRow[]>> {
		const limit = Math.min(opts.limit ?? 20, 100);
		const page = await this.api.paginate<ApiPull>(
			{
				method: "GET",
				path: `/repos/${repo.slug}/pulls?state=${opts.state ?? "open"}&sort=updated&direction=desc&per_page=${String(Math.min(limit, 100))}`,
			},
			{ limit, maxPages: 2 },
		);

		const enrich = Math.min(opts.enrich ?? 10, page.items.length);
		const rows: PullRow[] = [];
		let rate = page.rate;

		for (let i = 0; i < page.items.length; i++) {
			const p = page.items[i];
			if (p === undefined) continue;
			if (i >= enrich) {
				rows.push(
					toPullRow(p, "no checks", p.requested_reviewers?.length ? "review required" : "no reviews"),
				);
				continue;
			}
			try {
				const [checks, reviews] = await Promise.all([
					this.checks(repo, p.head?.sha ?? ""),
					this.reviews(repo, p.number),
				]);
				rate = checks.rate.remaining !== null ? checks.rate : rate;
				rows.push(
					toPullRow(
						p,
						checksRollup(checks.data),
						reviewState(reviews.data, p.requested_reviewers?.length ?? 0),
					),
				);
			} catch {
				rows.push(toPullRow(p, "no checks", "no reviews"));
			}
		}

		return { data: rows, rate, truncated: page.truncated };
	}

	async pull(repo: RepoRef, number: number): Promise<WithRate<PullDetail>> {
		const res = await this.api.request<ApiPull>({
			method: "GET",
			path: `/repos/${repo.slug}/pulls/${String(number)}`,
		});
		const p = res.data;

		const files = await this.api.paginate<ApiFile>(
			{ method: "GET", path: `/repos/${repo.slug}/pulls/${String(number)}/files?per_page=100` },
			{ limit: MAX_FILES, maxPages: 2 },
		);
		const [checks, reviews] = await Promise.all([
			this.checks(repo, p.head?.sha ?? "").catch(() => ({
				data: [] as CheckRow[],
				rate: res.rate,
			})),
			this.reviews(repo, number).catch(() => ({ data: [] as ReviewRow[], rate: res.rate })),
		]);

		return {
			data: {
				number: p.number,
				title: p.title,
				body: p.body ?? "",
				author: p.user?.login ?? "unknown",
				state: pullState(p),
				branch: p.head?.ref ?? "unknown",
				baseBranch: p.base?.ref ?? "unknown",
				url: p.html_url,
				additions: p.additions ?? 0,
				deletions: p.deletions ?? 0,
				changedFiles: p.changed_files ?? files.items.length,
				files: files.items.map(toPullFile),
				checks: checks.data,
				reviews: reviews.data,
				mergeable: mergeability(p),
				filesTruncated: files.truncated,
			},
			rate: res.rate,
		};
	}

	async checks(repo: RepoRef, ref: string): Promise<WithRate<CheckRow[]>> {
		if (ref.trim() === "") {
			return { data: [], rate: { remaining: null, limit: null, resetAt: null } };
		}
		const res = await this.api.request<{ check_runs?: ApiCheckRun[] }>({
			method: "GET",
			path: `/repos/${repo.slug}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
		});
		return { data: (res.data.check_runs ?? []).map(toCheckRow), rate: res.rate };
	}

	async reviews(repo: RepoRef, number: number): Promise<WithRate<ReviewRow[]>> {
		const res = await this.api.paginate<ApiReview>(
			{ method: "GET", path: `/repos/${repo.slug}/pulls/${String(number)}/reviews?per_page=100` },
			{ limit: 100, maxPages: 2 },
		);
		return { data: res.items.map(toReviewRow), rate: res.rate };
	}

	async issues(
		repo: RepoRef,
		opts: {
			limit?: number;
			state?: "open" | "closed" | "all";
			labels?: string;
			assignee?: string;
		} = {},
	): Promise<WithRate<IssueRow[]>> {
		const limit = Math.min(opts.limit ?? 20, 100);
		const params = new URLSearchParams({
			state: opts.state ?? "open",
			sort: "updated",
			direction: "desc",
			per_page: String(Math.min(limit * 2, 100)),
		});
		if (opts.labels !== undefined && opts.labels !== "") params.set("labels", opts.labels);
		if (opts.assignee !== undefined && opts.assignee !== "") params.set("assignee", opts.assignee);

		const page = await this.api.paginate<ApiIssue>(
			{ method: "GET", path: `/repos/${repo.slug}/issues?${params.toString()}` },
			{ limit: limit * 2, maxPages: 2 },
		);
		const issues = page.items.filter((i) => i.pull_request === undefined).slice(0, limit);
		return { data: issues.map(toIssueRow), rate: page.rate, truncated: page.truncated };
	}

	async search(repo: RepoRef, q: string, kind: "pr" | "issue", limit = 20): Promise<WithRate<IssueRow[]>> {
		const query = `repo:${repo.slug} is:${kind === "pr" ? "pr" : "issue"} ${q}`.trim();
		const res = await this.api.request<{ items?: ApiIssue[] }>({
			method: "GET",
			path: `/search/issues?q=${encodeURIComponent(query)}&per_page=${String(Math.min(limit, 100))}`,
		});
		return { data: (res.data.items ?? []).map(toIssueRow), rate: res.rate };
	}

	/* ------------------------------- writes ------------------------------- */

	async comment(repo: RepoRef, number: number, body: string): Promise<WithRate<{ url: string }>> {
		if (body.trim() === "") {
			throw new HttpError("invalid_request", "refusing to post an empty comment", {
				retriable: false,
			});
		}
		const res = await this.api.request<{ html_url: string }>({
			method: "POST",
			path: `/repos/${repo.slug}/issues/${String(number)}/comments`,
			body: { body },
		});
		return { data: { url: res.data.html_url }, rate: res.rate };
	}

	async review(
		repo: RepoRef,
		number: number,
		event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
		body: string,
	): Promise<WithRate<{ url: string; state: string }>> {
		if (event !== "APPROVE" && body.trim() === "") {
			throw new HttpError(
				"invalid_request",
				event === "REQUEST_CHANGES"
					? "requesting changes needs a body — an author cannot act on a blocked review with no explanation"
					: "a review comment needs a body",
				{ retriable: false },
			);
		}
		const res = await this.api.request<{ html_url: string; state: string }>({
			method: "POST",
			path: `/repos/${repo.slug}/pulls/${String(number)}/reviews`,
			body: { event, ...(body.trim() === "" ? {} : { body }) },
		});
		return { data: { url: res.data.html_url, state: res.data.state }, rate: res.rate };
	}
}
