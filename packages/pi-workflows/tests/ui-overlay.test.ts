import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { emptyUsage } from "@parke.dev/pi-subagent/sdk";
import { describe, expect, it, vi } from "vitest";
import type { LiveWorkflowRun } from "../src/registry.ts";
import {
	cleanLabel,
	compactText,
	openWorkflowsOverlay,
	widgetLines,
	workflowResultLines,
	workflowTone,
	workflowWidget,
} from "../src/ui.ts";

function run(overrides: Partial<LiveWorkflowRun> = {}): LiveWorkflowRun {
	return {
		runId: `wf-${Math.random().toString(36).slice(2, 10)}`,
		sessionKey: "session",
		label: "test",
		state: "running",
		startedAt: 1,
		agentCount: 1,
		completedAgents: 0,
		failedAgents: 0,
		usage: emptyUsage(),
		artifactPath: "/tmp/workflow",
		delivered: false,
		claimed: false,
		controller: new AbortController(),
		promise: new Promise(() => {}),
		sourceHash: "source",
		argsHash: "args",
		cwd: "/repo",
		...overrides,
	};
}

const CODES: Record<string, [number, number]> = {
	accent: [36, 39],
	muted: [90, 39],
	error: [31, 39],
	success: [32, 39],
	warning: [33, 39],
	dim: [2, 22],
	toolOutput: [37, 39],
	toolTitle: [35, 39],
};
const theme = {
	fg: (color: string, text: string) => {
		const [open, close] = CODES[color] ?? [37, 39];
		return `\x1b[${open}m${text}\x1b[${close}m`;
	},
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as unknown as Theme;

const width = visibleWidth;

describe("workflowTone", () => {
	it("maps states to their presentation tones", () => {
		expect(workflowTone("failed")).toBe("error");
		expect(workflowTone("timeout")).toBe("warning");
		expect(workflowTone("partial")).toBe("warning");
		expect(workflowTone("waiting")).toBe("warning");
		expect(workflowTone("completed")).toBe("success");
		expect(workflowTone("ready")).toBe("success");
		expect(workflowTone("cancelled")).toBe("muted");
		expect(workflowTone("running")).toBe("accent");
	});
});

describe("widgetLines", () => {
	it("caps at 4 rows with an overflow pointer to /workflows", () => {
		const runs = Array.from({ length: 7 }, (_, i) => run({ runId: `wf-${i}`, label: `run ${i}` }));
		const lines = widgetLines(runs)!;
		expect(lines).toHaveLength(5);
		expect(lines[4]).toBe("… +3 more · /workflows");
	});

	it("includes undelivered terminal runs and clears when nothing is actionable", () => {
		expect(widgetLines([run({ state: "completed" })])![0]).toContain("completed");
		expect(
			widgetLines([run({ state: "completed", delivered: true }), run({ state: "failed", claimed: true })]),
		).toBeUndefined();
	});

	it("sanitizes malicious labels and phases", () => {
		const lines = widgetLines([run({ label: "evil\x1b[31m\u0007name\ninjected", phase: "ph\u0001ase" })])!;
		expect(lines[0]).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
		expect(lines[0]).toContain("evil name injected · ph ase");
	});
});

describe("workflowWidget", () => {
	const runs = [
		run({ label: "active run", state: "running" }),
		run({ label: "failed run", state: "failed" }),
	];

	it("renders tone-colored rows truncated to every supported width", () => {
		for (const w of [12, 60, 80, 120]) {
			const lines = workflowWidget(runs, theme).render(w);
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) expect(width(line)).toBeLessThanOrEqual(w);
			expect(lines[0]).toContain("\x1b[36m");
			expect(lines[1]).toContain("\x1b[31m");
		}
	});

	it("renders nothing when nothing is actionable", () => {
		expect(workflowWidget([run({ state: "completed", delivered: true })], theme).render(80)).toEqual([]);
	});

	it("colors the overflow row muted", () => {
		const many = Array.from({ length: 6 }, (_, i) => run({ runId: `wf-${i}`, label: `r${i}` }));
		const lines = workflowWidget(many, theme).render(120);
		expect(lines.at(-1)).toContain("\x1b[90m… +2 more · /workflows");
	});
});

describe("cleanLabel / compactText", () => {
	it("strips VT sequences and control characters", () => {
		expect(cleanLabel("a\x1b[2Jb\u0000c\nd")).toBe("ab c d");
	});

	it("pre-truncates rows so the native Text never wraps past the width", () => {
		const component = compactText(() => ["x".repeat(200), "short"]);
		for (const w of [12, 60, 80, 120]) {
			for (const line of component.render(w)) expect(width(line)).toBeLessThanOrEqual(w);
		}
	});
});

describe("workflowResultLines", () => {
	const result = (details: unknown, text = "body line") => ({
		content: [{ type: "text", text }],
		details,
	});

	it("renders failure tone and error line on tool errors", () => {
		const lines = workflowResultLines(
			result({ label: "nightly", state: "failed", summary: { failure: "boom" } }),
			{ expanded: false, isPartial: false, isError: true },
			theme,
		);
		expect(lines[0]).toContain("\x1b[31mnightly · failed");
		expect(lines.some((line) => line.includes("\x1b[31mboom"))).toBe(true);
	});

	it("renders agent accounting and artifact pointer when collapsed", () => {
		const lines = workflowResultLines(
			result({
				label: "nightly",
				summary: { agentCount: 3, completedAgents: 1, phase: "fanout", artifactPath: "/tmp/a" },
			}),
			{ expanded: false, isPartial: true },
			theme,
		);
		expect(lines[0]).toContain("\x1b[36mnightly · running");
		expect(lines[1]).toContain("1/3 agents · fanout");
		expect(lines.at(-1)).toContain("Artifacts: /tmp/a");
	});

	it("expands the body capped at 40 lines and sanitizes it", () => {
		const body = Array.from({ length: 50 }, (_, i) => `line ${i}\x1b[0m`).join("\n");
		const lines = workflowResultLines(
			result({ label: "big" }, body),
			{ expanded: true, isPartial: false },
			theme,
		);
		expect(lines).toHaveLength(42); // header + 40 body rows + overflow note
		expect(lines.at(-1)).toContain("… more in workflow artifacts");
		expect(stripVTControlCharacters(lines.join("\n"))).not.toMatch(/\x1b/);
	});

	it("renders the live/recent summary form", () => {
		const lines = workflowResultLines(
			result({ live: [1, 2], recent: [3] }),
			{ expanded: false, isPartial: false },
			theme,
		);
		expect(lines[0]).toBe(theme.fg("success", "2 live · 1 recent · /workflows"));
	});
});

describe("openWorkflowsOverlay", () => {
	function overlayHarness(runs: LiveWorkflowRun[], rows = 24) {
		const adapter = {
			list: vi.fn(() => runs),
			cancel: vi.fn(),
			notify: vi.fn(),
		};
		const tui = { terminal: { rows, cols: 80 }, requestRender: vi.fn() };
		let doneResult: unknown = "pending";
		const component = openWorkflowsOverlay(tui as never, theme, (r) => (doneResult = r), adapter);
		return {
			component,
			adapter,
			tui,
			get done() {
				return doneResult;
			},
			render: (w = 80) => component.render(w),
			input: (data: string) => component.handleInput?.(data),
		};
	}

	it("renders header, empty state, and closes on q and escape", () => {
		const h = overlayHarness([]);
		const lines = h.render(60);
		expect(lines[0]).toContain("Workflows");
		expect(lines[1]).toContain("No workflow runs in this session.");
		for (const line of lines) expect(width(line)).toBeLessThanOrEqual(60);
		h.input("q");
		expect(h.done).toBeUndefined();
	});

	it("sorts active before ready before history and truncates every row", () => {
		const h = overlayHarness([
			run({ runId: "wf-history", label: "history", state: "completed", delivered: true }),
			run({ runId: "wf-active", label: "active", state: "running" }),
			run({ runId: "wf-ready", label: "ready", state: "completed" }),
		]);
		const lines = h.render(80);
		expect(lines[1]).toContain("active");
		expect(lines[2]).toContain("ready");
		expect(lines[3]).toContain("history");
		for (const w of [12, 60, 80, 120])
			for (const line of h.render(w)) expect(width(line)).toBeLessThanOrEqual(w);
	});

	it("navigates with j/k, clamps at the ends, and repaints", () => {
		const h = overlayHarness([run({ label: "a" }), run({ label: "b" })]);
		h.input("k"); // clamped at top
		expect(h.render()[1]).toMatch(/^› /);
		h.input("j");
		expect(h.render()[2]).toMatch(/^› /);
		h.input("j"); // clamped at bottom
		expect(h.render()[2]).toMatch(/^› /);
		expect(h.tui.requestRender).toHaveBeenCalled();
	});

	it("keeps selection on the same run when the list resorts", () => {
		const runs = [
			run({ runId: "wf-first", label: "first", state: "running" }),
			run({ runId: "wf-second", label: "second", state: "running" }),
		];
		const h = overlayHarness(runs);
		h.input("j"); // select wf-second
		runs[0]!.state = "completed";
		runs[0]!.delivered = true; // wf-first drops to history; wf-second becomes row 0
		expect(h.render()[1]).toContain("› ");
		expect(h.render()[1]).toContain("second");
	});

	it("cancels only non-terminal runs on x", () => {
		const active = run({ runId: "wf-active", state: "running" });
		const done = run({ runId: "wf-done", state: "completed", delivered: true });
		const h = overlayHarness([done, active]);
		h.input("x");
		expect(h.adapter.cancel).toHaveBeenCalledWith("wf-active");
		expect(h.adapter.notify).toHaveBeenCalledWith("Cancelled wf-active", "info");
		h.input("j"); // move onto the terminal history row
		h.adapter.cancel.mockClear();
		h.input("x");
		expect(h.adapter.cancel).not.toHaveBeenCalled();
	});

	it("toggles the detail pane with enter and shows usage/artifacts", () => {
		const h = overlayHarness([run({ label: "detail" })]);
		const collapsed = h.render();
		expect(collapsed.some((line) => line.includes("Artifacts:"))).toBe(false);
		h.input("\r");
		const expanded = h.render();
		expect(expanded.some((line) => line.includes("Artifacts: /tmp/workflow"))).toBe(true);
		expect(expanded.at(-1)).toContain("enter summary");
		h.input("\r");
		expect(h.render().some((line) => line.includes("Artifacts:"))).toBe(false);
	});

	it("scrolls the window to keep the selection visible on small terminals", () => {
		const runs = Array.from({ length: 20 }, (_, i) => run({ runId: `wf-${i}`, label: `run ${i}` }));
		const h = overlayHarness(runs, 10); // pageSize = max(1, floor(10*0.7) - 3) = 4
		for (let i = 0; i < 10; i++) h.input("j");
		const lines = h.render(80);
		expect(lines.at(-1)).toContain("11/20");
		expect(lines.join("\n")).toContain("run 10");
		expect(lines.join("\n")).not.toContain("run 0 ");
	});

	it("survives narrow widths and resize while expanded", () => {
		const h = overlayHarness([run({ label: "wide".repeat(50) })]);
		h.input("\r");
		for (const w of [12, 60, 80, 120]) {
			for (const line of h.render(w)) expect(width(line)).toBeLessThanOrEqual(w);
		}
	});

	it("ignores input after dispose and stops repainting", () => {
		const h = overlayHarness([run()]);
		h.component.dispose();
		h.input("q");
		expect(h.done).toBe("pending");
		h.component.invalidate();
		expect(h.tui.requestRender).not.toHaveBeenCalled();
	});
});
