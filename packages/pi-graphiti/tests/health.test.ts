import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FactResult } from "../src/client.ts";
import { resetConfigCache } from "../src/config.ts";

// Keep tests hermetic: without this, config load() reads the real ~/.pi/graphiti.json.
const ISOLATED_AGENT_DIR = path.join(os.tmpdir(), "pi-graphiti-health-test-nonexistent", "agent");

const { MockGraphitiClient } = vi.hoisted(() => {
	class MockGraphitiClient {
		static status = vi.fn<() => Promise<{ status: string; message?: string }>>(() =>
			Promise.resolve({ status: "ok" }),
		);
		static searchFacts = vi.fn<() => Promise<FactResult[]>>(() => Promise.resolve([]));
		status() {
			return MockGraphitiClient.status();
		}
		searchFacts() {
			return MockGraphitiClient.searchFacts();
		}
		close() {}
	}
	return { MockGraphitiClient };
});

vi.mock("../src/client.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/client.ts")>();
	return { ...original, GraphitiClient: MockGraphitiClient };
});

const { default: graphitiExtension } = await import("../extensions/graphiti.ts");

function harness() {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const pi = {
		on: (name: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
			tools.set(tool.name, tool);
		},
	};
	graphitiExtension(pi as never);
	const ctx = {
		hasUI: true,
		isIdle: () => true,
		cwd: os.tmpdir(),
		sessionManager: { getBranch: () => [] },
		ui: {
			setStatus: vi.fn(),
			theme: { fg: (color: string, text: string) => `[${color}]${text}` },
		},
	};
	return {
		tools,
		ctx,
		fire(name: string, event: Record<string, unknown> = {}) {
			if (name === "before_agent_start") event.systemPromptOptions ??= { sections: {} };
			const results: unknown[] = [];
			for (const handler of handlers.get(name) ?? []) results.push(handler(event, ctx));
			return results;
		},
	};
}

async function flushMicrotasks(rounds = 30): Promise<void> {
	for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/** setStatus calls that carried a rendered message (not a clear). */
function statusMessages(ctx: { ui: { setStatus: ReturnType<typeof vi.fn> } }): unknown[] {
	return ctx.ui.setStatus.mock.calls.map(([, text]) => text).filter((text) => text !== undefined);
}

describe("graphiti native health status", () => {
	beforeEach(() => {
		vi.stubEnv("PI_CODING_AGENT_DIR", ISOLATED_AGENT_DIR);
		vi.stubEnv("GRAPHITI_BASE_URL", "https://memory.test/mcp");
		resetConfigCache();
		MockGraphitiClient.status.mockClear().mockResolvedValue({ status: "ok" });
		MockGraphitiClient.searchFacts.mockClear().mockResolvedValue([]);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		resetConfigCache();
	});

	it("sets a native warning status when the health check fails on session start", async () => {
		MockGraphitiClient.status.mockRejectedValue(new Error("connection refused"));
		const h = harness();
		h.fire("session_start");
		await vi.waitFor(() => expect(statusMessages(h.ctx)).toHaveLength(1));
		const [message] = statusMessages(h.ctx);
		expect(message).toBe("[warning]Memory unavailable: connection refused · memory_status");
	});

	it("sets a native warning status when the server reports not-ok", async () => {
		MockGraphitiClient.status.mockResolvedValue({ status: "degraded", message: "index rebuild" });
		const h = harness();
		h.fire("session_start");
		await vi.waitFor(() => expect(statusMessages(h.ctx)).toHaveLength(1));
		expect(statusMessages(h.ctx)[0]).toBe("[warning]Memory unavailable: index rebuild · memory_status");
	});

	it("clears the status when a memory_status call recovers", async () => {
		MockGraphitiClient.status.mockRejectedValueOnce(new Error("down"));
		const h = harness();
		h.fire("session_start");
		await vi.waitFor(() => expect(statusMessages(h.ctx)).toHaveLength(1));

		MockGraphitiClient.status.mockResolvedValue({ status: "ok" });
		const tool = h.tools.get("memory_status")!;
		await tool.execute("id", {}, undefined);
		const calls = h.ctx.ui.setStatus.mock.calls;
		expect(calls[calls.length - 1]).toEqual(["graphiti", undefined]);
	});

	it("re-asserts the warning when memory_status still fails, then rethrows", async () => {
		const h = harness();
		h.fire("session_start");
		await vi.waitFor(() => expect(MockGraphitiClient.status).toHaveBeenCalled());

		MockGraphitiClient.status.mockRejectedValue(new Error("still down"));
		const tool = h.tools.get("memory_status")!;
		await expect(tool.execute("id", {}, undefined)).rejects.toThrow("still down");
		expect(statusMessages(h.ctx)).toContain("[warning]Memory unavailable: still down · memory_status");
	});

	it("ignores a health result that resolves after session shutdown", async () => {
		let finish!: (value: { status: string }) => void;
		MockGraphitiClient.status.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const h = harness();
		h.fire("session_start");
		await vi.waitFor(() => expect(MockGraphitiClient.status).toHaveBeenCalled());
		h.fire("session_shutdown");
		const callsAfterShutdown = h.ctx.ui.setStatus.mock.calls.length;

		finish({ status: "ok" });
		await flushMicrotasks();
		// Shutdown cleared the status; the stale resolve must not add another call.
		expect(h.ctx.ui.setStatus.mock.calls.length).toBe(callsAfterShutdown);
		expect(statusMessages(h.ctx)).toHaveLength(0);
	});

	it("ignores a failure from a previous session generation", async () => {
		let finishFirst!: (error: Error) => void;
		MockGraphitiClient.status.mockImplementationOnce(
			() =>
				new Promise((_, reject) => {
					finishFirst = reject;
				}),
		);
		const h = harness();
		h.fire("session_start");
		await vi.waitFor(() => expect(MockGraphitiClient.status).toHaveBeenCalledTimes(1));

		// New session bumps the generation before the first check settles.
		MockGraphitiClient.status.mockResolvedValue({ status: "ok" });
		h.fire("session_start");
		await vi.waitFor(() => expect(MockGraphitiClient.status).toHaveBeenCalledTimes(2));
		await flushMicrotasks();

		finishFirst(new Error("stale failure"));
		await flushMicrotasks();
		expect(statusMessages(h.ctx)).toHaveLength(0);
	});

	it("does not let an old memory_status invocation repaint a replacement session", async () => {
		const h = harness();
		h.fire("session_start");
		await vi.waitFor(() => expect(MockGraphitiClient.status).toHaveBeenCalledTimes(1));
		await flushMicrotasks();
		MockGraphitiClient.status.mockRejectedValueOnce(new Error("old tool failure"));
		const pending = h.tools.get("memory_status")!.execute("id", {}, undefined);
		const rejected = expect(pending).rejects.toThrow("old tool failure");
		h.fire("session_shutdown");
		h.fire("session_start");
		await rejected;
		await flushMicrotasks();
		expect(statusMessages(h.ctx)).toHaveLength(0);
	});

	it("clears the native status on session shutdown", async () => {
		MockGraphitiClient.status.mockRejectedValue(new Error("down"));
		const h = harness();
		h.fire("session_start");
		await vi.waitFor(() => expect(statusMessages(h.ctx)).toHaveLength(1));

		h.fire("session_shutdown");
		const calls = h.ctx.ui.setStatus.mock.calls;
		expect(calls[calls.length - 1]).toEqual(["graphiti", undefined]);
	});
});
