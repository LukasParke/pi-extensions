import { describe, expect, it, vi } from "vitest";
import { defaultConfig, type DashboardConfig } from "../src/config.ts";
import { emptyGitSnapshot } from "../src/git.ts";
import { installDashboardUi, type DashboardState } from "../src/install.ts";
import { emptyModelSnapshot } from "../src/model.ts";

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

function mockFooterData(statuses: Record<string, string> = {}) {
	return {
		getExtensionStatuses: () => new Map(Object.entries(statuses)),
		onBranchChange: () => () => {},
		getGitBranch: () => "main",
	};
}

const theme = { fg: (_color: string, text: string) => text };
const tui = { requestRender: vi.fn() };

function stateWith(config: Partial<DashboardConfig>): DashboardState {
	return {
		config: { ...defaultConfig, ...config },
		model: emptyModelSnapshot(),
		git: emptyGitSnapshot(),
		home: "/home/user",
		title: "pi",
	};
}

function installWithFooter(statuses: Record<string, string>) {
	const ctx = mockCtx();
	const state = stateWith({ enabled: true });
	const handles = installDashboardUi(ctx as never, state, () => state)!;
	const footerFactory = ctx.ui.setFooter.mock.calls[0]![0] as (
		tuiArg: typeof tui,
		themeArg: typeof theme,
		footerData: ReturnType<typeof mockFooterData>,
	) => { render: (width: number) => string[]; dispose: () => void };
	const footer = footerFactory(tui, theme, mockFooterData(statuses));
	return { ctx, handles, footer };
}

describe("dashboard footer extension-status contract", () => {
	it("keeps only the first line of up to two statuses, with overflow disclosure", () => {
		const { footer } = installWithFooter({
			alpha: "alpha ready",
			beta: "beta first row\nbeta second row",
			gamma: "gamma hidden",
		});
		const lines = footer.render(120);
		expect(lines).toContain("alpha ready");
		expect(lines).toContain("beta first row · more: /dashboard status");
		expect(lines).toContain("… +1 extension statuses · /dashboard status");
		// Overflow and continuation rows stay out of the compact footer.
		expect(lines.join("\n")).not.toContain("gamma hidden");
		expect(lines.join("\n")).not.toContain("beta second row");
	});

	it("renders no status lines and no overflow hint when all statuses are blank", () => {
		const { footer } = installWithFooter({ alpha: "  ", beta: "" });
		const lines = footer.render(120);
		expect(lines).toHaveLength(2);
		expect(lines.join("\n")).not.toContain("/dashboard status");
	});

	it("shows two full single-line statuses without an overflow hint", () => {
		const { footer } = installWithFooter({ alpha: "a ok", beta: "b ok" });
		const lines = footer.render(120);
		expect(lines).toContain("a ok");
		expect(lines).toContain("b ok");
		expect(lines.join("\n")).not.toContain("extension statuses");
	});

	it("exposes statuses locally through handles and never into model-facing state", () => {
		const { handles } = installWithFooter({ alpha: "alpha ready" });
		const statuses = handles.statuses();
		expect(statuses.get("alpha")).toBe("alpha ready");
		// Copy, not the live provider map: callers cannot mutate the host's data.
		expect(handles.statuses()).not.toBe(handles.statuses());
	});

	it("returns empty statuses before the footer factory runs and after uninstall", () => {
		const ctx = mockCtx();
		const state = stateWith({ enabled: true });
		const handles = installDashboardUi(ctx as never, state, () => state)!;
		expect(handles.statuses().size).toBe(0);

		const footerFactory = ctx.ui.setFooter.mock.calls[0]![0] as CallableFunction;
		footerFactory(tui, theme, mockFooterData({ alpha: "alpha ready" }));
		expect(handles.statuses().get("alpha")).toBe("alpha ready");

		handles.uninstall();
		expect(handles.statuses().size).toBe(0);
	});
});

describe("dashboard uninstall restores native hooks", () => {
	it("clears header and footer via the native setters", () => {
		const ctx = mockCtx();
		const state = stateWith({ enabled: true, header: true, footer: true });
		const handles = installDashboardUi(ctx as never, state, () => state)!;
		handles.uninstall();
		expect(ctx.ui.setHeader).toHaveBeenLastCalledWith(undefined);
		expect(ctx.ui.setFooter).toHaveBeenLastCalledWith(undefined);
	});

	it("only clears the footer when the header is not installed", () => {
		const ctx = mockCtx();
		const state = stateWith({ enabled: true, header: false, footer: true });
		const handles = installDashboardUi(ctx as never, state, () => state)!;
		handles.uninstall();
		expect(ctx.ui.setHeader).not.toHaveBeenCalled();
		expect(ctx.ui.setFooter).toHaveBeenLastCalledWith(undefined);
	});
});
