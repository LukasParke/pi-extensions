import { describe, expect, it, vi } from "vitest";
import { defaultConfig, resolveConfig, schema } from "../src/config.ts";
import { installDashboardUi, type DashboardState } from "../src/install.ts";
import { emptyGitSnapshot } from "../src/git.ts";
import { emptyModelSnapshot } from "../src/model.ts";

describe("dashboard config defaults off", () => {
	it("defaultConfig has enabled: false", () => {
		expect(defaultConfig.enabled).toBe(false);
		expect(defaultConfig.header).toBe(true);
		expect(defaultConfig.footer).toBe(true);
		expect(defaultConfig.showPr).toBe(true);
		expect(defaultConfig.pollIntervalMs).toBe(60_000);
	});

	it("resolve keeps enabled false without overrides", () => {
		const config = resolveConfig(schema, defaultConfig, {}, {});
		expect(config.enabled).toBe(false);
	});

	it("env can enable", () => {
		const config = resolveConfig(
			schema,
			defaultConfig,
			{},
			{
				PI_DASHBOARD_ENABLED: "true",
				PI_DASHBOARD_POLL_MS: "5000",
				PI_DASHBOARD_TITLE: "demo",
			},
		);
		expect(config.enabled).toBe(true);
		expect(config.pollIntervalMs).toBe(5000);
		expect(config.title).toBe("demo");
	});

	it("file override is beaten by env", () => {
		const config = resolveConfig(
			schema,
			defaultConfig,
			{ enabled: true, header: false },
			{ PI_DASHBOARD_ENABLED: "false" },
		);
		expect(config.enabled).toBe(false);
		expect(config.header).toBe(false);
	});

	it("accepts an explicit lower poll interval", () => {
		const fromFile = resolveConfig(schema, defaultConfig, { pollIntervalMs: 1000 }, {});
		const fromEnv = resolveConfig(schema, defaultConfig, {}, { PI_DASHBOARD_POLL_MS: "500" });
		expect(fromFile.pollIntervalMs).toBe(1000);
		expect(fromEnv.pollIntervalMs).toBe(500);
	});

	it("malformed env falls through to default", () => {
		const config = resolveConfig(
			schema,
			defaultConfig,
			{},
			{
				PI_DASHBOARD_POLL_MS: "nope",
				PI_DASHBOARD_ENABLED: "yes-please",
			},
		);
		expect(config.enabled).toBe(false);
		expect(config.pollIntervalMs).toBe(60_000);
	});
});

describe("installDashboardUi disabled boundary", () => {
	function mockCtx() {
		return {
			hasUI: true,
			mode: "tui" as const,
			cwd: "/tmp",
			ui: {
				setHeader: vi.fn(),
				setFooter: vi.fn(),
				setTitle: vi.fn(),
			},
			sessionManager: { getEntries: () => [], getCwd: () => "/tmp" },
			getContextUsage: () => undefined,
			model: undefined,
		};
	}

	it("does not touch UI when enabled is false", () => {
		const ctx = mockCtx();
		const state: DashboardState = {
			config: { ...defaultConfig, enabled: false },
			model: emptyModelSnapshot(),
			git: emptyGitSnapshot(),
			home: "/home/user",
			title: "pi",
		};
		const handles = installDashboardUi(ctx as never, state, () => state);
		expect(handles).toBeNull();
		expect(ctx.ui.setHeader).not.toHaveBeenCalled();
		expect(ctx.ui.setFooter).not.toHaveBeenCalled();
		expect(ctx.ui.setTitle).not.toHaveBeenCalled();
	});

	it("does not touch UI outside TUI mode even if enabled", () => {
		const ctx = { ...mockCtx(), mode: "rpc" as const };
		const state: DashboardState = {
			config: { ...defaultConfig, enabled: true },
			model: emptyModelSnapshot(),
			git: emptyGitSnapshot(),
			home: "/home/user",
			title: "pi",
		};
		const handles = installDashboardUi(ctx as never, state, () => state);
		expect(handles).toBeNull();
		expect(ctx.ui.setHeader).not.toHaveBeenCalled();
		expect(ctx.ui.setFooter).not.toHaveBeenCalled();
	});

	it("installs header and footer when enabled", () => {
		const ctx = mockCtx();
		const state: DashboardState = {
			config: { ...defaultConfig, enabled: true },
			model: emptyModelSnapshot(),
			git: emptyGitSnapshot(),
			home: "/home/user",
			title: "pi",
		};
		const handles = installDashboardUi(ctx as never, state, () => state);
		expect(handles).not.toBeNull();
		expect(ctx.ui.setHeader).toHaveBeenCalledOnce();
		expect(ctx.ui.setFooter).toHaveBeenCalledOnce();
		expect(ctx.ui.setTitle).toHaveBeenCalledOnce();
	});

	it("respects header/footer flags independently", () => {
		const ctx = mockCtx();
		const state: DashboardState = {
			config: { ...defaultConfig, enabled: true, header: false, footer: true },
			model: emptyModelSnapshot(),
			git: emptyGitSnapshot(),
			home: "/home/user",
			title: "pi",
		};
		installDashboardUi(ctx as never, state, () => state);
		expect(ctx.ui.setHeader).not.toHaveBeenCalled();
		expect(ctx.ui.setFooter).toHaveBeenCalledOnce();
	});
});
