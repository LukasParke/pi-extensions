import { describe, expect, it, vi } from "vitest";
import { generateNameFromContext, generateNameIfOmitted, type NameContext } from "../src/name-from-task.ts";

const ctx = (
	registry?: NameContext["modelRegistry"],
	model: NameContext["model"] = { id: "x" } as NameContext["model"],
) => ({ model: registry ? model : undefined, modelRegistry: registry }) as NameContext;

describe("generateNameFromContext", () => {
	it("returns undefined without a model or auth", async () => {
		await expect(generateNameFromContext("task", ctx())).resolves.toBeUndefined();
		await expect(
			generateNameFromContext(
				"task",
				ctx({ getApiKeyAndHeaders: async () => ({ ok: false, error: "none" }) }),
			),
		).resolves.toBeUndefined();
	});

	it("requests a short no-tools completion and returns the text", async () => {
		const complete = vi.fn(async (_model, context, options) => {
			expect(context.systemPrompt).toContain("SUBJECT");
			expect(context.messages[0]?.content[0]?.text).toBe("Add clickable transcript file paths");
			expect(options.maxTokens).toBe(24);
			expect(options.reasoning).toBe("minimal");
			return { content: [{ type: "text", text: "clickable-file-paths" }] };
		});
		await expect(
			generateNameFromContext(
				"Add clickable transcript file paths",
				ctx({ getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) }),
				{ complete },
			),
		).resolves.toBe("clickable-file-paths");
		expect(complete).toHaveBeenCalledOnce();
	});

	it("is used for omitted names and skipped for explicit ones", () => {
		const named = ctx({ getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) });
		expect(generateNameIfOmitted("fix-thing", named)).toBeUndefined();
		expect(generateNameIfOmitted(undefined, named)).toEqual(expect.any(Function));
	});

	it("falls back when the model call fails or aborts", async () => {
		const named = ctx({ getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) });
		await expect(
			generateNameFromContext("task", named, {
				complete: async () => {
					throw new Error("network");
				},
			}),
		).resolves.toBeUndefined();
		await expect(
			generateNameFromContext("task", named, {
				complete: async () => ({ stopReason: "aborted", content: [] }),
			}),
		).resolves.toBeUndefined();
	});
});
