import { HttpClient, HttpError, type RateInfo } from "@parke.dev/pi-integration-http";

const API = "https://api.linear.app";

export interface LinearClientOptions {
	key: string;
	baseUrl?: string;
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	maxRetries?: number;
	timeoutMs?: number;
}

export interface WithRate<T> {
	data: T;
	rate: RateInfo;
}

export interface ApiIssue {
	id: string;
	identifier: string;
	title: string;
	description: string | null;
	url: string;
	priority: number;
	updatedAt: string;
	state: { name: string; type: string } | null;
	assignee: { name: string; isMe?: boolean } | null;
	team: { key: string } | null;
}

export interface ApiComment {
	id: string;
	body: string;
	createdAt: string;
	user: { name: string } | null;
}

export function priorityWord(p: number): string {
	switch (p) {
		case 1:
			return "urgent";
		case 2:
			return "high";
		case 3:
			return "medium";
		case 4:
			return "low";
		default:
			return "no priority";
	}
}

const ISSUE_FIELDS = `
  id identifier title description url priority updatedAt
  state { name type }
  assignee { name isMe }
  team { key }
`;

export class LinearClient {
	private readonly http: HttpClient;

	constructor(opts: LinearClientOptions) {
		this.http = new HttpClient({
			provider: "Linear",
			authScheme: "none",
			defaultHeaders: { authorization: opts.key },
			token: opts.key,
			baseUrl: opts.baseUrl ?? API,
			...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
			...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
			...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
			...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
		});
	}

	private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<WithRate<T>> {
		const res = await this.http.request<{ data?: T; errors?: { message?: string }[] }>({
			method: "POST",
			path: "/graphql",
			body: { query, variables },
		});

		const errors = res.data?.errors;
		if (errors !== undefined && errors.length > 0) {
			throw new HttpError("provider_error", "Linear rejected the query", {
				provider: "Linear",
				providerMessage: errors[0]?.message ?? "unknown GraphQL error",
				retriable: false,
			});
		}
		if (res.data?.data === undefined) {
			throw new HttpError("provider_error", "Linear returned no data", { provider: "Linear" });
		}
		return { data: res.data.data, rate: res.rate };
	}

	async viewer(): Promise<WithRate<{ name: string; email: string | null }>> {
		const r = await this.gql<{ viewer: { name: string; email: string | null } }>(
			`query { viewer { name email } }`,
		);
		return { data: r.data.viewer, rate: r.rate };
	}

	async issues(
		opts: { limit?: number; mine?: boolean; state?: string; search?: string; team?: string } = {},
	): Promise<WithRate<ApiIssue[]>> {
		const mine = opts.mine !== false;
		const r = await this.gql<{ issues: { nodes: ApiIssue[] } }>(
			`query Issues($first: Int!, $filter: IssueFilter) {
        issues(first: $first, filter: $filter, orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } }
      }`,
			{
				first: Math.min(opts.limit ?? 25, 100),
				filter: {
					...(mine ? { assignee: { isMe: { eq: true } } } : {}),
					...(opts.state !== undefined && opts.state !== ""
						? { state: { name: { eq: opts.state } } }
						: // Not-done rather than all: a closed issue is history, and history is not a work list.
							{ state: { type: { nin: ["completed", "canceled"] } } }),
					...(opts.search !== undefined && opts.search !== ""
						? { title: { containsIgnoreCase: opts.search } }
						: {}),
					...(opts.team !== undefined && opts.team !== "" ? { team: { key: { eq: opts.team } } } : {}),
				},
			},
		);
		return { data: r.data.issues.nodes, rate: r.rate };
	}

	async issue(id: string): Promise<WithRate<{ issue: ApiIssue; comments: ApiComment[] }>> {
		const r = await this.gql<{
			issue: (ApiIssue & { comments: { nodes: ApiComment[] } }) | null;
		}>(
			`query Issue($id: String!) {
        issue(id: $id) {
          ${ISSUE_FIELDS}
          comments(first: 50) { nodes { id body createdAt user { name } } }
        }
      }`,
			{ id },
		);
		const issue = r.data.issue;
		if (issue === null) {
			throw new HttpError("not_found", "no such Linear issue, or the key cannot see it", {
				provider: "Linear",
				retriable: false,
			});
		}
		return { data: { issue, comments: issue.comments.nodes }, rate: r.rate };
	}

	async states(team?: string): Promise<WithRate<{ id: string; name: string; type: string }[]>> {
		const r = await this.gql<{
			workflowStates: { nodes: { id: string; name: string; type: string }[] };
		}>(
			`query States($filter: WorkflowStateFilter) {
        workflowStates(first: 100, filter: $filter) { nodes { id name type } }
      }`,
			team === undefined || team === "" ? {} : { filter: { team: { key: { eq: team } } } },
		);
		return { data: r.data.workflowStates.nodes, rate: r.rate };
	}

	/* -------------------------------- writes -------------------------------- */

	async comment(issueId: string, body: string): Promise<WithRate<{ id: string; url: string | null }>> {
		if (body.trim() === "") {
			throw new HttpError("invalid_request", "refusing to post an empty comment", {
				provider: "Linear",
				retriable: false,
			});
		}
		const r = await this.gql<{
			commentCreate: { success: boolean; comment: { id: string; url?: string } | null };
		}>(
			`mutation Comment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id url } }
      }`,
			{ issueId, body },
		);
		const created = r.data.commentCreate;
		if (!created.success || created.comment === null) {
			throw new HttpError("provider_error", "Linear did not create the comment", {
				provider: "Linear",
			});
		}
		return { data: { id: created.comment.id, url: created.comment.url ?? null }, rate: r.rate };
	}

	async transition(issueId: string, stateName: string): Promise<WithRate<{ state: string }>> {
		const issue = await this.issue(issueId);
		const team = issue.data.issue.team?.key;
		const states = await this.states(team);
		const target = states.data.find((s) => s.name.toLowerCase() === stateName.trim().toLowerCase());
		if (target === undefined) {
			throw new HttpError(
				"invalid_request",
				`Linear has no state "${stateName}" for that team. Available: ${states.data.map((s) => s.name).join(", ")}`,
				{ provider: "Linear", retriable: false },
			);
		}
		const r = await this.gql<{ issueUpdate: { success: boolean } }>(
			`mutation Move($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) { success }
      }`,
			{ id: issueId, stateId: target.id },
		);
		if (!r.data.issueUpdate.success) {
			throw new HttpError("provider_error", "Linear did not move the issue", { provider: "Linear" });
		}
		return { data: { state: target.name }, rate: r.rate };
	}
}
