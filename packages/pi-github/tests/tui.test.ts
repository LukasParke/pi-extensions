import { describe, expect, it } from "vitest";
import {
	checkRowLines,
	issueRowLines,
	plain,
	pullRowLines,
	renderPullRows,
	renderToolCall,
} from "../src/tui.ts";

/**
 * Terminal rendering.
 *
 * `renderCall`/`renderResult` fire only in Pi's TUI, so nothing here is load-bearing — the model reads `content` and a UI
 * reads `details`. What IS load-bearing is the escape stripping: a PR title comes from outside, and the host already found a
 * terminal escape forging an approval line once.
 */

/** Visible columns, ignoring ANSI. What a terminal actually shows. */
const visible = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, "").length;

const pull = (over: Record<string, unknown> = {}) =>
	({
		number: 7,
		title: "a change",
		author: "alice",
		state: "open",
		review: "approved",
		checks: "passing",
		...over,
	}) as Parameters<typeof pullRowLines>[0][number];

describe("AC-12.46 escape stripping", () => {
	it("a title cannot erase the line and forge a message", () => {
		/**
		 * THE security property of this file.
		 *
		 * `\x1b[2K\r` erases the current line and returns the cursor, so a crafted title could overwrite what Pi printed and
		 * write `✓ approved by you` in its place. Phase 6 found exactly this in an OpenUI body. A PR title is attacker-supplied
		 * on any public repository.
		 */
		const hostile = "ok\x1b[2K\r\x1b[32m✓ approved by you\x1b[0m";
		const line = pullRowLines([pull({ title: hostile })], 200)[0] ?? "";
		expect(line).not.toContain("\x1b[2K");
		expect(line).not.toContain("\r");
		// The text survives; only the control characters go.
		expect(line).toContain("approved by you");
	});

	it("strips every C0 and C1 control except tab", () => {
		/**
		 * A denylist of dangerous escapes is a research project; an allowlist of nothing is provable. No PR title needs a
		 * cursor movement, so the useful set is empty and the result is unambiguously inert.
		 */
		expect(plain("a\x00b\x07c\x1bd\x7fe\x9bf")).toBe("abcdef");
		expect(plain("keep\there")).toBe("keep\there");
		expect(plain("newline\nkept")).toBe("newline\nkept");
	});

	it("an author and a label are stripped too, not only the title", () => {
		// Every provider-supplied string, because "we sanitise the title" is a claim that decays at the second field.
		const line = pullRowLines([pull({ author: "bob\x1b[2K" })], 200)[0] ?? "";
		expect(line).not.toContain("\x1b[2K");

		const issue =
			issueRowLines([{ number: 1, title: "t", labels: ["bug\x1b[2K"], assignees: ["x\x1b[2K"] }], 200)[0] ??
			"";
		expect(issue).not.toContain("\x1b[2K");
	});
});

describe("width adaptation", () => {
	it("a narrow terminal truncates the title rather than wrapping", () => {
		/**
		 * Width-adaptive because a fixed width makes the feature useless on the surface it exists for (R-12.2).
		 *
		 * Measured on VISIBLE columns, not bytes: an ANSI-coloured word is longer in bytes than on screen, so budgeting by
		 * string length would truncate a coloured row early and could leave a dangling escape.
		 */
		const long = pull({ title: "x".repeat(300) });
		const narrow = pullRowLines([long], 60)[0] ?? "";
		const wide = pullRowLines([long], 200)[0] ?? "";
		expect(visible(narrow)).toBeLessThanOrEqual(60);
		expect(visible(wide)).toBeGreaterThan(visible(narrow));
		expect(narrow).toContain("…");
	});

	it("a pathologically narrow terminal still produces a usable line", () => {
		// A 10-column terminal is absurd but reachable via a split pane; a floor beats a negative slice.
		const line = pullRowLines([pull({ title: "x".repeat(100) })], 10)[0] ?? "";
		expect(line.length).toBeGreaterThan(0);
		expect(line).not.toContain("undefined");
	});

	it("numbers are aligned so a column scan works", () => {
		const lines = pullRowLines([pull({ number: 7 }), pull({ number: 1234 })], 200);
		// `#   7` and `#1234` — the padding is what makes a vertical scan possible.
		expect(lines[0]).toContain("#   7");
		expect(lines[1]).toContain("#1234");
	});
});

describe("state is a word, never a colour alone", () => {
	it("every status word appears in the output text", () => {
		/**
		 * the host's rule, and it travels to a package that has never heard of the host because it is about readers, not about
		 * Accessibility: a red dot says nothing to a screen reader, and nothing to someone who cannot distinguish it from green.
		 */
		const line =
			pullRowLines([pull({ state: "draft", review: "changes requested", checks: "failing" })], 200)[0] ?? "";
		const text = line.replace(/\x1b\[[0-9;]*m/g, "");
		expect(text).toContain("draft");
		expect(text).toContain("changes requested");
		expect(text).toContain("failing");
	});

	it("an unmapped status still renders its word, undecorated", () => {
		// A status GitHub adds later must not vanish because there is no colour for it.
		const line = checkRowLines([{ name: "ci", status: "some_new_state", durationSec: null }])[0] ?? "";
		expect(line.replace(/\x1b\[[0-9;]*m/g, "")).toContain("some_new_state");
	});

	it("an empty list says so rather than rendering nothing", () => {
		// A blank panel is indistinguishable from a broken one.
		expect(pullRowLines([], 80)[0]).toContain("no open pull requests");
		expect(checkRowLines([])[0]).toContain("no check runs");
		expect(issueRowLines([], 80)[0]).toContain("no matching issues");
	});
});

describe("the Component contract", () => {
	it("renderers return something with render(width) and invalidate()", () => {
		/**
		 * Pi requires a `Component`, not a string — the compiler said so after I wrote strings, and this pins the corrected
		 * shape. Declared structurally so `pi-tui` stays a peer dependency and `src/` remains importable by a desktop UI.
		 */
		const c = renderPullRows([pull()]);
		expect(typeof c.render).toBe("function");
		expect(typeof c.invalidate).toBe("function");
		expect(c.render(80).length).toBe(1);
		// `invalidate` is a no-op because nothing is cached; calling it must not throw.
		expect(() => c.invalidate()).not.toThrow();
	});

	it("the width reaches the renderer, rather than a default being guessed", () => {
		const c = renderPullRows([pull({ title: "y".repeat(300) })]);
		expect(visible(c.render(60)[0] ?? "")).toBeLessThanOrEqual(60);
		expect(visible(c.render(160)[0] ?? "")).toBeGreaterThan(60);
	});

	it("a tool call renders a one-line summary naming the repository", () => {
		const c = renderToolCall("github_prs", { repo: "o/r" });
		expect(c.render(80)[0]).toContain("github prs o/r");
		// An inferred repo says nothing, which is the common case.
		expect(renderToolCall("github_prs", {}).render(80)[0]).not.toContain("undefined");
	});

	it("a tool call summary cannot smuggle an escape from an argument", () => {
		// The `repo` argument can come from a model, which can be steered by a hostile file.
		const c = renderToolCall("github_prs", { repo: "o/r\x1b[2K\rfake" });
		expect(c.render(80)[0]).not.toContain("\x1b[2K");
	});
});
