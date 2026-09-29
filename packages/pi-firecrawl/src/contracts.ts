import { Type, type Static, type TSchema } from "typebox";

export const namespace = { name: "firecrawl", description: "Web scraping, search, mapping and crawl jobs" };

const pageSchema = Type.Object({
	markdown: Type.Optional(Type.String()),
	html: Type.Optional(Type.String()),
	rawHtml: Type.Optional(Type.String()),
	summary: Type.Optional(Type.String()),
	screenshot: Type.Optional(Type.String()),
	links: Type.Optional(Type.Array(Type.String())),
	metadata: Type.Optional(
		Type.Object({
			title: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
			sourceURL: Type.Optional(Type.String()),
			url: Type.Optional(Type.String()),
			statusCode: Type.Optional(Type.Number()),
		}),
	),
});
const searchResultSchema = Type.Object({
	url: Type.String(),
	title: Type.Optional(Type.String()),
	description: Type.Optional(Type.String()),
	markdown: Type.Optional(Type.String()),
	metadata: pageSchema.properties.metadata,
});
const refusal = Type.Object({ refused: Type.Literal(true), error: Type.String() });
const withRefusal = <T extends TSchema>(success: T) => Type.Union([success, refusal]);

export const scrapeSchema = withRefusal(Type.Object({ page: pageSchema }));
export const searchSchema = withRefusal(Type.Object({ results: Type.Array(searchResultSchema) }));
export const mapSchema = withRefusal(Type.Object({ links: Type.Array(Type.String()) }));
const crawlData = Type.Object({
	jobId: Type.String(),
	status: Type.String(),
	completed: Type.Number(),
	total: Type.Union([Type.Number(), Type.Null()]),
	pages: Type.Array(pageSchema),
	partial: Type.Boolean(),
});
export const crawlSchema = Type.Union([
	crawlData,
	Type.Object({ ...Type.Partial(crawlData).properties, ...refusal.properties }),
]);

export type Page = Static<typeof pageSchema>;
export type SearchResult = Static<typeof searchResultSchema>;
export interface CrawlStatus {
	status?: string;
	completed?: number;
	total?: number;
	data?: Page[];
	error?: string;
}
