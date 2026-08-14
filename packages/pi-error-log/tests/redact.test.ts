import { describe, expect, it } from "vitest";
import { MAX_ARGS_BYTES, REDACTED, sanitizeArgs, serializeArgs, TRUNCATED } from "../src/redact.ts";

describe("sanitizeArgs", () => {
	it("redacts values under sensitive keys", () => {
		const out = sanitizeArgs({
			token: "abc",
			apiKey: "abc",
			password: "hunter2",
			Authorization: "Bearer abc",
			cookie: "session=1",
			normal: "hello",
		}) as Record<string, unknown>;
		expect(out.token).toBe(REDACTED);
		expect(out.apiKey).toBe(REDACTED);
		expect(out.password).toBe(REDACTED);
		expect(out.Authorization).toBe(REDACTED);
		expect(out.cookie).toBe(REDACTED);
		expect(out.normal).toBe("hello");
	});

	it("redacts nested sensitive keys", () => {
		const out = sanitizeArgs({
			headers: { "x-api-key": "abc", "content-type": "application/json" },
			nested: [{ client_secret: "abc", ok: 1 }],
		}) as { headers: Record<string, unknown>; nested: Record<string, unknown>[] };
		expect(out.headers["x-api-key"]).toBe(REDACTED);
		expect(out.headers["content-type"]).toBe("application/json");
		expect(out.nested[0]!.client_secret).toBe(REDACTED);
		expect(out.nested[0]!.ok).toBe(1);
	});

	it("masks secret-looking values under innocent keys", () => {
		const out = sanitizeArgs({
			note: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
			id: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
			short: "not-a-secret",
		}) as Record<string, unknown>;
		expect(out.note).toBe(REDACTED);
		expect(out.id).toBe(REDACTED);
		expect(out.short).toBe("not-a-secret");
	});

	it("handles circular structures without throwing", () => {
		const a: Record<string, unknown> = { name: "a" };
		a.self = a;
		expect(() => sanitizeArgs(a)).not.toThrow();
		const out = sanitizeArgs(a) as Record<string, unknown>;
		expect(out.self).toBe("[circular]");
	});

	it("passes through primitives", () => {
		expect(sanitizeArgs(null)).toBe(null);
		expect(sanitizeArgs(42)).toBe(42);
		expect(sanitizeArgs(true)).toBe(true);
	});
});

describe("serializeArgs", () => {
	it("caps output at maxBytes with a truncation marker", () => {
		const out = serializeArgs({ data: "lorem ipsum ".repeat(1_000) });
		expect(out.length).toBeLessThanOrEqual(MAX_ARGS_BYTES);
		expect(out.endsWith(TRUNCATED)).toBe(true);
	});

	it("returns valid JSON when under the cap", () => {
		const out = serializeArgs({ a: 1 });
		expect(JSON.parse(out)).toEqual({ a: 1 });
	});

	it("never throws on circular args", () => {
		const a: Record<string, unknown> = {};
		a.self = a;
		expect(() => serializeArgs(a)).not.toThrow();
	});
});
