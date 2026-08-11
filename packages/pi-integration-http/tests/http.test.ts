import { describe, expect, it, vi } from "vitest";
import { HttpClient } from "../src/client.ts";
import { HttpError } from "../src/error.ts";

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

describe("HttpClient", () => {
	it("adds auth, parses JSON, and reports rate metadata", async () => {
		const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
			return response(200, { ok: true }, { "x-ratelimit-remaining": "41" });
		});
		const client = new HttpClient({
			provider: "test",
			baseUrl: "https://example.test",
			token: "token",
			fetchImpl: fetchImpl as typeof fetch,
		});

		const result = await client.request<{ ok: boolean }>({ method: "GET", path: "/x" });
		expect(result.data).toEqual({ ok: true });
		expect(result.rate.remaining).toBe(41);
	});

	it("retries transient reads but never ambiguous writes", async () => {
		const sleep = vi.fn(async () => undefined);
		const readFetch = vi
			.fn()
			.mockResolvedValueOnce(response(503, { message: "later" }))
			.mockResolvedValueOnce(response(200, { ok: true }));
		const read = new HttpClient({
			provider: "test",
			baseUrl: "https://example.test",
			token: "token",
			maxRetries: 1,
			sleep,
			fetchImpl: readFetch as typeof fetch,
		});
		await expect(read.request({ method: "GET", path: "/x" })).resolves.toBeDefined();
		expect(readFetch).toHaveBeenCalledTimes(2);

		const writeFetch = vi.fn(async () => response(503, { message: "maybe accepted" }));
		const write = new HttpClient({
			provider: "test",
			baseUrl: "https://example.test",
			token: "token",
			maxRetries: 2,
			sleep,
			fetchImpl: writeFetch as typeof fetch,
		});
		await expect(write.request({ method: "POST", path: "/x", body: {} })).rejects.toBeInstanceOf(HttpError);
		expect(writeFetch).toHaveBeenCalledTimes(1);
	});
});
