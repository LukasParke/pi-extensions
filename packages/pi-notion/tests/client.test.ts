import { describe, expect, it } from "vitest";
import { NOTION_VERSION, NotionClient } from "../src/client.ts";

function pagedFetch(responses: unknown[], inspect?: (request: Request) => void): typeof fetch {
	let index = 0;
	return async (input, init) => {
		const request = new Request(input, init);
		inspect?.(request);
		return new Response(JSON.stringify(responses[index++]), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
}

describe("NotionClient", () => {
	it("sends bearer auth and the required Notion API version", async () => {
		const client = new NotionClient({
			key: "secret_test",
			fetchImpl: pagedFetch([{ name: "Docs bot", type: "bot" }], (request) => {
				expect(request.headers.get("authorization")).toBe("Bearer secret_test");
				expect(request.headers.get("notion-version")).toBe(NOTION_VERSION);
			}),
		});
		await expect(client.me()).resolves.toMatchObject({ data: { name: "Docs bot", type: "bot" } });
	});

	it("follows body cursors and reports when a search is truncated", async () => {
		const seenBodies: unknown[] = [];
		const fetchImpl = pagedFetch(
			[
				{ results: [{ id: "one" }], has_more: true, next_cursor: "next" },
				{ results: [{ id: "two" }], has_more: true, next_cursor: "later" },
			],
			async (request) => seenBodies.push(JSON.parse(await request.clone().text())),
		);
		const result = await new NotionClient({ key: "secret", fetchImpl }).search({ limit: 2 });
		expect(result.data.map((page) => page.id)).toEqual(["one", "two"]);
		expect(result.truncated).toBe(true);
		expect(seenBodies[1]).toMatchObject({ start_cursor: "next" });
	});
});
