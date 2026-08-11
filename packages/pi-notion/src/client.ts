import { HttpClient, HttpError, type RateInfo } from "@parke.dev/pi-integration-http";

const API = "https://api.notion.com";
export const NOTION_VERSION = "2022-06-28";

export interface NotionClientOptions {
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
	truncated?: boolean;
}

interface RichText {
	plain_text?: string;
}

export interface ApiPage {
	id: string;
	url?: string;
	last_edited_time?: string;
	parent?: {
		type?: string;
		database_id?: string;
		page_id?: string;
		block_id?: string;
		workspace?: boolean;
	};
	properties?: Record<string, unknown>;
}

export interface ApiBlock {
	id: string;
	type: string;
	has_children?: boolean;
	[key: string]: unknown;
}

interface SearchPage {
	results?: ApiPage[];
	next_cursor?: string | null;
	has_more?: boolean;
}

interface BlocksPage {
	results?: ApiBlock[];
	next_cursor?: string | null;
	has_more?: boolean;
}

export class NotionClient {
	private readonly http: HttpClient;

	constructor(opts: NotionClientOptions) {
		this.http = new HttpClient({
			provider: "Notion",
			authScheme: "bearer",
			token: opts.key,
			baseUrl: opts.baseUrl ?? API,
			defaultHeaders: { "Notion-Version": NOTION_VERSION },
			...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
			...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
			...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
			...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
		});
	}

	async me(): Promise<WithRate<{ name: string; type: string }>> {
		const res = await this.http.request<{
			name?: string;
			bot?: { owner?: { user?: { name?: string } } };
			type?: string;
		}>({
			method: "GET",
			path: "/v1/users/me",
		});
		const name =
			res.data.name?.trim() !== "" && res.data.name !== undefined
				? res.data.name
				: res.data.bot?.owner?.user?.name?.trim() || "Notion integration";
		return { data: { name, type: res.data.type ?? "unknown" }, rate: res.rate };
	}

	async search(
		opts: { query?: string; limit?: number; maxPages?: number } = {},
	): Promise<WithRate<ApiPage[]>> {
		const limit = Math.min(opts.limit ?? 25, 100);
		const maxPages = opts.maxPages ?? 3;
		const pageSize = Math.min(100, limit);

		const items: ApiPage[] = [];
		let cursor: string | null = null;
		let rate: RateInfo = { remaining: null, limit: null, resetAt: null };
		let pages = 0;
		let more = false;

		for (;;) {
			const body: Record<string, unknown> = {
				filter: { property: "object", value: "page" },
				page_size: pageSize,
				sort: { direction: "descending", timestamp: "last_edited_time" },
			};
			if (opts.query !== undefined && opts.query !== "") body.query = opts.query;
			if (cursor !== null) body.start_cursor = cursor;

			const res = await this.http.request<SearchPage>({
				method: "POST",
				path: "/v1/search",
				body,
			});
			rate = res.rate;
			pages++;
			items.push(...(res.data.results ?? []));

			const next = res.data.next_cursor;
			const hasMore = res.data.has_more === true && next != null && next !== "";
			if (items.length >= limit) {
				more = hasMore || items.length > limit;
				break;
			}
			if (!hasMore) break;
			if (pages >= maxPages) {
				more = true;
				break;
			}
			cursor = next ?? null;
		}

		return {
			data: items.slice(0, limit),
			rate,
			truncated: more,
		};
	}

	async page(id: string): Promise<WithRate<{ page: ApiPage; blocks: ApiBlock[]; truncated: boolean }>> {
		const meta = await this.http.request<ApiPage>({
			method: "GET",
			path: `/v1/pages/${id}`,
		});

		const blocks: ApiBlock[] = [];
		let cursor: string | null = null;
		let rate = meta.rate;
		let pages = 0;
		let more = false;
		const maxPages = 5;

		for (;;) {
			const qs = new URLSearchParams({ page_size: "100" });
			if (cursor !== null) qs.set("start_cursor", cursor);
			const res = await this.http.request<BlocksPage>({
				method: "GET",
				path: `/v1/blocks/${id}/children?${qs.toString()}`,
			});
			rate = res.rate;
			pages++;
			blocks.push(...(res.data.results ?? []));

			const next = res.data.next_cursor;
			const hasMore = res.data.has_more === true && next != null && next !== "";
			if (!hasMore) break;
			if (pages >= maxPages) {
				more = true;
				break;
			}
			cursor = next ?? null;
		}

		return { data: { page: meta.data, blocks, truncated: more }, rate };
	}

	async append(
		pageId: string,
		text: string,
	): Promise<WithRate<{ firstBlockId: string | null; paragraphs: number }>> {
		const content = text.trim();
		if (content === "") {
			throw new HttpError("invalid_request", "refusing to append empty content", {
				provider: "Notion",
				retriable: false,
			});
		}

		const paragraphs = content
			.split("\n")
			.map((l) => l.trimEnd())
			.filter((l) => l.trim() !== "")
			.flatMap((line) => chunk(line, 2000))
			.map((piece) => ({
				object: "block" as const,
				type: "paragraph" as const,
				paragraph: { rich_text: [{ type: "text" as const, text: { content: piece } }] },
			}));

		if (paragraphs.length === 0) {
			throw new HttpError("invalid_request", "refusing to append empty content", {
				provider: "Notion",
				retriable: false,
			});
		}

		const res = await this.http.request<{ results?: { id?: string }[] }>({
			method: "PATCH",
			path: `/v1/blocks/${pageId}/children`,
			body: { children: paragraphs },
		});
		return {
			data: {
				firstBlockId: res.data.results?.[0]?.id ?? null,
				paragraphs: paragraphs.length,
			},
			rate: res.rate,
		};
	}
}

/* -------------------------------- helpers -------------------------------- */

export function pageTitle(properties: Record<string, unknown> | undefined): string | null {
	if (properties === undefined) return null;
	for (const value of Object.values(properties)) {
		const prop = value as { type?: string; title?: RichText[] };
		if (prop.type === "title" && Array.isArray(prop.title)) {
			const t = prop.title.map((x) => x.plain_text ?? "").join("");
			if (t !== "") return t;
		}
	}
	return null;
}

export function parentLabel(parent: ApiPage["parent"] | undefined): string {
	if (parent === undefined || parent.type === undefined) return "unknown parent";
	switch (parent.type) {
		case "workspace":
			return "workspace";
		case "database_id":
			return parent.database_id !== undefined ? `database ${parent.database_id}` : "database";
		case "page_id":
			return parent.page_id !== undefined ? `page ${parent.page_id}` : "page";
		case "block_id":
			return parent.block_id !== undefined ? `block ${parent.block_id}` : "block";
		default:
			return parent.type;
	}
}

function chunk(s: string, n: number): string[] {
	if (s.length <= n) return [s];
	const out: string[] = [];
	for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
	return out;
}
