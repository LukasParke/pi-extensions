import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSavedWorkflows, resolveSavedWorkflow, saveWorkflow } from "../src/saved.ts";

const temps: string[] = [];

afterEach(async () => {
	await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-saved-"));
	temps.push(dir);
	return dir;
}

describe("saved workflows", () => {
	it("resolves by name only within trusted dirs", async () => {
		const agentDir = await tempDir();
		const cwd = await tempDir();
		await saveWorkflow({
			name: "audit-routes",
			script: "return 1",
			description: "demo",
			scope: "global",
			cwd,
			agentDir,
		});

		const found = await resolveSavedWorkflow({
			name: "audit-routes",
			cwd,
			projectTrusted: false,
			agentDir,
		});
		expect(found?.script).toBe("return 1");

		// Path-like names rejected
		expect(
			await resolveSavedWorkflow({
				name: "../etc/passwd",
				cwd,
				projectTrusted: true,
				agentDir,
			}),
		).toBeUndefined();
	});

	it("prefers project definitions when trusted", async () => {
		const agentDir = await tempDir();
		const cwd = await tempDir();
		await saveWorkflow({
			name: "demo",
			script: "return 'global'",
			scope: "global",
			cwd,
			agentDir,
		});
		await saveWorkflow({
			name: "demo",
			script: "return 'project'",
			scope: "project",
			cwd,
			agentDir,
		});

		const trusted = await resolveSavedWorkflow({ name: "demo", cwd, projectTrusted: true, agentDir });
		expect(trusted?.script).toContain("project");

		const untrusted = await resolveSavedWorkflow({ name: "demo", cwd, projectTrusted: false, agentDir });
		expect(untrusted?.script).toContain("global");
	});

	it("lists without duplicates", async () => {
		const agentDir = await tempDir();
		const cwd = await tempDir();
		await saveWorkflow({ name: "a", script: "1", scope: "global", cwd, agentDir });
		await saveWorkflow({ name: "a", script: "2", scope: "project", cwd, agentDir });
		const list = await listSavedWorkflows({ cwd, projectTrusted: true, agentDir });
		expect(list.filter((s) => s.name === "a")).toHaveLength(1);
	});
});
