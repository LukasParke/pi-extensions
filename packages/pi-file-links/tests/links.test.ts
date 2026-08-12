import { describe, expect, it } from "vitest";
import { linkLocalPaths } from "../src/links.ts";

const cwd = "/Users/luke/work tree/repo";

function link(text: string, href: string) {
	return `[${text}](${href})`;
}

describe("linkLocalPaths", () => {
	it("links absolute, home, explicit relative, and conservative repo paths", () => {
		expect(linkLocalPaths("/tmp/file.ts", cwd)).toBe(link("/tmp/file.ts", "file:///tmp/file.ts"));
		expect(linkLocalPaths("./src/index.ts ../README.md", cwd)).toBe(
			`${link("./src/index.ts", "file:///Users/luke/work%20tree/repo/src/index.ts")} ${link(
				"../README.md",
				"file:///Users/luke/work%20tree/README.md",
			)}`,
		);
		expect(linkLocalPaths("src/index.ts packages/app/package.json", cwd)).toBe(
			`${link("src/index.ts", "file:///Users/luke/work%20tree/repo/src/index.ts")} ${link(
				"packages/app/package.json",
				"file:///Users/luke/work%20tree/repo/packages/app/package.json",
			)}`,
		);
		expect(linkLocalPaths("~/notes/today.md", cwd)).toContain(
			link("~/notes/today.md", `file://${process.env.HOME}/notes/today.md`),
		);
	});

	it("keeps line and column suffixes out of encoded destinations", () => {
		expect(linkLocalPaths("src/index.ts:12:4", cwd)).toBe(
			link("src/index.ts:12:4", "file:///Users/luke/work%20tree/repo/src/index.ts"),
		);
	});

	it("supports quoted spaces and URL-encodes destinations", () => {
		expect(linkLocalPaths('See "./docs/release notes #1.md".', cwd)).toBe(
			`See "${link(
				"./docs/release notes #1.md",
				"file:///Users/luke/work%20tree/repo/docs/release%20notes%20%231.md",
			)}".`,
		);
	});

	it("preserves code blocks and inline code", () => {
		const markdown = [
			"`./inline.ts` and ./linked.ts",
			"",
			"```ts",
			"./fenced.ts",
			"```",
			"    ./indented.ts",
		].join("\n");
		expect(linkLocalPaths(markdown, cwd)).toBe(
			markdown.replace("./linked.ts", link("./linked.ts", "file:///Users/luke/work%20tree/repo/linked.ts")),
		);
	});

	it("preserves existing links, images, references, URLs, escapes, and prose", () => {
		const markdown = [
			"[source](./src/index.ts)",
			"![image](/tmp/image.png)",
			"[source][ref]",
			"[src/index.ts]",
			"[ref]: ./src/index.ts",
			"https://example.com/src/index.ts",
			"<file:///tmp/already.ts>",
			String.raw`\./escaped.ts`,
			"docs.example.com/path.md",
			"version 1.2.3 and ratio 1/2 and words foo/bar",
		].join("\n");
		expect(linkLocalPaths(markdown, cwd)).toBe(markdown);
	});

	it("is idempotent", () => {
		const once = linkLocalPaths("Open ./src/index.ts:8", cwd);
		expect(linkLocalPaths(once, cwd)).toBe(once);
	});

	it("rejects unsafe control and format characters", () => {
		expect(linkLocalPaths('"./bad\u0007name.ts"', cwd)).toBe('"./bad\u0007name.ts"');
		expect(linkLocalPaths('"./bad\u202ename.ts"', cwd)).toBe('"./bad\u202ename.ts"');
	});

	it("returns input unchanged when hyperlinks are unsupported", () => {
		expect(linkLocalPaths("./src/index.ts", cwd, false)).toBe("./src/index.ts");
	});

	it("links streaming partial text synchronously", () => {
		expect(linkLocalPaths("Writing ./src/part", cwd)).toBe(
			`Writing ${link("./src/part", "file:///Users/luke/work%20tree/repo/src/part")}`,
		);
		expect(linkLocalPaths("Writing ./src/partial.ts", cwd)).toBe(
			`Writing ${link("./src/partial.ts", "file:///Users/luke/work%20tree/repo/src/partial.ts")}`,
		);
	});
});
