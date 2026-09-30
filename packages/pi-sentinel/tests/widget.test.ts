import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resetDispatchForTests } from "@parke.dev/pi-dispatch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSentinel, sentinelTone, sentinelWidget } from "../extensions/sentinel.ts";
import { SentinelManager } from "../src/manager.ts";
import type { GateSnapshot, SentinelSnapshot } from "../src/manager.ts";

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

function item(overrides: Partial<SentinelSnapshot> = {}): SentinelSnapshot {
	return {
		name: "checks",
		kind: "watch",
		state: "running",
		createdAt: Date.now() - 1_000,
		nextPollAt: Date.now() + 30_000,
		...overrides,
	};
}

function gate(overrides: Partial<GateSnapshot> = {}): GateSnapshot {
	return {
		active: true,
		complete: false,
		quietForMs: 0,
		nextPollAt: Date.now() + 30_000,
		criteria: [
			{ name: "tests", state: "passing" },
			{ name: "lint", state: "waiting" },
		],
		...overrides,
	};
}

describe("sentinelTone", () => {
	it("maps states to their presentation tones", () => {
		expect(sentinelTone("complete")).toBe("success");
		expect(sentinelTone("failed")).toBe("error");
		expect(sentinelTone("running")).toBe("accent");
		expect(sentinelTone("waiting")).toBe("warning");
	});
});

describe("sentinelWidget", () => {
	it("renders tone-colored rows truncated at every supported width", () => {
		const widget = sentinelWidget([item()], undefined, theme);
		for (const w of [12, 60, 80, 120]) {
			const lines = widget.render(w);
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("\x1b[36m");
			if (w >= 60) expect(stripVTControlCharacters(lines[0]!)).toContain("checks · running");
			expect(width(lines[0]!)).toBeLessThanOrEqual(w);
		}
	});

	it("maps complete/failed states to success/error tones", () => {
		const lines = sentinelWidget(
			[item({ name: "done", state: "complete" }), item({ name: "bad", state: "failed" })],
			undefined,
			theme,
		).render(80);
		expect(lines[0]).toContain("\x1b[32mdone · complete");
		expect(lines[1]).toContain("\x1b[31mbad · failed");
	});

	it("caps at 3 rows with a muted overflow pointer", () => {
		const items = Array.from({ length: 5 }, (_, i) => item({ name: `watch ${i}` }));
		const lines = sentinelWidget(items, undefined, theme).render(80);
		expect(lines).toHaveLength(4);
		expect(lines.at(-1)).toBe(theme.fg("muted", "… +2 more · sentinel_status"));
	});

	it("renders the gate line, success when complete, warning while pending", () => {
		expect(sentinelWidget([], gate(), theme).render(120).at(-1)).toContain("\x1b[33m◉ gate 1/2 next");
		expect(
			sentinelWidget([], gate({ complete: true }), theme)
				.render(120)
				.at(-1),
		).toContain("\x1b[32m✓ gate 1/2 ALL PASS");
	});

	it("sanitizes VT sequences and control characters in names", () => {
		const lines = sentinelWidget(
			[item({ name: "\x1b]0;spoof\x07evil\x1b[31m\u0007name\ninjected" })],
			undefined,
			theme,
		).render(120);
		const line = stripVTControlCharacters(lines[0]!);
		expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
		expect(line).toContain("evil name injected · running");
		expect(line).not.toContain("spoof");
	});
});

describe("sentinel extension UI lifecycle", () => {
	let h: ReturnType<typeof harness>;
	function harness(manager = new SentinelManager()) {
		resetDispatchForTests();
		const handlers = new Map<string, Function[]>();
		const tools = new Map<string, ToolDefinition>();
		const ctx = {
			cwd: "/tmp",
			hasUI: true,
			isIdle: () => true,
			ui: {
				theme,
				setStatus: vi.fn(),
				setWidget: vi.fn(),
				notify: vi.fn(),
			},
		};
		registerSentinel(
			{
				on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
				registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
				sendMessage: vi.fn(),
			} as never,
			manager,
		);
		return {
			ctx,
			tools,
			fire: (name: string) => {
				for (const handler of handlers.get(name) ?? []) handler({}, ctx);
			},
			execute: (name: string, params: Record<string, unknown>) =>
				tools.get(name)!.execute("call", params, undefined, undefined, ctx as never),
		};
	}

	beforeEach(() => vi.useFakeTimers());
	afterEach(async () => {
		vi.useRealTimers();
		h?.fire("session_shutdown");
	});

	it("paints accent status while running and a native widget, then clears both and disposes timers on shutdown", async () => {
		const kill = vi.fn();
		h = harness(
			new SentinelManager(
				async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
				() => Date.now(),
				() => ({ kill }),
			),
		);
		h.fire("session_start");
		await h.execute("sentinel_watch", { name: "review", command: "fixture", mode: "stream" });
		await vi.advanceTimersByTimeAsync(0);
		const status = h.ctx.ui.setStatus.mock.calls
			.slice()
			.reverse()
			.find(([, content]) => content !== undefined);
		expect(status?.[0]).toBe("sentinel");
		expect(status?.[1]).toContain("\x1b[36m");
		expect(status?.[1]).toContain("· sentinel_status");
		const widgetCall = h.ctx.ui.setWidget.mock.calls
			.slice()
			.reverse()
			.find(([, content]) => content !== undefined);
		expect(typeof widgetCall?.[1]).toBe("function");
		const lines = widgetCall![1](undefined, theme).render(80);
		expect(lines[0]).toContain("review · running");
		for (const line of lines) expect(width(line)).toBeLessThanOrEqual(80);
		h.fire("session_shutdown");
		expect(kill).toHaveBeenCalled();
		expect(h.ctx.ui.setStatus).toHaveBeenCalledWith("sentinel", undefined);
		expect(h.ctx.ui.setWidget).toHaveBeenCalledWith("sentinel", undefined);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("sentinel", undefined);
	});

	it("uses warning tone when nothing is actively running", async () => {
		h = harness();
		h.fire("session_start");
		await h.execute("sentinel_gate", { criteria: [{ name: "ready", command: "test" }] });
		const status = h.ctx.ui.setStatus.mock.calls
			.slice()
			.reverse()
			.find(([, content]) => content !== undefined);
		expect(status?.[1]).toContain("\x1b[33m");
	});
});
