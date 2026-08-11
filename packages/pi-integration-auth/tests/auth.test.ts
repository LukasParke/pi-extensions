import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiAuthStore } from "../src/pi-auth.ts";
import { resolveCredential } from "../src/resolve.ts";

describe("PiAuthStore", () => {
	it("writes an atomic 0600 credential file and deletes it when empty", async () => {
		const file = join(mkdtempSync(join(tmpdir(), "pi-integration-auth-")), "auth.json");
		const store = new PiAuthStore(file);
		await store.setCredential("github.default", { type: "api_key", key: " test-token " });

		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			"github.default": { type: "api_key", key: "test-token" },
		});
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(await store.get("github.default")).toBe("test-token");

		await store.delete("github.default");
		expect(await store.list()).toEqual([]);
	});

	it("prefers environment, then stored credentials, then a CLI", async () => {
		const store = new PiAuthStore(join(mkdtempSync(join(tmpdir(), "pi-auth-order-")), "auth.json"));
		await store.set("github.default", "stored");
		const base = { envNames: ["TOKEN"], authRef: "github.default", store } as const;

		expect((await resolveCredential({ ...base, env: { TOKEN: " env " } }))?.source).toBe("env");
		expect((await resolveCredential({ ...base, env: {} }))?.source).toBe("integration-auth");

		await store.delete("github.default");
		expect(
			(
				await resolveCredential({
					...base,
					env: {},
					cli: { describe: "test cli", read: async () => "cli" },
				})
			)?.source,
		).toBe("cli");
	});
});
