import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import register, {
	looksLikeGlobPattern,
	needsMultiline,
	targetsDotfiles,
} from "../extensions/file-search.ts";

interface ToolDef {
	name: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: unknown,
	) => Promise<{
		content: { type: string; text: string }[];
		details: Record<string, unknown>;
	}>;
}

function registeredTools(): Record<string, ToolDef> {
	const tools: Record<string, ToolDef> = {};
	register({ registerTool: (def: ToolDef) => (tools[def.name] = def) } as never);
	return tools;
}

const tools = registeredTools();

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-search-test-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const ctx = () => ({ cwd: dir });
const rg = (params: Record<string, unknown>) => tools.rg!.execute("t", params, undefined, undefined, ctx());
const fd = (params: Record<string, unknown>) => tools.fd!.execute("t", params, undefined, undefined, ctx());

describe("pattern classifiers", () => {
	it("needsMultiline detects literal newlines and \\n escapes", () => {
		expect(needsMultiline("foo\nbar")).toBe(true);
		expect(needsMultiline("foo\\nbar")).toBe(true);
		expect(needsMultiline("foo.bar")).toBe(false);
		expect(needsMultiline("a\\\\n")).toBe(false); // escaped backslash, then literal n
	});

	it("looksLikeGlobPattern only for leading * or ?", () => {
		expect(looksLikeGlobPattern("*.test.ts")).toBe(true);
		expect(looksLikeGlobPattern("?foo")).toBe(true);
		expect(looksLikeGlobPattern("foo.*")).toBe(false);
		expect(looksLikeGlobPattern("file?.ts".slice(1))).toBe(false);
	});

	it("targetsDotfiles detects leading literal dots", () => {
		expect(targetsDotfiles(".env")).toBe(true);
		expect(targetsDotfiles("\\.env")).toBe(true);
		expect(targetsDotfiles(".*")).toBe(false);
		expect(targetsDotfiles("foo.env")).toBe(false);
	});
});

describe("rg resilience", () => {
	it("returns matches when rg exits 2 with unreadable paths, with a note", async () => {
		fs.writeFileSync(path.join(dir, "real.txt"), "hello world\n");
		// The real-world trigger: broken `@scope` symlinks under bun/pnpm node_modules.
		fs.mkdirSync(path.join(dir, "node_modules", "@scope"), { recursive: true });
		fs.symlinkSync("/nonexistent-target-xyz", path.join(dir, "node_modules", "@scope", "pkg"));
		// An unreadable directory reliably forces exit 2 alongside stdout matches
		// (broken symlinks are only statted when following links, which we never do).
		fs.mkdirSync(path.join(dir, "locked"));
		fs.writeFileSync(path.join(dir, "locked", "b.txt"), "hello\n");
		fs.chmodSync(path.join(dir, "locked"), 0o000);
		try {
			const result = await rg({ pattern: "hello" });
			expect(result.content[0]!.text).toContain("real.txt:1:hello world");
			expect(result.content[0]!.text).toContain("some paths were unreadable");
			expect(result.details.partial).toBe(true);
		} finally {
			fs.chmodSync(path.join(dir, "locked"), 0o755);
		}
	});

	it("still fails genuinely bad invocations (unparseable regex)", async () => {
		await expect(rg({ pattern: "[" })).rejects.toThrow(/rg failed:/);
	});

	it("auto-enables multiline for patterns containing a literal newline", async () => {
		fs.writeFileSync(path.join(dir, "multi.txt"), "foo\nbar\n");
		const result = await rg({ pattern: "foo\nbar" });
		expect(result.content[0]!.text).toContain("foo");
		expect(result.content[0]!.text).toContain("multiline");
	});

	it("auto-enables multiline for patterns containing a \\n escape", async () => {
		fs.writeFileSync(path.join(dir, "multi.txt"), "foo\nbar\n");
		const result = await rg({ pattern: "foo\\nbar" });
		expect(result.content[0]!.text).toContain("enabled multiline");
	});
});

describe("fd resilience", () => {
	it("treats a leading-* regex as a glob, with a note", async () => {
		fs.writeFileSync(path.join(dir, "a.test.ts"), "");
		fs.writeFileSync(path.join(dir, "a.ts"), "");
		const result = await fd({ pattern: "*.test.ts" });
		expect(result.content[0]!.text).toContain("a.test.ts");
		expect(result.content[0]!.text).not.toContain("a.ts\n");
		expect(result.content[0]!.text).toContain("treated as a glob");
	});

	it("auto-includes hidden files for dotfile patterns", async () => {
		fs.writeFileSync(path.join(dir, ".env"), "SECRET=1");
		const result = await fd({ pattern: ".env", hidden: false });
		expect(result.content[0]!.text).toContain(".env");
		expect(result.content[0]!.text).toContain("hidden");
	});

	it("reports a bad search path with the resolved path and cwd", async () => {
		await expect(fd({ pattern: "x", path: "services/nope" })).rejects.toThrow(
			/Search path 'services\/nope' \(resolved to '.*services\/nope', cwd '.*'\) is not a directory/,
		);
	});

	it("reports a bad search path that exists but is a file", async () => {
		fs.writeFileSync(path.join(dir, "f.txt"), "");
		await expect(fd({ pattern: "x", path: "f.txt" })).rejects.toThrow(/is not a directory/);
	});
});
