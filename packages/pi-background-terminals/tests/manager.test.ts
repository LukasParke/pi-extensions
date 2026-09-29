/**
 * TerminalManager lifecycle: exit states, result consumption, process-tree
 * cleanup, and shutdown disposal. All processes are short-lived and local;
 * every test disposes the manager so nothing outlives the suite.
 */
import { afterEach, describe, expect, it } from "vitest";
import { TerminalManager, type TerminalSnapshot } from "../src/manager.ts";

const isWindows = process.platform === "win32";
const managers: TerminalManager[] = [];

function makeManager() {
	const manager = new TerminalManager();
	managers.push(manager);
	return manager;
}

afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
});

/** Wait until the manager reports the terminal settled. */
async function waitForSettle(
	manager: TerminalManager,
	id: string,
	timeoutMs = 10_000,
): Promise<TerminalSnapshot> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const snapshot = manager.get(id);
		if (snapshot && snapshot.status !== "running") return snapshot;
		if (Date.now() > deadline) throw new Error(`terminal ${id} did not settle in time`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe("exit states", () => {
	it("a zero exit settles as done with exit code 0", async () => {
		const manager = makeManager();
		const { id } = manager.start({ command: "exit 0", title: "ok", cwd: process.cwd() });
		const settled = await waitForSettle(manager, id);
		expect(settled.status).toBe("done");
		expect(settled.exitCode).toBe(0);
	});

	it("a non-zero exit settles as failed with the real code", async () => {
		const manager = makeManager();
		const { id } = manager.start({ command: "exit 3", title: "bad", cwd: process.cwd() });
		const settled = await waitForSettle(manager, id);
		expect(settled.status).toBe("failed");
		expect(settled.exitCode).toBe(3);
	});

	it("captured output is retained on the settled snapshot", async () => {
		const manager = makeManager();
		const { id } = manager.start({ command: "echo hello-out", title: "out", cwd: process.cwd() });
		const settled = await waitForSettle(manager, id);
		expect(settled.stdout.text).toContain("hello-out");
		expect(settled.stdout.totalBytes).toBeGreaterThan(0);
	});
});

describe("kill and process-tree cleanup", () => {
	it.skipIf(isWindows)("kills the whole process tree, not just the shell", async () => {
		const manager = makeManager();
		// Grandchild behind a wait: killing only the shell would leak `sleep`.
		const { id } = manager.start({
			command: "sleep 120 & echo CHILD=$!; wait",
			title: "tree",
			cwd: process.cwd(),
		});
		let childPid = 0;
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			const match = /CHILD=(\d+)/.exec(manager.get(id)?.stdout.text ?? "");
			if (match) {
				childPid = Number(match[1]);
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(childPid).toBeGreaterThan(0);
		expect(alive(childPid)).toBe(true);

		const settled = await manager.kill(id);
		expect(settled.status).toBe("killed");
		// The grandchild is in the same detached process group and must be gone.
		for (let attempt = 0; attempt < 40 && alive(childPid); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(alive(childPid)).toBe(false);
	});

	it("killing an already-settled terminal is a no-op returning the real state", async () => {
		const manager = makeManager();
		const { id } = manager.start({ command: "exit 0", title: "ok", cwd: process.cwd() });
		await waitForSettle(manager, id);
		const again = await manager.kill(id);
		expect(again.status).toBe("done");
		expect(again.exitCode).toBe(0);
	});

	it("kill of an unknown id fails without touching other terminals", async () => {
		const manager = makeManager();
		await expect(manager.kill("bt-999")).rejects.toThrow(/No background terminal bt-999/);
	});
});

describe("result consumption", () => {
	it("onSettle reports consumed when the result was already collected", async () => {
		const manager = makeManager();
		const settled: Array<{ snapshot: TerminalSnapshot; consumed: boolean }> = [];
		manager.onSettle((snapshot, consumed) => settled.push({ snapshot, consumed }));

		const peeked = manager.start({ command: "exit 0", title: "peeked", cwd: process.cwd() });
		const waited = manager.start({ command: "exit 0", title: "waited", cwd: process.cwd() });
		manager.markConsumed(peeked.id);

		await waitForSettle(manager, peeked.id);
		await waitForSettle(manager, waited.id);

		expect(settled.find((entry) => entry.snapshot.id === peeked.id)?.consumed).toBe(true);
		expect(settled.find((entry) => entry.snapshot.id === waited.id)?.consumed).toBe(false);
	});
});

describe("shutdown disposal", () => {
	it.skipIf(isWindows)("disposeAll kills running processes and their trees", async () => {
		const manager = makeManager();
		const { id, pid } = manager.start({ command: "sleep 120", title: "dev", cwd: process.cwd() });
		expect(pid).toBeDefined();
		await manager.disposeAll();
		// disposeAll SIGKILLs without waiting for the final close; settle is async.
		const settled = await waitForSettle(manager, id);
		expect(settled.status).toBe("killed");
		for (let attempt = 0; attempt < 40 && alive(pid!); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(alive(pid!)).toBe(false);
	});

	it("disposeAll is bounded and refuses new starts afterwards", async () => {
		const manager = makeManager();
		manager.start({ command: "sleep 120", title: "dev", cwd: process.cwd() });
		await manager.disposeAll();
		expect(() => manager.start({ command: "echo nope", title: "late", cwd: process.cwd() })).toThrow(
			/shutting down/,
		);
	});
});
