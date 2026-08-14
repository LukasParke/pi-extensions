import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendError, type ErrorLogEntry, filterErrors, parseSince, readErrors } from "../src/log.ts";

const temps: string[] = [];

afterEach(async () => {
	await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempFile() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "error-log-"));
	temps.push(dir);
	return path.join(dir, "errors.jsonl");
}

function entry(overrides: Partial<ErrorLogEntry> = {}): ErrorLogEntry {
	return {
		ts: new Date().toISOString(),
		cwd: "/tmp",
		kind: "tool",
		tool: "bash",
		error: { message: "boom" },
		...overrides,
	};
}

describe("appendError", () => {
	it("appends entries and creates parent directories", async () => {
		const file = await tempFile();
		const nested = path.join(path.dirname(file), "nested", "deep", "errors.jsonl");
		await appendError(nested, 1024, entry());
		const entries = await readErrors(nested);
		expect(entries).toHaveLength(1);
	});

	it("rotates to .1 when the file exceeds maxBytes", async () => {
		const file = await tempFile();
		await fs.writeFile(file, "x".repeat(2048));
		await appendError(file, 1024, entry({ error: { message: "after-rotation" } }));
		const rotated = await fs.readFile(`${file}.1`, "utf8");
		expect(rotated).toBe("x".repeat(2048));
		const entries = await readErrors(file);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.error.message).toBe("after-rotation");
	});

	it("replaces an existing .1 on the next rotation", async () => {
		const file = await tempFile();
		await fs.writeFile(`${file}.1`, "old");
		await fs.writeFile(file, "y".repeat(2048));
		await appendError(file, 1024, entry());
		expect(await fs.readFile(`${file}.1`, "utf8")).toBe("y".repeat(2048));
	});

	it("never throws, even when the path is unwritable", async () => {
		// A path through a regular file fails fast with ENOTDIR on any OS.
		const blocker = await tempFile();
		await fs.writeFile(blocker, "not a directory");
		await expect(appendError(path.join(blocker, "errors.jsonl"), 1024, entry())).resolves.toBeUndefined();
	});
});

describe("readErrors", () => {
	it("skips corrupt and partial lines", async () => {
		const file = await tempFile();
		const good = entry({ error: { message: "good" } });
		await fs.writeFile(
			file,
			[`{"ts":"2026-01-01`, "not json at all", JSON.stringify(good), "", `{"ts":123}`].join("\n"),
		);
		const entries = await readErrors(file);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.error.message).toBe("good");
	});

	it("returns [] for a missing file", async () => {
		expect(await readErrors(path.join(await tempFile(), "missing.jsonl"))).toEqual([]);
	});
});

describe("parseSince", () => {
	const now = Date.parse("2026-08-14T12:00:00Z");
	it("parses durations", () => {
		expect(parseSince("2h", now)).toBe(now - 2 * 3_600_000);
		expect(parseSince("30m", now)).toBe(now - 30 * 60_000);
		expect(parseSince("1d", now)).toBe(now - 86_400_000);
	});
	it("parses ISO timestamps", () => {
		expect(parseSince("2026-08-14T10:00:00Z", now)).toBe(Date.parse("2026-08-14T10:00:00Z"));
	});
	it("returns undefined for empty or garbage input", () => {
		expect(parseSince(undefined, now)).toBeUndefined();
		expect(parseSince("", now)).toBeUndefined();
		expect(parseSince("garbage", now)).toBeUndefined();
	});
});

describe("filterErrors", () => {
	const base = Date.parse("2026-08-14T12:00:00Z");
	const entries = [
		entry({ ts: new Date(base - 3 * 3_600_000).toISOString(), tool: "bash", error: { message: "old" } }),
		entry({ ts: new Date(base - 30 * 60_000).toISOString(), tool: "read", error: { message: "mid" } }),
		entry({ ts: new Date(base - 60_000).toISOString(), tool: "bash", error: { message: "new" } }),
	];

	it("returns newest first with a default limit", () => {
		const out = filterErrors(entries, { now: base });
		expect(out.map((e) => e.error.message)).toEqual(["new", "mid", "old"]);
	});

	it("filters by tool", () => {
		const out = filterErrors(entries, { tool: "bash", now: base });
		expect(out.map((e) => e.error.message)).toEqual(["new", "old"]);
	});

	it("filters by since duration", () => {
		const out = filterErrors(entries, { since: "1h", now: base });
		expect(out.map((e) => e.error.message)).toEqual(["new", "mid"]);
	});

	it("respects limit", () => {
		const out = filterErrors(entries, { limit: 1, now: base });
		expect(out).toHaveLength(1);
		expect(out[0]!.error.message).toBe("new");
	});
});
