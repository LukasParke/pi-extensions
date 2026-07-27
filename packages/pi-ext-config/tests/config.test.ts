import { describe, expect, it } from "vitest";
import {
	boolean,
	configFilePath,
	fromEnv,
	httpUrl,
	nonEmptyString,
	number,
	oneOf,
	resolve,
	sanitize,
	stringArray,
	type Schema,
} from "../src/index.ts";

interface Demo {
	baseUrl: string;
	apiKey?: string;
	timeoutMs: number;
	mode: "a" | "b";
	verbose: boolean;
}

const schema: Schema<Demo> = {
	baseUrl: { validate: httpUrl, env: "DEMO_BASE_URL" },
	apiKey: { validate: nonEmptyString, env: "DEMO_API_KEY" },
	timeoutMs: { validate: number(1_000), env: "DEMO_TIMEOUT_MS" },
	mode: { validate: oneOf(["a", "b"]), env: "DEMO_MODE" },
	verbose: { validate: boolean, env: "DEMO_VERBOSE" },
};

const defaults: Demo = {
	baseUrl: "http://localhost:3000",
	timeoutMs: 90_000,
	mode: "a",
	verbose: false,
};

describe("validators", () => {
	it("httpUrl strips trailing slashes and rejects non-http schemes", () => {
		expect(httpUrl("https://example.com/")).toBe("https://example.com");
		expect(httpUrl("https://example.com/base///")).toBe("https://example.com/base");
		expect(httpUrl("ws://example.com")).toBeUndefined();
		expect(httpUrl("file:///etc/passwd")).toBeUndefined();
		expect(httpUrl("not a url")).toBeUndefined();
		expect(httpUrl("")).toBeUndefined();
		expect(httpUrl(42)).toBeUndefined();
	});

	it("number honors bounds and coerces env strings", () => {
		expect(number(1_000)("5000")).toBe(5000);
		expect(number(1_000)(500)).toBeUndefined();
		expect(number(0, 10)(11)).toBeUndefined();
		expect(number()(Number.NaN)).toBeUndefined();
		expect(number()(Number.POSITIVE_INFINITY)).toBeUndefined();
		expect(number()("abc")).toBeUndefined();
	});

	it("boolean accepts only conventional spellings", () => {
		expect(boolean(true)).toBe(true);
		expect(boolean("true")).toBe(true);
		expect(boolean("1")).toBe(true);
		expect(boolean("false")).toBe(false);
		expect(boolean("0")).toBe(false);
		// "yes"/"on" are deliberately not accepted: silently guessing intent from
		// arbitrary truthy strings is how config bugs hide.
		expect(boolean("yes")).toBeUndefined();
		expect(boolean(1)).toBeUndefined();
	});

	it("oneOf rejects values outside the allowed set", () => {
		expect(oneOf(["a", "b"])("b")).toBe("b");
		expect(oneOf(["a", "b"])("c")).toBeUndefined();
	});

	it("nonEmptyString trims and rejects blanks", () => {
		expect(nonEmptyString("  key  ")).toBe("key");
		expect(nonEmptyString("   ")).toBeUndefined();
	});

	it("stringArray keeps only non-empty strings", () => {
		expect(stringArray(["a", "", "  b  ", 3])).toEqual(["a", "b"]);
		expect(stringArray([])).toBeUndefined();
		expect(stringArray("a")).toBeUndefined();
	});
});

describe("sanitize", () => {
	it("keeps recognized valid keys and drops everything else", () => {
		expect(
			sanitize(schema, {
				baseUrl: "https://steel.example.com",
				timeoutMs: 5_000,
				unknownKey: "ignored",
			}),
		).toEqual({ baseUrl: "https://steel.example.com", timeoutMs: 5_000 });
	});

	it("drops individually invalid values rather than failing the whole file", () => {
		expect(sanitize(schema, { baseUrl: "nonsense", timeoutMs: 7_000 })).toEqual({ timeoutMs: 7_000 });
	});

	it("returns {} for non-object input", () => {
		expect(sanitize(schema, null)).toEqual({});
		expect(sanitize(schema, "string")).toEqual({});
		expect(sanitize(schema, 42)).toEqual({});
	});

	it("ignores absent keys instead of writing undefined over defaults", () => {
		expect("apiKey" in sanitize(schema, { timeoutMs: 2_000 })).toBe(false);
	});
});

describe("fromEnv", () => {
	it("reads only the declared env vars", () => {
		expect(
			fromEnv(schema, { DEMO_BASE_URL: "https://env.example.com", IRRELEVANT: "x" }),
		).toEqual({ baseUrl: "https://env.example.com" });
	});

	it("skips malformed env values", () => {
		expect(fromEnv(schema, { DEMO_TIMEOUT_MS: "not-a-number" })).toEqual({});
		expect(fromEnv(schema, { DEMO_BASE_URL: "://bad" })).toEqual({});
	});
});

describe("resolve", () => {
	it("layers defaults ← file ← env", () => {
		const config = resolve(
			schema,
			defaults,
			{ baseUrl: "https://file.example.com", timeoutMs: 10_000 },
			{ DEMO_BASE_URL: "https://env.example.com" },
		);
		// env wins for baseUrl, file wins for timeoutMs, default fills mode
		expect(config).toEqual({
			baseUrl: "https://env.example.com",
			timeoutMs: 10_000,
			mode: "a",
			verbose: false,
		});
	});

	it("never lets an undefined override erase a default", () => {
		const config = resolve(schema, defaults, { baseUrl: undefined } as never, {});
		expect(config.baseUrl).toBe("http://localhost:3000");
	});

	it("returns defaults when nothing is supplied", () => {
		expect(resolve(schema, defaults, {}, {})).toEqual(defaults);
	});
});

describe("configFilePath", () => {
	it("builds a path inside the pi config dir", () => {
		expect(configFilePath("steel")).toMatch(/\.pi\/steel\.json$/);
	});

	it("honors a rebranded config dir name", () => {
		expect(configFilePath("steel", ".myagent")).toMatch(/\.myagent\/steel\.json$/);
	});
});
