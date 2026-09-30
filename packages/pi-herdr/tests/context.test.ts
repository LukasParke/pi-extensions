import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import herdrExtension from "../extensions/herdr.ts";
import {
	detectHerdrContext,
	herdrContextLine,
	requireManagedHerdr,
	withoutHerdrTools,
	withHerdrContext,
} from "../src/context.ts";

type Handler = (event: Record<string, unknown>, context: TestContext) => unknown;
type Tool = { name: string; execute: (...args: never[]) => unknown };
type Command = { handler: (args: string, context: TestContext) => unknown };
type TestContext = {
	cwd: string;
	ui: {
		notify: ReturnType<typeof vi.fn>;
		editor: ReturnType<typeof vi.fn>;
	};
};

function harness(activeTools: string[]) {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, Tool>();
	const commands = new Map<string, Command>();
	const setActiveTools = vi.fn();
	const context: TestContext = {
		cwd: "/repo",
		ui: { notify: vi.fn(), editor: vi.fn() },
	};
	const api = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerTool(tool: Tool) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, command: Command) {
			commands.set(name, command);
		},
		getActiveTools: () => [...activeTools],
		setActiveTools,
	};
	herdrExtension(api as unknown as ExtensionAPI);
	return {
		commands,
		context,
		handlers,
		setActiveTools,
		tools,
		emit: async (name: string, event: Record<string, unknown> = {}) => {
			let result: unknown;
			for (const handler of handlers.get(name) ?? []) result = await handler(event, context);
			return result;
		},
	};
}

function managedEnv(overrides: Record<string, string | undefined> = {}) {
	return {
		HERDR_ENV: "1",
		HERDR_SOCKET_PATH: "/tmp/herdr.sock",
		HERDR_WORKSPACE_ID: "workspace-1",
		HERDR_TAB_ID: "tab-2",
		HERDR_PANE_ID: "pane-3",
		...overrides,
	};
}

function setProcessEnv(env: Record<string, string | undefined>) {
	for (const name of [
		"HERDR_ENV",
		"HERDR_SOCKET_PATH",
		"HERDR_WORKSPACE_ID",
		"HERDR_TAB_ID",
		"HERDR_PANE_ID",
	]) {
		vi.stubEnv(name, env[name]);
	}
}

afterEach(() => vi.unstubAllEnvs());

describe("detectHerdrContext", () => {
	it("requires the Herdr flag, socket path, and pane id", () => {
		expect(detectHerdrContext(managedEnv())).toEqual({
			mode: "managed",
			managed: true,
			workspaceId: "workspace-1",
			tabId: "tab-2",
			paneId: "pane-3",
		});
		for (const missing of ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID"] as const) {
			for (const empty of ["", "   "]) {
				expect(detectHerdrContext(managedEnv({ [missing]: empty })).managed, missing).toBe(false);
			}
		}
		expect(detectHerdrContext(managedEnv({ HERDR_ENV: "true" })).managed).toBe(false);
	});

	it("only exposes trimmed, safe identity fields", () => {
		expect(
			detectHerdrContext(
				managedEnv({
					HERDR_WORKSPACE_ID: " workspace ",
					HERDR_TAB_ID: " ",
					HERDR_PANE_ID: " pane ",
				}),
			),
		).toEqual({ mode: "managed", managed: true, workspaceId: "workspace", paneId: "pane" });
		expect(JSON.stringify(detectHerdrContext(managedEnv()))).not.toContain("herdr.sock");
		expect(detectHerdrContext(managedEnv({ HERDR_WORKSPACE_ID: "bad\nidentity" }))).not.toHaveProperty(
			"workspaceId",
		);
	});
});

describe("tool availability", () => {
	it("removes only Herdr tools without restoring disabled tools", async () => {
		setProcessEnv({});
		const app = harness(["read", "herdr_task_status", "bash"]);
		await app.emit("session_start", { reason: "startup" });
		expect(app.setActiveTools).toHaveBeenCalledOnce();
		expect(app.setActiveTools).toHaveBeenCalledWith(["read", "bash"]);
		expect(withoutHerdrTools(["read", "bash"])).toEqual(["read", "bash"]);
	});

	it("preserves the active tool set in managed sessions", async () => {
		setProcessEnv(managedEnv());
		const app = harness(["read", "herdr_task"]);
		await app.emit("session_start", { reason: "startup" });
		expect(app.setActiveTools).not.toHaveBeenCalled();
	});

	it("re-evaluates environment changes for reload and resume starts", async () => {
		setProcessEnv(managedEnv());
		const app = harness(["read", "herdr_task"]);
		await app.emit("session_start", { reason: "startup" });
		setProcessEnv({});
		await app.emit("session_start", { reason: "reload" });
		await app.emit("session_start", { reason: "resume" });
		expect(app.setActiveTools).toHaveBeenCalledTimes(2);
		expect(app.setActiveTools).toHaveBeenLastCalledWith(["read"]);
	});

	it("reads fresh environment for each extension harness", async () => {
		setProcessEnv({});
		const standalone = harness(["read", "herdr_task"]);
		await standalone.emit("session_start", { reason: "startup" });
		setProcessEnv(managedEnv());
		const managed = harness(["read", "herdr_task"]);
		await managed.emit("session_start", { reason: "startup" });
		expect(standalone.setActiveTools).toHaveBeenCalledWith(["read"]);
		expect(managed.setActiveTools).not.toHaveBeenCalled();
	});
});

describe("runtime guards", () => {
	it("blocks manually re-enabled tools before Herdr work begins", async () => {
		setProcessEnv({});
		const app = harness([]);
		for (const tool of app.tools.values()) {
			await expect(tool.execute()).rejects.toThrow("standalone Pi session");
		}
	});

	it("notifies from standalone commands without opening an editor or dispatching", async () => {
		setProcessEnv({});
		const app = harness([]);
		await app.commands.get("review")!.handler("https://github.com/acme/repo/pull/1", app.context);
		await app.commands.get("herdr-task")!.handler("ship it", app.context);
		expect(app.context.ui.notify).toHaveBeenCalledTimes(2);
		expect(app.context.ui.notify).toHaveBeenCalledWith(expect.stringContaining("standalone"), "error");
		expect(app.context.ui.editor).not.toHaveBeenCalled();
	});

	it("keeps managed command behavior", async () => {
		setProcessEnv(managedEnv());
		const app = harness([]);
		await app.commands.get("review")!.handler("not-a-pr", app.context);
		expect(app.context.ui.notify).toHaveBeenCalledWith("Usage: /review <github-pr-url>", "error");
	});

	it("keeps project trust registered outside Herdr", () => {
		setProcessEnv({});
		const app = harness([]);
		expect(app.handlers.get("project_trust")).toHaveLength(1);
	});

	it("returns managed context from the defensive guard", () => {
		expect(requireManagedHerdr(detectHerdrContext(managedEnv())).paneId).toBe("pane-3");
	});
});

describe("prompt context", () => {
	it("adds a native section without replacing existing instructions", async () => {
		setProcessEnv({});
		const app = harness([]);
		const event = { systemPrompt: "base", systemPromptOptions: { sections: { existing: "Keep me" } } };
		expect(await app.emit("before_agent_start", event)).toBeUndefined();
		expect(await app.emit("before_agent_start", event)).toBeUndefined();
		expect(event.systemPrompt).toBe("base");
		expect(event.systemPromptOptions.sections).toMatchObject({
			existing: "Keep me",
			herdr_context: expect.stringContaining("subagent or background terminals"),
		});
	});

	it("refreshes the native context section between turns with safe identity", async () => {
		setProcessEnv({});
		const app = harness([]);
		const event = { systemPrompt: "base", systemPromptOptions: { sections: { herdr_context: "stale" } } };
		await app.emit("before_agent_start", event);
		expect(event.systemPromptOptions.sections.herdr_context).toContain("standalone");
		setProcessEnv(managedEnv());
		await app.emit("before_agent_start", event);
		expect(event.systemPromptOptions.sections.herdr_context).toContain(
			"workspace workspace-1, tab tab-2, pane pane-3",
		);
		expect(event.systemPromptOptions.sections.herdr_context).not.toContain("standalone Pi session");
		expect(event.systemPromptOptions.sections.herdr_context).not.toContain("herdr.sock");
		expect(event.systemPrompt).toBe("base");
	});

	it("keeps the public plain-text context helper idempotent", () => {
		const context = detectHerdrContext(managedEnv());
		const first = withHerdrContext("base", context);
		expect(withHerdrContext(first, context)).toBe(first);
		expect(first).toContain(herdrContextLine(context));
	});
});
