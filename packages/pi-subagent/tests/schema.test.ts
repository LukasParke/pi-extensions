import { describe, it, expect } from "vitest";
import { Value } from "typebox/value";
import { assertObjectToolSchema, profileSelectionError, SubagentParamsSchema } from "../src/schema.js";
import { validateSubagentRequest } from "../src/policy.js";

const parent = {
  cwd: "/tmp",
  availableTools: ["read", "grep", "find", "ls", "bash"],
  activeTools: ["read", "grep", "find", "ls", "bash"],
};

describe("SubagentParamsSchema", () => {
  it("exposes JSON Schema type object for providers", () => {
    expect(SubagentParamsSchema.type).toBe("object");
    expect(() => assertObjectToolSchema(SubagentParamsSchema)).not.toThrow();
    // Must not be a bare anyOf/union at the top level.
    expect("=" in SubagentParamsSchema ? null : (SubagentParamsSchema as any).anyOf).toBeUndefined();
  });

  it("requires profile on single tasks with actionable guidance", () => {
    const params = { task: "do thing" };
    expect(Value.Check(SubagentParamsSchema, params)).toBe(false);
    expect(profileSelectionError(params)).toContain('missing required field "profile"');
    expect(profileSelectionError(params)).toContain('"explore"');
    expect(profileSelectionError(params)).toContain('"review"');
    expect(profileSelectionError(params)).toContain('"general"');
    expect(Value.Check(SubagentParamsSchema, { ...params, profile: "general" })).toBe(true);
  });

  it("requires profile on every parallel task with its index", () => {
    const params = {
      tasks: [{ task: "a", profile: "explore" }, { task: "b" }],
      async: true,
    };
    expect(Value.Check(SubagentParamsSchema, params)).toBe(false);
    expect(profileSelectionError(params)).toContain("Task 2");
    expect(Value.Check(SubagentParamsSchema, {
      ...params,
      tasks: params.tasks.map((task) => ({ profile: "explore", ...task })),
    })).toBe(true);
  });

  it("allows named agents through schema for persona profile resolution", () => {
    expect(Value.Check(SubagentParamsSchema, { task: "review", agent: "reviewer" })).toBe(true);
    expect(Value.Check(SubagentParamsSchema, { tasks: [{ task: "review", agent: "reviewer" }] })).toBe(true);
  });

  it("accepts management actions", () => {
    expect(Value.Check(SubagentParamsSchema, { action: "wait", id: "abc" })).toBe(true);
    expect(Value.Check(SubagentParamsSchema, { action: "cancel" })).toBe(true);
    expect(Value.Check(SubagentParamsSchema, { action: "status", id: "x" })).toBe(true);
  });

  it("rejects empty task", () => {
    expect(Value.Check(SubagentParamsSchema, { task: "" })).toBe(false);
  });

  it("rejects unknown fields on strict objects", () => {
    expect(Value.Check(SubagentParamsSchema, { task: "x", nope: true })).toBe(false);
  });

  it("rejects action combined with task payload in policy validation", () => {
    // Provider schemas must stay type:object, so mode exclusivity is policy-side.
    expect(Value.Check(SubagentParamsSchema, { action: "status", task: "nope", profile: "explore" })).toBe(true);
    const validated = validateSubagentRequest({ action: "status", task: "nope", profile: "explore" } as any, parent);
    expect(validated.ok).toBe(false);
    if (!validated.ok) expect(validated.error).toMatch(/exactly one/i);
  });

  it("requires one of task, tasks, or action", () => {
    const validated = validateSubagentRequest({} as any, parent);
    expect(validated.ok).toBe(false);
  });
});
