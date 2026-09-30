import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep tests hermetic: without this, config load() reads the real ~/.pi/dashboard.json.
const ISOLATED_AGENT_DIR = path.join(os.tmpdir(), "pi-dashboard-test-nonexistent", "agent");

const { poller } = vi.hoisted(() => ({
	poller: {
		setOnChange: vi.fn(),
		request: vi.fn(),
		invalidate: vi.fn(),
	},
}));

vi.mock("../src/index.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/index.ts")>();
	return { ...original, createGitPoller: () => poller };
});

const { default: dashboardExtension } = await import("../extensions/dashboard.ts");

const theme = { fg: (_color: string, text: string) => text };
const tui = { requestRender: vi.fn() };

function footerDataWith(statuses: Record<string, string>) {
	return {
		getExtensionStatuses: () => new Map(Object.entries(statuses)),
		onBranchChange: () => () => {},
		getGitBranch: () => "main",
	};
}

function harness() {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const commands = new Map<string, { handler: (...args: unknown[]) => unknown }>();
	const pi = {
		on: (name: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand: (name: string, command: { handler: (...args: unknown[]) => unknown }) => {
			commands.set(name, command);
		},
		getThinkingLevel: () => "off",
	};
	dashboardExtension(pi as never);
	const ctx = {
		hasUI: true,
		mode: "tui" as const,
		cwd: os.tmpdir(),
		model: undefined,
		getContextUsage: () => undefined,
		sessionManager: { getEntries: () => [], getCwd: () => os.tmpdir() },
		ui: {
			setHeader: vi.fn(),
			setFooter: vi.fn(),
			setTitle: vi.fn(),
			notify: vi.fn(),
			select: vi.fn<(title: string, options: string[]) => Promise<string | undefined>>(),
			theme,
		},
	};
	return {
		ctx,
		commands,
		async fire(name: string, event: Record<string, unknown> = {}) {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
		/** Run the installed footer factory against fake host data so handles.statuses() works. */
		attachFooter(statuses: Record<string, string>) {
			const factory = ctx.ui.setFooter.mock.calls[0]?.[0] as
				| ((t: typeof tui, th: typeof theme, fd: ReturnType<typeof footerDataWith>) => unknown)
				| undefined;
			factory?.(tui, theme, footerDataWith(statuses));
		},
		runCommand(args = "") {
			return commands.get("dashboard")!.handler(args, ctx);
		},
	};
}

describe("dashboard extension UI contract", () => {
	beforeEach(() => {
		process.env.PI_CODING_AGENT_DIR = ISOLATED_AGENT_DIR;
		vi.clearAllMocks();
	});

	afterEach(() => {
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.PI_DASHBOARD_ENABLED;
		delete process.env.PI_DASHBOARD_POLL_MS;
		vi.useRealTimers();
	});

	it("reveals the deliberately selected local status via /dashboard", async () => {
		process.env.PI_DASHBOARD_ENABLED = "true";
		const h = harness();
		await h.fire("session_start");
		h.attachFooter({ alpha: "alpha ready", beta: "beta detail row 1\nbeta detail row 2" });

		h.ctx.ui.select.mockResolvedValue("beta");
		await h.runCommand("status");
		expect(h.ctx.ui.select).toHaveBeenCalledWith("Extension status", ["alpha", "beta"]);
		// Full multi-line text is disclosed locally on selection, not in model context.
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("beta detail row 1\nbeta detail row 2", "info");
	});

	it("notifies when there are no extension statuses to inspect", async () => {
		process.env.PI_DASHBOARD_ENABLED = "true";
		const h = harness();
		await h.fire("session_start");
		h.attachFooter({ blank: "  " });
		await h.runCommand("status");
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("No extension statuses.", "info");
		expect(h.ctx.ui.select).not.toHaveBeenCalled();
	});

	it("notifies instead of touching the UI when the dashboard is disabled", async () => {
		// Default config: enabled false. Stock UI stays, no pollers start.
		const h = harness();
		await h.fire("session_start");
		expect(h.ctx.ui.setHeader).not.toHaveBeenCalled();
		expect(h.ctx.ui.setFooter).not.toHaveBeenCalled();
		expect(poller.request).not.toHaveBeenCalled();

		await h.runCommand("status");
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("Dashboard is disabled or unavailable.", "info");
		expect(h.ctx.ui.select).not.toHaveBeenCalled();
	});

	it("notifies instead of touching the UI when there is no UI", async () => {
		process.env.PI_DASHBOARD_ENABLED = "true";
		const h = harness();
		(h.ctx as { hasUI: boolean }).hasUI = false;
		(h.ctx as { mode: string }).mode = "rpc";
		await h.fire("session_start");
		expect(h.ctx.ui.setFooter).not.toHaveBeenCalled();

		await h.runCommand("status");
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("Dashboard is disabled or unavailable.", "info");
		expect(h.ctx.ui.select).not.toHaveBeenCalled();
	});

	it("stops polling and restores native hooks on session shutdown", async () => {
		vi.useFakeTimers();
		process.env.PI_DASHBOARD_ENABLED = "true";
		process.env.PI_DASHBOARD_POLL_MS = "500";
		const h = harness();
		await h.fire("session_start");
		h.attachFooter({});
		expect(poller.request).toHaveBeenCalledWith(os.tmpdir(), true);

		poller.request.mockClear();
		vi.advanceTimersByTime(1000);
		expect(poller.request).toHaveBeenCalledWith(os.tmpdir(), false);

		await h.fire("session_shutdown");
		expect(h.ctx.ui.setHeader).toHaveBeenLastCalledWith(undefined);
		expect(h.ctx.ui.setFooter).toHaveBeenLastCalledWith(undefined);
		expect(poller.invalidate).toHaveBeenCalled();

		poller.request.mockClear();
		vi.advanceTimersByTime(5000);
		expect(poller.request).not.toHaveBeenCalled();
	});
});
