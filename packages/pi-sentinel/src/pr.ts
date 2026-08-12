import { githubApi, type RepoRef } from "@parke.dev/pi-github";

export type PrLifecycle = "open" | "draft" | "closed" | "merged";
export type PrMergeState = "clean" | "conflicts" | "blocked" | "behind" | "unknown";
export type PrChecksState = "passing" | "failing" | "pending" | "none";
export type PrReviewDecision = "approved" | "changes_requested" | "review_required" | "none";

export interface PrActivity {
	id: string;
	kind: "review" | "comment" | "thread";
	author?: string;
	state?: string;
}

export interface PrSnapshot {
	repo: string;
	number: number;
	title: string;
	url: string;
	viewer: string;
	lifecycle: PrLifecycle;
	headSha: string;
	merge: PrMergeState;
	checks: PrChecksState;
	failingChecks: string[];
	reviewDecision: PrReviewDecision;
	unresolvedThreads: number;
	activities: PrActivity[];
}

export type PrEvent =
	| { type: "conflicts"; snapshot: PrSnapshot }
	| { type: "ci_failure"; snapshot: PrSnapshot }
	| { type: "review_feedback"; snapshot: PrSnapshot; reasons: string[]; activityIds: string[] }
	| { type: "merged"; snapshot: PrSnapshot }
	| { type: "closed"; snapshot: PrSnapshot };

interface GraphQlResponse {
	data?: {
		viewer?: { login?: string };
		repository?: {
			pullRequest?: {
				number: number;
				title: string;
				url: string;
				state: string;
				isDraft: boolean;
				merged: boolean;
				headRefOid: string;
				mergeable: string;
				mergeStateStatus: string;
				reviewDecision?: string | null;
				reviews?: { nodes?: Array<{ id: string; state: string; author?: { login?: string } | null } | null> };
				comments?: { nodes?: Array<{ id: string; author?: { login?: string } | null } | null> };
				reviewThreads?: {
					nodes?: Array<{
						id: string;
						isResolved: boolean;
						comments?: { nodes?: Array<{ id: string; author?: { login?: string } | null } | null> };
					} | null>;
				};
				commits?: {
					nodes?: Array<{
						commit?: {
							statusCheckRollup?: {
								state: string;
								contexts?: {
									nodes?: Array<
										| { __typename: "CheckRun"; name: string; status: string; conclusion?: string | null }
										| { __typename: "StatusContext"; context: string; state: string }
										| null
									>;
								};
							};
						};
					} | null>;
				};
			};
		};
	};
	errors?: Array<{ message?: string }>;
}

const QUERY = `query SentinelPr($owner:String!,$name:String!,$number:Int!){
  viewer{login}
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      number title url state isDraft merged headRefOid mergeable mergeStateStatus reviewDecision
      reviews(last:50){nodes{id state author{login}}}
      comments(last:50){nodes{id author{login}}}
      reviewThreads(first:100){nodes{id isResolved comments(last:1){nodes{id author{login}}}}}
      commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:100){nodes{
        __typename
        ... on CheckRun{name status conclusion}
        ... on StatusContext{context state}
      }}}}}}
    }
  }
}`;

function lifecycle(
	pr: NonNullable<NonNullable<NonNullable<GraphQlResponse["data"]>["repository"]>["pullRequest"]>,
): PrLifecycle {
	if (pr.merged || pr.state === "MERGED") return "merged";
	if (pr.state === "CLOSED") return "closed";
	return pr.isDraft ? "draft" : "open";
}

function mergeState(mergeable: string, state: string): PrMergeState {
	if (mergeable === "CONFLICTING" || state === "DIRTY") return "conflicts";
	if (state === "BLOCKED") return "blocked";
	if (state === "BEHIND") return "behind";
	if (mergeable === "MERGEABLE" || state === "CLEAN" || state === "UNSTABLE") return "clean";
	return "unknown";
}

function checksState(state?: string): PrChecksState {
	if (!state) return "none";
	if (state === "FAILURE" || state === "ERROR") return "failing";
	if (state === "SUCCESS") return "passing";
	return "pending";
}

function reviewDecision(state?: string | null): PrReviewDecision {
	if (state === "APPROVED") return "approved";
	if (state === "CHANGES_REQUESTED") return "changes_requested";
	if (state === "REVIEW_REQUIRED") return "review_required";
	return "none";
}

function failingChecks(
	contexts: Array<
		| { __typename: "CheckRun"; name: string; status: string; conclusion?: string | null }
		| { __typename: "StatusContext"; context: string; state: string }
		| null
	>,
) {
	return contexts.flatMap((context) => {
		if (!context) return [];
		if (context.__typename === "StatusContext") {
			return context.state === "FAILURE" || context.state === "ERROR" ? [context.context] : [];
		}
		if (context.status !== "COMPLETED") return [];
		return ["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(context.conclusion ?? "")
			? [context.name]
			: [];
	});
}

export function snapshotFromGraphQl(response: GraphQlResponse, repo: RepoRef): PrSnapshot {
	if (response.errors?.length) {
		throw new Error(response.errors.map((error) => error.message ?? "GitHub GraphQL error").join("; "));
	}
	const pr = response.data?.repository?.pullRequest;
	if (!pr) throw new Error(`GitHub PR ${repo.slug} was not found or the credential cannot see it`);
	const viewer = response.data?.viewer?.login;
	if (!viewer) throw new Error("GitHub GraphQL response did not include the authenticated viewer login");
	const threads = pr.reviewThreads?.nodes?.flatMap((thread) => (thread ? [thread] : [])) ?? [];
	const rollup = pr.commits?.nodes?.at(-1)?.commit?.statusCheckRollup;
	const activities: PrActivity[] = [
		...(pr.reviews?.nodes?.flatMap((review) =>
			review
				? [
						{
							id: `review:${review.id}`,
							kind: "review" as const,
							author: review.author?.login,
							state: review.state,
						},
					]
				: [],
		) ?? []),
		...(pr.comments?.nodes?.flatMap((comment) =>
			comment
				? [{ id: `comment:${comment.id}`, kind: "comment" as const, author: comment.author?.login }]
				: [],
		) ?? []),
		...threads.flatMap((thread) => {
			const comment = thread.comments?.nodes?.at(-1);
			return comment
				? [
						{
							id: `thread:${thread.id}:${comment.id}`,
							kind: "thread" as const,
							author: comment.author?.login,
						},
					]
				: [];
		}),
	];
	return {
		repo: repo.slug,
		number: pr.number,
		title: pr.title,
		url: pr.url,
		viewer,
		lifecycle: lifecycle(pr),
		headSha: pr.headRefOid,
		merge: mergeState(pr.mergeable, pr.mergeStateStatus),
		checks: checksState(rollup?.state),
		failingChecks: failingChecks(rollup?.contexts?.nodes ?? []),
		reviewDecision: reviewDecision(pr.reviewDecision),
		unresolvedThreads: threads.filter((thread) => !thread.isResolved).length,
		activities,
	};
}

export function createGitHubPrProbe(options: { token: string; repo: RepoRef; number: number }) {
	const api = githubApi({ token: options.token });
	return async () => {
		const response = await api.request<GraphQlResponse>({
			method: "POST",
			path: "/graphql",
			body: {
				query: QUERY,
				variables: { owner: options.repo.owner, name: options.repo.name, number: options.number },
			},
		});
		return snapshotFromGraphQl(response.data, options.repo);
	};
}

export function prEvents(previous: PrSnapshot, next: PrSnapshot): PrEvent[] {
	if (previous.lifecycle !== "merged" && next.lifecycle === "merged")
		return [{ type: "merged", snapshot: next }];
	if (previous.lifecycle !== "closed" && next.lifecycle === "closed")
		return [{ type: "closed", snapshot: next }];

	const events: PrEvent[] = [];
	if (previous.merge !== "conflicts" && next.merge === "conflicts") {
		events.push({ type: "conflicts", snapshot: next });
	}
	if (next.checks === "failing" && (previous.checks !== "failing" || previous.headSha !== next.headSha)) {
		events.push({ type: "ci_failure", snapshot: next });
	}

	const previousActivities = new Set(previous.activities.map((activity) => activity.id));
	const feedback = next.activities.filter(
		(activity) =>
			!previousActivities.has(activity.id) &&
			activity.author !== next.viewer &&
			(activity.kind !== "review" ||
				activity.state === "COMMENTED" ||
				activity.state === "CHANGES_REQUESTED"),
	);
	const reasons: string[] = [];
	if (previous.reviewDecision !== "changes_requested" && next.reviewDecision === "changes_requested") {
		reasons.push("changes requested");
	}
	if (next.unresolvedThreads > previous.unresolvedThreads) {
		reasons.push(
			`${next.unresolvedThreads} unresolved review thread${next.unresolvedThreads === 1 ? "" : "s"}`,
		);
	}
	if (feedback.length) {
		const authors = [...new Set(feedback.map((activity) => activity.author).filter(Boolean))];
		reasons.push(
			`new feedback${authors.length ? ` from ${authors.map((author) => `@${author}`).join(", ")}` : ""}`,
		);
	}
	if (reasons.length) {
		events.push({
			type: "review_feedback",
			snapshot: next,
			reasons,
			activityIds: feedback.map((activity) => activity.id),
		});
	}
	return events;
}

export function prEventId(name: string, event: PrEvent) {
	if (event.type === "ci_failure") return `pr:${name}:ci:${event.snapshot.headSha}`;
	if (event.type === "review_feedback") {
		return `pr:${name}:review:${event.activityIds.at(-1) ?? `${event.snapshot.reviewDecision}:${event.snapshot.unresolvedThreads}`}`;
	}
	return `pr:${name}:${event.type}`;
}

export function formatPrEvent(event: PrEvent) {
	const pr = `${event.snapshot.repo}#${event.snapshot.number}`;
	const link = `${event.snapshot.title}\n${event.snapshot.url}`;
	if (event.type === "merged") return `PR ${pr} was merged.\n${link}`;
	if (event.type === "closed") return `PR ${pr} was closed without merging.\n${link}`;
	if (event.type === "conflicts") return `PR ${pr} has merge conflicts. Resolve them now.\n${link}`;
	if (event.type === "ci_failure") {
		const checks = event.snapshot.failingChecks.length
			? ` Failing: ${event.snapshot.failingChecks.join(", ")}.`
			: "";
		return `PR ${pr} has broken CI.${checks}\n${link}`;
	}
	return `PR ${pr} has review feedback: ${event.reasons.join("; ")}. Address it now.\n${link}`;
}

export function formatPrSnapshot(snapshot: PrSnapshot) {
	return `${snapshot.repo}#${snapshot.number} ${snapshot.lifecycle}; merge ${snapshot.merge}; CI ${snapshot.checks}; review ${snapshot.reviewDecision}; ${snapshot.unresolvedThreads} unresolved thread${snapshot.unresolvedThreads === 1 ? "" : "s"}`;
}

export function prNeedsAction(snapshot: PrSnapshot) {
	return (
		snapshot.merge === "conflicts" ||
		snapshot.checks === "failing" ||
		snapshot.reviewDecision === "changes_requested" ||
		snapshot.unresolvedThreads > 0
	);
}
