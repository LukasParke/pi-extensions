import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import askUser from "../extensions/ask-user.ts";

interface AskUserTool {
	exposure?: string;
	namespace?: { name: string; description?: string };
	annotations?: Record<string, boolean>;
	execute(
		id: string,
		params: {
			question: string;
			options: Array<{ label: string; description?: string }>;
		},
		signal: AbortSignal,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<{ details: { answer: string | null; outcome: string } }>;
}

function harness(selectResult: string | undefined, inputResult?: string) {
	let tool: AskUserTool | undefined;
	const emit = vi.fn();
	const select = vi.fn(async () => selectResult);
	const input = vi.fn(async () => inputResult);
	const pi = {
		events: { emit },
		registerTool: (definition: AskUserTool) => {
			tool = definition;
		},
	} as unknown as ExtensionAPI;
	askUser(pi);
	return {
		emit,
		select,
		input,
		tool: tool!,
		ctx: { hasUI: true, ui: { select, input } } as unknown as ExtensionContext,
	};
}

const params = {
	question: "Which option?",
	options: [{ label: "A", description: "first" }, { label: "B" }],
};

const blocked = [
	["herdr:blocked", { active: true, label: params.question }],
	["herdr:blocked", { active: false }],
];

describe("ask_user native contracts", () => {
	it("is model-only with a namespace and read-only annotations", () => {
		const h = harness(undefined);
		// Native user-dialog contract: callable by the model, never from codemode.
		expect(h.tool.exposure).toBe("model-only");
		expect(h.tool.namespace?.name).toBe("ask-user");
		expect(h.tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
	});
});

describe("ask_user dialogs", () => {
	it("signals around option selection and passes the abort signal", async () => {
		const h = harness("A — first");
		const signal = new AbortController().signal;
		const result = await h.tool.execute("id", params, signal, undefined, h.ctx);

		expect(result.details).toMatchObject({ answer: "A", outcome: "selected" });
		expect(h.select).toHaveBeenCalledWith(params.question, ["A — first", "B", "Let me type my own answer…"], {
			signal,
		});
		expect(h.emit.mock.calls).toEqual(blocked);
	});

	it("signals separately around the free-text follow-up", async () => {
		const h = harness("Let me type my own answer…", "custom answer");
		const signal = new AbortController().signal;
		const result = await h.tool.execute("id", params, signal, undefined, h.ctx);

		expect(result.details).toMatchObject({ answer: "custom answer", outcome: "custom" });
		expect(h.input).toHaveBeenCalledWith(params.question, "Type your answer…", { signal });
		expect(h.emit.mock.calls).toEqual([...blocked, ...blocked]);
	});

	it("does not open dialogs or emit blocked state without a UI", async () => {
		const h = harness("A — first");
		const ctx = { ...h.ctx, hasUI: false };
		const result = await h.tool.execute("id", params, new AbortController().signal, undefined, ctx);
		expect(result.details).toMatchObject({ answer: null, outcome: "no-ui" });
		expect(h.select).not.toHaveBeenCalled();
		expect(h.emit).not.toHaveBeenCalled();
	});

	it("does not open a pre-cancelled question", async () => {
		const h = harness("A — first");
		const controller = new AbortController();
		controller.abort();
		const result = await h.tool.execute("id", params, controller.signal, undefined, h.ctx);
		expect(result.details).toMatchObject({ answer: null, outcome: "cancelled" });
		expect(h.select).not.toHaveBeenCalled();
		expect(h.emit).not.toHaveBeenCalled();
	});

	it.each(["selection", "input"])("does not treat %s cancellation as an answer", async (stage) => {
		const h = harness("Let me type my own answer…", "late answer");
		const controller = new AbortController();
		if (stage === "selection")
			h.select.mockImplementation(async () => {
				controller.abort();
				return "A — first";
			});
		else
			h.input.mockImplementation(async () => {
				controller.abort();
				return "late answer";
			});
		const result = await h.tool.execute("id", params, controller.signal, undefined, h.ctx);
		expect(result.details).toMatchObject({ answer: null, outcome: "cancelled" });
		expect(h.emit.mock.calls).toEqual(stage === "selection" ? blocked : [...blocked, ...blocked]);
	});

	it("releases blocked state when a native dialog throws", async () => {
		const h = harness(undefined);
		h.select.mockRejectedValue(new Error("native dialog failure"));
		await expect(
			h.tool.execute("id", params, new AbortController().signal, undefined, h.ctx),
		).rejects.toThrow("native dialog failure");
		expect(h.emit.mock.calls).toEqual(blocked);
	});

	it("releases the signal when the option dialog is dismissed", async () => {
		const h = harness(undefined);
		const result = await h.tool.execute("id", params, new AbortController().signal, undefined, h.ctx);

		expect(result.details).toMatchObject({ answer: null, outcome: "dismissed" });
		expect(h.emit.mock.calls).toEqual(blocked);
	});
});
