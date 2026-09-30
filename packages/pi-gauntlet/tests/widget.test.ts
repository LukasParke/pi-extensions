import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import register from "../extensions/gauntlet.ts";
import { resetConfigCache } from "../src/config.ts";
import type { GauntletState } from "../src/loop.ts";
import { gauntletWidget } from "../src/report.ts";

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

function state(overrides: Partial<GauntletState> = {}): GauntletState {
	return {
		goal: "make CI green",
		active: true,
		iteration: 2,
		checks: [
			{ name: "tests", command: "npm test" },
			{ name: "lint", command: "npm run lint" },
			{ name: "types", command: "tsc --noEmit" },
		],
		results: {
			tests: { code: 0, output: "ok" },
			lint: { code: 2, output: "eslint error" },
		},
		...overrides,
	};
}

describe("gauntletWidget", () => {
	it("renders goal, progress, and per-check tones truncated at every supported width", () => {
		for (const w of [12, 60, 80, 120]) {
			const lines = gauntletWidget(state(), 10, theme).render(w);
			expect(lines[0]).toContain("\x1b[36m");
			expect(lines[1]).toContain("\x1b[33m");
			expect(lines[2]).toContain("\x1b[32m");
			expect(lines[3]).toContain("\x1b[31m");
			if (w >= 60) {
				expect(stripVTControlCharacters(lines[0]!)).toContain("make CI green");
				expect(stripVTControlCharacters(lines[1]!)).toContain("1/3 passing · iteration 2/10 · /goal status");
				expect(stripVTControlCharacters(lines[2]!)).toContain("✓ tests · passing");
				expect(stripVTControlCharacters(lines[3]!)).toContain("✗ lint · failed");
				expect(lines[4]).toBe(theme.fg("muted", "… +1 checks · /gauntlet"));
			}
			for (const line of lines) expect(width(line)).toBeLessThanOrEqual(w);
		}
	});

	it("turns the progress line success when every check passes", () => {
		const s = state({
			results: {
				tests: { code: 0, output: "" },
				lint: { code: 0, output: "" },
				types: { code: 0, output: "" },
			},
		});
		expect(gauntletWidget(s, 10, theme).render(80)[1]).toContain("\x1b[32m3/3 passing");
	});

	it("shows waiting tone for checks that have not run and no overflow when 2 or fewer", () => {
		const s = state({ checks: [{ name: "tests", command: "npm test" }], results: {} });
		const lines = gauntletWidget(s, 10, theme).render(80);
		expect(lines).toHaveLength(3);
		expect(lines[2]).toContain("\x1b[90m· tests · waiting");
	});

	it("sanitizes VT sequences and control characters in goals and check names", () => {
		const s = state({
			goal: "evil\x1b[2J\u0007goal\nnewline",
			checks: [{ name: "na\x1b[31mme\u0001", command: "x" }],
			results: {},
		});
		const lines = gauntletWidget(s, 10, theme).render(120);
		for (const line of lines) expect(stripVTControlCharacters(line)).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
		expect(stripVTControlCharacters(lines[0]!)).toContain("evil goal newline");
	});
});

describe("gauntlet extension UI lifecycle", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gauntlet-widget-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", path.join(dir, "agent"));
		resetConfigCache();
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		resetConfigCache();
		await fs.rm(dir, { recursive: true, force: true });
	});

	function harness() {
		const handlers = new Map<string, Function>();
		let tool!: ToolDefinition;
		register({
			on: (name: string, handler: Function) => handlers.set(name, handler),
			registerTool: (definition: ToolDefinition) => (tool = definition),
			registerCommand: vi.fn(),
			appendEntry: vi.fn(),
			exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 1 })),
		} as never);
		const ctx = {
			cwd: dir,
			hasUI: true,
			isProjectTrusted: () => false,
			sessionManager: { getBranch: () => [] },
			ui: {
				theme,
				setStatus: vi.fn(),
				setWidget: vi.fn(),
				notify: vi.fn(),
			},
		};
		return {
			ctx,
			get tool() {
				return tool;
			},
			fire: (name: string) => handlers.get(name)!({}, ctx),
			execute: (params: Record<string, unknown>) =>
				tool.execute("call", params, undefined, undefined, ctx as never),
		};
	}

	it("paints a failure-toned status and native widget, then clears both on session_shutdown", async () => {
		const h = harness();
		await h.fire("session_start");
		await h.execute({ action: "add_check", name: "tests", command: "test" });
		await h.execute({ action: "start", goal: "widget regression" });
		await h.execute({ action: "run" });
		const status = h.ctx.ui.setStatus.mock.calls
			.slice()
			.reverse()
			.find(([, content]) => content !== undefined);
		expect(status?.[0]).toBe("gauntlet");
		expect(status?.[1]).toBe(theme.fg("warning", "Gauntlet · running · /goal status"));
		const widgetCall = h.ctx.ui.setWidget.mock.calls
			.slice()
			.reverse()
			.find(([, content]) => content !== undefined);
		expect(typeof widgetCall?.[1]).toBe("function");
		const lines = widgetCall![1](undefined, theme).render(80);
		expect(lines[0]).toContain("\x1b[36mwidget regression");
		for (const line of lines) expect(width(line)).toBeLessThanOrEqual(80);
		await h.fire("session_shutdown");
		expect(h.ctx.ui.setWidget).toHaveBeenCalledWith("gauntlet", undefined);
		expect(h.ctx.ui.setStatus).toHaveBeenCalledWith("gauntlet", undefined);
	});

	it("clears the widget and status when the loop stops", async () => {
		const h = harness();
		await h.fire("session_start");
		await h.execute({ action: "add_check", name: "tests", command: "test" });
		await h.execute({ action: "start", goal: "stop clears" });
		await h.execute({ action: "stop" });
		expect(h.ctx.ui.setWidget).toHaveBeenLastCalledWith("gauntlet", undefined);
		expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("gauntlet", undefined);
	});
});
