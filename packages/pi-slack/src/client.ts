import { HttpClient, HttpError, type RateInfo } from "@parke.dev/pi-integration-http";

const API = "https://slack.com/api";

export interface SlackClientOptions {
	token: string;
	baseUrl?: string;
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	maxRetries?: number;
	timeoutMs?: number;
}

export interface WithRate<T> {
	data: T;
	rate: RateInfo;
	truncated?: boolean;
}

export interface ApiChannel {
	id: string;
	name?: string;
	is_private?: boolean;
	is_archived?: boolean;
	num_members?: number;
	topic?: { value?: string };
	purpose?: { value?: string };
}

export interface ApiMessage {
	ts: string;
	user?: string;
	bot_id?: string;
	username?: string;
	text?: string;
	thread_ts?: string;
	reply_count?: number;
	permalink?: string;
	channel?: { id?: string; name?: string };
}

export interface ApiSearchMatch {
	iid?: string;
	ts: string;
	user?: string;
	username?: string;
	text?: string;
	permalink?: string;
	channel?: { id?: string; name?: string };
}

export const MAX_CHANNEL_LIST = 50;

export const MAX_THREAD_MESSAGES = 200;

export class SlackClient {
	private readonly http: HttpClient;
	private readonly userNames = new Map<string, string>();

	constructor(opts: SlackClientOptions) {
		this.http = new HttpClient({
			provider: "Slack",
			token: opts.token,
			authScheme: "bearer",
			baseUrl: opts.baseUrl ?? API,
			...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
			...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
			...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
			...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
		});
	}

	private async api<T extends object>(
		method: string,
		params: Record<string, unknown> = {},
		verb: "GET" | "POST" = "GET",
	): Promise<WithRate<T>> {
		const query =
			verb === "GET"
				? `?${new URLSearchParams(
						Object.entries(params)
							.filter(([, v]) => v !== undefined && v !== null)
							.map(([k, v]) => [k, String(v)] as [string, string]),
					).toString()}`
				: "";

		const res = await this.http.request<
			{ ok: boolean; error?: string; response_metadata?: { next_cursor?: string } } & T
		>({
			method: verb,
			path: `/${method}${query}`,
			...(verb === "POST" ? { body: params } : {}),
		});

		if (!res.data.ok) {
			throw mapSlackError(res.data.error ?? "unknown_error", res.rate);
		}

		return { data: res.data, rate: res.rate };
	}

	async authTest(): Promise<WithRate<{ team: string; user: string; userId: string; botId: string | null }>> {
		const r = await this.api<{
			team?: string;
			user?: string;
			user_id?: string;
			bot_id?: string;
		}>("auth.test");
		return {
			data: {
				team: r.data.team ?? "Slack",
				user: r.data.user ?? "a bot",
				userId: r.data.user_id ?? "",
				botId: r.data.bot_id ?? null,
			},
			rate: r.rate,
		};
	}

	async channels(opts: { channels?: string[]; limit?: number } = {}): Promise<
		WithRate<
			{
				channel: ApiChannel;
				latest: ApiMessage | null;
			}[]
		>
	> {
		const limit = Math.min(opts.limit ?? MAX_CHANNEL_LIST, MAX_CHANNEL_LIST);
		const named = (opts.channels ?? []).map((c) => c.replace(/^#/, "").trim()).filter((c) => c !== "");

		let listed: ApiChannel[];
		let truncated: boolean;
		let rate: RateInfo;

		if (named.length > 0) {
			const out: ApiChannel[] = [];
			let lastRate: RateInfo = { remaining: null, limit: null, resetAt: null };
			let neededList: ApiChannel[] | null = null;

			for (const conf of named.slice(0, limit)) {
				if (looksLikeChannelId(conf)) {
					try {
						const info = await this.api<{ channel: ApiChannel }>("conversations.info", {
							channel: conf,
						});
						lastRate = info.rate;
						out.push(info.data.channel);
						continue;
					} catch (e) {
						if (!(e instanceof HttpError) || (e.code !== "not_found" && e.code !== "forbidden")) throw e;
					}
				}
				if (neededList === null) {
					const page = await this.listChannels(MAX_CHANNEL_LIST);
					neededList = page.data;
					lastRate = page.rate;
				}
				const hit = neededList.find((c) => c.id === conf || c.name === conf);
				if (hit === undefined) {
					throw new HttpError(
						"not_found",
						`no Slack channel matching "${conf}", or the token cannot see it`,
						{
							provider: "Slack",
							retriable: false,
							providerMessage: "channel_not_found",
						},
					);
				}
				out.push(hit);
			}
			listed = out;
			truncated = named.length > limit;
			rate = lastRate;
		} else {
			const page = await this.listChannels(limit);
			listed = page.data;
			truncated = page.truncated === true;
			rate = page.rate;
		}

		const rows: { channel: ApiChannel; latest: ApiMessage | null }[] = [];
		for (const ch of listed) {
			try {
				const history = await this.api<{ messages?: ApiMessage[] }>("conversations.history", {
					channel: ch.id,
					limit: 1,
				});
				rate = history.rate;
				rows.push({ channel: ch, latest: history.data.messages?.[0] ?? null });
			} catch (e) {
				if (e instanceof HttpError && (e.code === "forbidden" || e.code === "not_found")) {
					rows.push({ channel: ch, latest: null });
					continue;
				}
				throw e;
			}
		}

		return { data: rows, rate, truncated };
	}

	async thread(
		channel: string,
		ts: string,
	): Promise<WithRate<{ channel: string; ts: string; messages: ApiMessage[]; permalink: string | null }>> {
		const resolved = await this.resolveChannelId(channel);
		const replies = await this.api<{ messages?: ApiMessage[] }>("conversations.replies", {
			channel: resolved,
			ts,
			limit: MAX_THREAD_MESSAGES,
		});
		const messages = replies.data.messages ?? [];
		if (messages.length === 0) {
			throw new HttpError("not_found", "no such Slack thread, or the token cannot see it", {
				provider: "Slack",
				retriable: false,
			});
		}

		let permalink: string | null = null;
		try {
			const link = await this.api<{ permalink?: string }>("chat.getPermalink", {
				channel: resolved,
				message_ts: ts,
			});
			permalink = link.data.permalink ?? null;
		} catch {
			permalink = null;
		}

		return {
			data: { channel: resolved, ts, messages, permalink },
			rate: replies.rate,
			truncated: messages.length >= MAX_THREAD_MESSAGES,
		};
	}

	async search(query: string, opts: { limit?: number } = {}): Promise<WithRate<ApiSearchMatch[]>> {
		if (query.trim() === "") {
			throw new HttpError("invalid_request", "refusing to search with an empty query", {
				provider: "Slack",
				retriable: false,
			});
		}
		const count = Math.min(opts.limit ?? 20, 50);
		const r = await this.api<{
			messages?: { matches?: ApiSearchMatch[]; pagination?: { total_count?: number } };
		}>("search.messages", { query, count, sort: "timestamp", sort_dir: "desc" });
		const matches = r.data.messages?.matches ?? [];
		const total = r.data.messages?.pagination?.total_count;
		return {
			data: matches.slice(0, count),
			rate: r.rate,
			truncated: total !== undefined ? total > matches.length : matches.length >= count,
		};
	}

	async post(
		channel: string,
		text: string,
		opts: { threadTs?: string } = {},
	): Promise<WithRate<{ channel: string; ts: string }>> {
		if (text.trim() === "") {
			throw new HttpError("invalid_request", "refusing to post an empty message", {
				provider: "Slack",
				retriable: false,
			});
		}
		const resolved = await this.resolveChannelId(channel);
		const r = await this.api<{ channel?: string; ts?: string }>(
			"chat.postMessage",
			{
				channel: resolved,
				text,
				...(opts.threadTs !== undefined && opts.threadTs !== "" ? { thread_ts: opts.threadTs } : {}),
			},
			"POST",
		);
		if (r.data.ts === undefined || r.data.ts === "") {
			throw new HttpError("provider_error", "Slack did not return a message timestamp", {
				provider: "Slack",
			});
		}
		return { data: { channel: r.data.channel ?? resolved, ts: r.data.ts }, rate: r.rate };
	}

	async userName(id: string | undefined): Promise<string> {
		if (id === undefined || id === "") return "unknown";
		const hit = this.userNames.get(id);
		if (hit !== undefined) return hit;
		try {
			const r = await this.api<{ user?: { real_name?: string; name?: string } }>("users.info", {
				user: id,
			});
			const name = r.data.user?.real_name ?? r.data.user?.name ?? id;
			this.userNames.set(id, name);
			return name;
		} catch {
			this.userNames.set(id, id);
			return id;
		}
	}

	/* ------------------------------ internals ------------------------------ */

	private async listChannels(limit: number): Promise<WithRate<ApiChannel[]>> {
		const items: ApiChannel[] = [];
		let cursor: string | undefined;
		let rate: RateInfo = { remaining: null, limit: null, resetAt: null };
		let pages = 0;
		const maxPages = 3;

		for (;;) {
			const r = await this.api<{
				channels?: ApiChannel[];
				response_metadata?: { next_cursor?: string };
			}>("conversations.list", {
				types: "public_channel,private_channel",
				exclude_archived: true,
				limit: Math.min(100, limit - items.length + 1),
				...(cursor !== undefined && cursor !== "" ? { cursor } : {}),
			});
			rate = r.rate;
			items.push(...(r.data.channels ?? []).filter((c) => c.is_archived !== true));
			pages++;
			const next = r.data.response_metadata?.next_cursor ?? "";
			if (items.length >= limit) {
				return { data: items.slice(0, limit), rate, truncated: next !== "" || items.length > limit };
			}
			if (next === "") return { data: items, rate, truncated: false };
			if (pages >= maxPages) return { data: items.slice(0, limit), rate, truncated: true };
			cursor = next;
		}
	}

	private async resolveChannelId(channel: string): Promise<string> {
		const cleaned = channel.replace(/^#/, "").trim();
		if (cleaned === "") {
			throw new HttpError("invalid_request", "channel is required", {
				provider: "Slack",
				retriable: false,
			});
		}
		if (looksLikeChannelId(cleaned)) return cleaned;
		const page = await this.listChannels(MAX_CHANNEL_LIST);
		const hit = page.data.find((c) => c.name === cleaned);
		if (hit === undefined) {
			throw new HttpError("not_found", `no Slack channel named "${cleaned}", or the token cannot see it`, {
				provider: "Slack",
				retriable: false,
				providerMessage: "channel_not_found",
			});
		}
		return hit.id;
	}
}

function looksLikeChannelId(s: string): boolean {
	return /^[CGD][A-Z0-9]{8,}$/i.test(s);
}

export function mapSlackError(
	code: string,
	rate: RateInfo = { remaining: null, limit: null, resetAt: null },
): HttpError {
	const opts = { provider: "Slack" as const, providerMessage: code };

	if (code === "ratelimited") {
		const retryAfter =
			rate.resetAt === null ? null : Math.max(0, Math.ceil(rate.resetAt - Date.now() / 1000));
		return new HttpError("rate_limited", "Slack is rate limiting this token", {
			...opts,
			retryAfterSec: retryAfter === 0 ? null : retryAfter,
		});
	}

	if (
		code === "invalid_auth" ||
		code === "not_authed" ||
		code === "token_revoked" ||
		code === "account_inactive" ||
		code === "token_expired"
	) {
		return new HttpError("reauthorize", "Slack rejected the credential; reconnect", {
			...opts,
			retriable: false,
		});
	}

	if (code === "channel_not_found" || code === "thread_not_found" || code === "message_not_found") {
		return new HttpError("not_found", "that Slack channel or thread is gone, or the token cannot see it", {
			...opts,
			retriable: false,
		});
	}

	if (
		code === "not_in_channel" ||
		code === "is_archived" ||
		code === "ekm_access_denied" ||
		code === "missing_scope" ||
		code === "not_allowed_token_type" ||
		code === "access_denied"
	) {
		return new HttpError("forbidden", "the Slack credential lacks access for this request", {
			...opts,
			retriable: false,
		});
	}

	if (code === "invalid_arguments" || code === "invalid_arg_name" || code === "msg_too_long") {
		return new HttpError("invalid_request", "Slack rejected the request as invalid", {
			...opts,
			retriable: false,
		});
	}

	return new HttpError("provider_error", "Slack refused the request", {
		...opts,
		retriable: false,
	});
}
