import { describe, expect, it, vi } from "vitest";
import { describeHerdrError, parseHerdrError, runHerdr, runHerdrText } from "../src/cli.ts";

describe("parseHerdrError", () => {
	it("recovers the envelope from mixed CLI output", () => {
		const raw = 'some noise\n{"error":{"code":"agent_pane_busy","message":"pane has a process"}}\n';
		expect(parseHerdrError(raw)).toEqual({ code: "agent_pane_busy", message: "pane has a process" });
	});

	it("finds the envelope when progress JSON precedes it", () => {
		const raw = '{"progress":50}\n{"error":{"code":"wait_timeout","message":"gave up"}}\n';
		expect(parseHerdrError(raw)).toEqual({ code: "wait_timeout", message: "gave up" });
	});

	it("copes with a pretty-printed multi-line envelope after progress JSON", () => {
		const raw = '{"progress":50}\nnoise\n{\n  "error": {\n    "code": "x",\n    "message": "boom"\n  }\n}\n';
		expect(parseHerdrError(raw)).toEqual({ code: "x", message: "boom" });
	});

	it("returns undefined when there is no JSON at all", () => {
		expect(parseHerdrError("Command failed: herdr")).toBeUndefined();
	});

	it("returns undefined for JSON without an error envelope", () => {
		expect(parseHerdrError('{"result":{"ok":true}}')).toBeUndefined();
		expect(parseHerdrError("{not json}")).toBeUndefined();
	});
});

describe("runHerdr", () => {
	it("logs one JSONL record for successful and failed invocations", async () => {
		const entries: string[] = [];
		const appendLog = vi.fn((_path: string, entry: string) => entries.push(entry));
		const exec = vi.fn().mockResolvedValueOnce({ stdout: '{"result":{"ok":true}}' }).mockRejectedValueOnce({
			stdout: '{"error":{"code":"agent_not_found","message":"gone"}}',
			stderr: "",
		});
		await expect(runHerdr(["status"], { exec, appendLog, logPath: "/tmp/herdr.log" })).resolves.toEqual({
			ok: true,
		});
		await expect(
			runHerdr(["agent", "get", "gone"], { exec, appendLog, logPath: "/tmp/herdr.log" }),
		).rejects.toThrow("agent_not_found");
		expect(appendLog).toHaveBeenCalledTimes(2);
		expect(entries.map((entry) => JSON.parse(entry))).toMatchObject([
			{ args: ["status"], outcome: "ok", ms: expect.any(Number), ts: expect.any(String) },
			{
				args: ["agent", "get", "gone"],
				outcome: "error",
				error: expect.stringContaining("agent_not_found"),
				ms: expect.any(Number),
				ts: expect.any(String),
			},
		]);
	});

	it("redacts task text while preserving command metadata", async () => {
		const entries: string[] = [];
		const appendLog = (_path: string, entry: string) => entries.push(entry);
		const exec = vi
			.fn()
			.mockResolvedValueOnce({ stdout: '{"result":{}}' })
			.mockRejectedValueOnce(new Error("failed to send another secret"));
		await runHerdr(["agent", "start", "fix", "--kind", "pi", "--pane", "pane-1", "--", "secret task"], {
			exec,
			appendLog,
			logPath: "/tmp/herdr.log",
		});
		await expect(
			runHerdr(["agent", "prompt", "fix", "another secret", "--wait", "--until", "working"], {
				exec,
				appendLog,
				logPath: "/tmp/herdr.log",
			}),
		).rejects.toThrow("another secret");
		expect(entries.map((entry) => JSON.parse(entry).args)).toEqual([
			["agent", "start", "fix", "--kind", "pi", "--pane", "pane-1", "--", "[redacted]"],
			["agent", "prompt", "fix", "[redacted]", "--wait", "--until", "working"],
		]);
		expect(entries.join("\n")).not.toContain("secret");
	});

	it("logs successful and failed raw-text invocations", async () => {
		const entries: string[] = [];
		const appendLog = vi.fn((_path: string, entry: string) => entries.push(entry));
		const exec = vi
			.fn()
			.mockResolvedValueOnce({ stdout: "terminal output" })
			.mockRejectedValueOnce(new Error("read failed"));
		await expect(
			runHerdrText(["agent", "read", "fix"], { exec, appendLog, logPath: "/tmp/herdr.log" }),
		).resolves.toBe("terminal output");
		await expect(
			runHerdrText(["agent", "read", "gone"], { exec, appendLog, logPath: "/tmp/herdr.log" }),
		).rejects.toThrow("read failed");
		expect(entries.map((entry) => JSON.parse(entry))).toMatchObject([
			{ args: ["agent", "read", "fix"], outcome: "ok" },
			{ args: ["agent", "read", "gone"], outcome: "error", error: "read failed" },
		]);
	});
});

describe("describeHerdrError", () => {
	it("names the command and includes the structured code", () => {
		expect(describeHerdrError(["agent", "start", "x"], { code: "agent_pane_busy", message: "busy" })).toBe(
			"herdr agent start: agent_pane_busy: busy",
		);
	});

	it("copes with single-word commands and codeless errors", () => {
		expect(describeHerdrError(["status"], { message: "down" })).toBe("herdr status: down");
	});
});
