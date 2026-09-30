import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import register, { backgroundTerminalWidget } from "../extensions/background-terminals.ts";
import type { TerminalSnapshot } from "../src/manager.ts";

function snapshot(overrides: Partial<TerminalSnapshot> = {}): TerminalSnapshot {
	return {
		id: `bg-${Math.random().toString(36).slice(2, 8)}`,
		title: "dev server",
		command: "npm run dev",
		cwd: "/tmp",
		status: "running",
		createdAt: Date.now() - 5_000,
		...overrides,
	} as TerminalSnapshot;
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

describe("backgroundTerminalWidget", () => {
	it("renders accent title rows truncated at every supported width", () => {
		const widget = backgroundTerminalWidget([snapshot()], theme);
		for (const w of [12, 60, 80, 120]) {
			const lines = widget.render(w);
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("\x1b[36m");
			if (w >= 60) {
				expect(stripVTControlCharacters(lines[0]!)).toContain("dev server · running");
				expect(lines[0]).toContain("\x1b[90m");
			}
			expect(width(lines[0]!)).toBeLessThanOrEqual(w);
		}
	});

	it("caps at 4 rows with a muted overflow pointer to /ps", () => {
		const entries = Array.from({ length: 6 }, (_, i) => snapshot({ title: `term ${i}` }));
		const lines = backgroundTerminalWidget(entries, theme).render(80);
		expect(lines).toHaveLength(5);
		expect(lines.at(-1)).toBe(theme.fg("muted", "… +2 more · /ps"));
	});

	it("sanitizes VT sequences and control characters in titles", () => {
		const lines = backgroundTerminalWidget(
			[snapshot({ title: "\x1b]0;spoof\x07evil\x1b[2J\u0007title\nnewline" })],
			theme,
		).render(120);
		const line = stripVTControlCharacters(lines[0]!);
		expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
		expect(line).toContain("evil title newline · running");
		expect(line).not.toContain("spoof");
	});
});

describe("session_shutdown UI cleanup", () => {
	let h: ReturnType<typeof harness>;
	function harness() {
		const handlers = new Map<string, Function>();
		const tools = new Map<string, ToolDefinition>();
		const ctx = {
			cwd: "/tmp",
			hasUI: true,
			ui: {
				theme,
				setStatus: vi.fn(),
				setWidget: vi.fn(),
				notify: vi.fn(),
			},
		};
		register({
			registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
			registerCommand: vi.fn(),
			on: (event: string, handler: Function) => handlers.set(event, handler),
			sendMessage: vi.fn(),
		} as never);
		return {
			ctx,
			fire: (name: string) => handlers.get(name)!({}, ctx),
			start: (command: string) =>
				tools
					.get("bg_start")!
					.execute("call", { command, title: "widget-test" }, undefined, undefined, ctx as never),
		};
	}

	beforeEach(() => {
		h = harness();
		h.fire("session_start");
	});

	afterEach(async () => {
		vi.useRealTimers();
		await h.fire("session_shutdown").catch(() => {});
	});

	it("paints a native widget while a terminal runs, then clears status/widget and disposes on shutdown", async () => {
		vi.useFakeTimers();
		const started = await h.start("sleep 30");
		expect(started.isError).not.toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		const widgetCall = h.ctx.ui.setWidget.mock.calls
			.slice()
			.reverse()
			.find(([, content]) => content !== undefined);
		expect(typeof widgetCall?.[1]).toBe("function");
		const lines = widgetCall![1](undefined, theme).render(80);
		expect(lines[0]).toContain("\x1b[36mwidget-test · running");
		await h.fire("session_shutdown");
		expect(h.ctx.ui.setStatus).toHaveBeenCalledWith("background-terminals", undefined);
		expect(h.ctx.ui.setWidget).toHaveBeenCalledWith("background-terminals", undefined);
	});
});
