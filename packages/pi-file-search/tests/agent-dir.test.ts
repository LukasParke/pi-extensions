import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";

it.skipIf(process.platform === "win32")(
	"resolves fallback binaries from the native agent directory",
	async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-search-agent-dir-"));
		const agentDir = path.join(dir, "agent");
		await fs.mkdir(path.join(agentDir, "bin"), { recursive: true });
		await fs.writeFile(
			path.join(agentDir, "bin", "fd"),
			'#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fd fixture"; else echo "fixture.txt"; fi\n',
			{ mode: 0o755 },
		);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PATH", path.join(dir, "empty-path"));
		try {
			vi.resetModules();
			const { default: register } = await import("../extensions/file-search.ts");
			const tools = new Map<string, ToolDefinition>();
			register({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as never);
			const result = await tools
				.get("fd")!
				.execute("call", { pattern: "fixture" }, undefined, undefined, { cwd: dir } as never);
			expect(result.structuredContent).toMatchObject({ paths: ["fixture.txt"], matches: 1 });
		} finally {
			vi.unstubAllEnvs();
			await fs.rm(dir, { recursive: true, force: true });
		}
	},
);
