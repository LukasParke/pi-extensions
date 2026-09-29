/**
 * Native Pi 0.99 tool contracts: outputSchema/structuredContent, annotations,
 * and namespace on fd/rg. Success, no-match, and error branches are covered.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Check } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import register from "../extensions/file-search.ts";

interface ToolDef {
	name: string;
	outputSchema?: import("typebox").TSchema;
	namespace?: { name: string; description?: string };
	annotations?: Record<string, boolean>;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: unknown,
	) => Promise<{
		content: { type: string; text: string }[];
		details: Record<string, unknown>;
		structuredContent?: unknown;
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
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-search-contracts-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const hasBinary = (name: string) => spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0;
const hasRg = hasBinary("rg");
const hasFd = hasBinary("fd");

const ctx = () => ({ cwd: dir });
const rg = (params: Record<string, unknown>) => tools.rg!.execute("t", params, undefined, undefined, ctx());
const fd = (params: Record<string, unknown>) => tools.fd!.execute("t", params, undefined, undefined, ctx());

describe("native tool contracts", () => {
	it("fd and rg declare outputSchema, read-only annotations, and a namespace", () => {
		for (const name of ["fd", "rg"]) {
			const tool = tools[name]!;
			expect(tool.outputSchema).toBeDefined();
			expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
			expect(tool.namespace?.name).toBe("file-search");
		}
	});

	it("fd success structured content validates and carries bounded paths", async () => {
		if (!hasFd) return;
		fs.writeFileSync(path.join(dir, "one.ts"), "");
		fs.writeFileSync(path.join(dir, "two.ts"), "");
		const result = await fd({ pattern: "\\.ts$" });
		expect(Check(tools.fd!.outputSchema!, result.structuredContent)).toBe(true);
		const structured = result.structuredContent as { matches: number; paths: string[]; notes: string[] };
		expect(structured.matches).toBe(2);
		expect(structured.paths).toEqual(expect.arrayContaining(["one.ts", "two.ts"]));
		// The text rendering stays the human-readable path list.
		expect(result.content[0]!.text).toContain("one.ts");
	});

	it("fd no-match branch validates with empty paths", async () => {
		if (!hasFd) return;
		const result = await fd({ pattern: "definitely-not-here-xyz" });
		expect(result.content[0]!.text).toContain("No files found");
		expect(Check(tools.fd!.outputSchema!, result.structuredContent)).toBe(true);
		expect(result.structuredContent).toMatchObject({ matches: 0, paths: [], truncated: false, file: null });
	});

	it("rg success structured content validates with complete output lines", async () => {
		if (!hasRg) return;
		fs.writeFileSync(path.join(dir, "a.txt"), "hello world\nbye\n");
		const result = await rg({ pattern: "hello" });
		expect(Check(tools.rg!.outputSchema!, result.structuredContent)).toBe(true);
		const structured = result.structuredContent as {
			matches: number;
			lines: string[];
		};
		expect(structured.lines).toEqual([expect.stringContaining("a.txt:1:hello world")]);
		expect(result.content[0]!.text).toContain("a.txt:1:hello world");
	});

	it("preserves context and colon-containing filenames without ambiguous parsing", async () => {
		if (!hasRg) return;
		fs.writeFileSync(path.join(dir, "a:123:b.txt"), "before\nhello 2026:09:29\nafter\n");
		const result = await rg({ pattern: "hello", context: 1 });
		expect(Check(tools.rg!.outputSchema!, result.structuredContent)).toBe(true);
		expect(result.structuredContent).toMatchObject({
			output: result.content[0]!.text,
			lines: [
				expect.stringContaining("before"),
				expect.stringContaining("a:123:b.txt:2:hello 2026:09:29"),
				expect.stringContaining("after"),
			],
		});
	});

	it("keeps structured search data bounded when a single line exceeds the byte cap", async () => {
		if (!hasRg) return;
		fs.writeFileSync(path.join(dir, "large.txt"), "hello " + "x".repeat(100_000) + "\n");
		const result = await rg({ pattern: "hello" });
		expect(Check(tools.rg!.outputSchema!, result.structuredContent)).toBe(true);
		const structured = result.structuredContent as {
			output: string;
			lines: string[];
			file: string;
			truncated: boolean;
		};
		expect(structured.truncated).toBe(true);
		expect(structured.lines).toEqual([]);
		expect(Buffer.byteLength(structured.output)).toBeLessThan(52_000);
		expect(fs.readFileSync(structured.file, "utf8")).toContain("x".repeat(100_000));
		fs.rmSync(path.dirname(structured.file), { recursive: true });
	});

	it("rg no-match branch validates", async () => {
		if (!hasRg) return;
		fs.writeFileSync(path.join(dir, "a.txt"), "nothing\n");
		const result = await rg({ pattern: "zzzz-not-present" });
		expect(result.content[0]!.text).toBe("No matches found");
		expect(Check(tools.rg!.outputSchema!, result.structuredContent)).toBe(true);
		expect(result.structuredContent).toMatchObject({ matches: 0, lines: [], partial: false });
	});

	it("rg error branch rejects with the tool failure and no structured content", async () => {
		if (!hasRg) return;
		await expect(rg({ pattern: "[" })).rejects.toThrow(/rg failed:/);
	});

	it("fd error branch rejects for a bad search path", async () => {
		if (!hasFd) return;
		await expect(fd({ pattern: "x", path: "nope/nope" })).rejects.toThrow(/is not a directory/);
	});
});
