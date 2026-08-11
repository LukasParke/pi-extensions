import { describe, expect, it } from "vitest";
import { HttpError } from "@parke.dev/pi-integration-http";
import { LinearClient } from "../src/client.ts";

const fetchFrom =
	(body: unknown, inspect?: (request: Request) => void): typeof fetch =>
	async (input, init) => {
		const request = new Request(input, init);
		inspect?.(request);
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};

describe("LinearClient", () => {
	it("maps GraphQL errors returned with HTTP 200", async () => {
		const client = new LinearClient({
			key: "lin_api_test",
			fetchImpl: fetchFrom({ errors: [{ message: "forbidden" }] }),
		});
		await expect(client.viewer()).rejects.toMatchObject({
			code: "provider_error",
			providerMessage: "forbidden",
		} satisfies Partial<HttpError>);
	});

	it("sends Linear's bare authorization header and returns the viewer", async () => {
		const client = new LinearClient({
			key: "lin_api_test",
			fetchImpl: fetchFrom({ data: { viewer: { name: "Luke", email: null } } }, (request) => {
				expect(request.headers.get("authorization")).toBe("lin_api_test");
			}),
		});
		await expect(client.viewer()).resolves.toMatchObject({ data: { name: "Luke", email: null } });
	});
});
