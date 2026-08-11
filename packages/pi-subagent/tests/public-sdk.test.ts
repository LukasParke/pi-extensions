import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ChildRunner,
  ProcessLockManager,
  Semaphore,
  WorktreeManager,
  addUsage,
  buildUsageLedger,
  emptyUsage,
  formatLedger,
  hasBilledUsage,
  normalizeUsage,
  runSubagent,
  runTasks,
  toPiUsage,
} from "../src/index.js";
import type {
  RunState,
  TaskResult,
  TaskSpec,
  UsageStats,
} from "../src/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

describe("public SDK export contract", () => {
  it("exposes the stable runtime surface", () => {
    expect(typeof runTasks).toBe("function");
    expect(typeof runSubagent).toBe("function");
    expect(typeof ChildRunner).toBe("function");
    expect(typeof ProcessLockManager).toBe("function");
    expect(typeof WorktreeManager).toBe("function");
    expect(typeof Semaphore).toBe("function");
    expect(typeof addUsage).toBe("function");
    expect(typeof normalizeUsage).toBe("function");
    expect(typeof hasBilledUsage).toBe("function");
    expect(typeof toPiUsage).toBe("function");
    expect(typeof buildUsageLedger).toBe("function");
    expect(typeof formatLedger).toBe("function");
    expect(typeof emptyUsage).toBe("function");
  });

  it("usage helpers work through the public entry", () => {
    const a: UsageStats = emptyUsage();
    a.input = 10;
    a.output = 5;
    a.cost = 0.01;
    const b = normalizeUsage({ input: 3, output: 2, cost: 0.02 });
    const sum = addUsage(a, b);
    expect(sum.input).toBe(13);
    expect(sum.output).toBe(7);
    expect(sum.cost).toBeCloseTo(0.03);
    expect(hasBilledUsage(sum)).toBe(true);
    expect(toPiUsage(sum).input).toBe(13);
  });

  it("package exports map points at the public entry", async () => {
    const pkgPath = path.join(root, "package.json");
    const pkg = require(pkgPath) as {
      name?: string;
      exports?: Record<string, string>;
      pi?: { extensions?: string[] };
    };
    expect(pkg.name).toBe("@parke.dev/pi-subagent");
    expect(pkg.exports?.["."]).toBe("./src/index.ts");
    expect(pkg.exports?.["./sdk"]).toBe("./src/index.ts");
    expect(pkg.exports?.["./package.json"]).toBe("./package.json");
    // Extension entry is preserved for pi package install.
    expect(pkg.pi?.extensions).toEqual(["./extensions/subagent.ts"]);

    // Bare package root import resolves via the exports map when installed.
    // Here we load the same target the map advertises.
    const entryUrl = pathToFileURL(path.join(root, "src/index.ts")).href;
    const mod = await import(entryUrl);
    expect(typeof mod.runTasks).toBe("function");
    expect(typeof mod.ChildRunner).toBe("function");
    expect(typeof mod.WorktreeManager).toBe("function");
    expect(typeof mod.Semaphore).toBe("function");
    expect(typeof mod.addUsage).toBe("function");
    expect(typeof mod.normalizeUsage).toBe("function");
  });

  it("public types are usable at compile time", () => {
    const spec: TaskSpec = {
      task: "ping",
      profile: "explore",
      timeoutMs: 1000,
    };
    const state: RunState = "queued";
    const result: TaskResult = {
      label: "ping",
      task: spec.task,
      state,
      exitCode: null,
      messages: [],
      stderr: "",
      usage: emptyUsage(),
      protocol: {
        headerSeen: false,
        assistantEndSeen: false,
        agentEndSeen: false,
        agentSettledSeen: false,
        validEvents: 0,
        parseErrors: 0,
      },
    };
    expect(result.state).toBe("queued");
  });
});
