import { describe, expect, it } from "vitest";
import { HttpError } from "@parke.dev/pi-integration-http";
import { SlackClient } from "../src/client.ts";

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

describe("SlackClient", () => {
	it("maps Slack's HTTP-200 errors instead of returning empty data", async () => {
		const client = new SlackClient({
			token: "xoxb-test",
			fetchImpl: fetchFrom({ ok: false, error: "not_authed" }),
		});
		await expect(client.authTest()).rejects.toMatchObject({
			code: "reauthorize",
		} satisfies Partial<HttpError>);
	});

	it("uses bearer auth and maps auth.test identity", async () => {
		const client = new SlackClient({
			token: "xoxb-test",
			fetchImpl: fetchFrom({ ok: true, team: "Acme", user: "Pi", user_id: "U1" }, (request) => {
				expect(request.headers.get("authorization")).toBe("Bearer xoxb-test");
			}),
		});
		await expect(client.authTest()).resolves.toMatchObject({
			data: { team: "Acme", user: "Pi", userId: "U1" },
		});
	});
});
