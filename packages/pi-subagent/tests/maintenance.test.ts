import { describe, expect, it } from "vitest";
import { abortAsPromise } from "../src/maintenance.js";

describe("abortAsPromise", () => {
  it("resolves for pre-aborted and later-aborted signals; undefined without a signal", async () => {
    expect(abortAsPromise(undefined)).toBeUndefined();
    const pre = new AbortController();
    pre.abort();
    await expect(abortAsPromise(pre.signal)).resolves.toBe("aborted");
    const later = new AbortController();
    const promise = abortAsPromise(later.signal)!;
    later.abort();
    await expect(promise).resolves.toBe("aborted");
  });
});
