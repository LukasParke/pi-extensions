import { describe, expect, it } from "vitest";
import { coerceArgs, prepareWorkflowArguments } from "../src/args.ts";

describe("prepareWorkflowArguments", () => {
	it("parses legacy JSON string args", () => {
		const out = prepareWorkflowArguments({
			script: "return 1",
			args: '{"path":"src"}',
		});
		expect(out.args).toEqual({ path: "src" });
	});

	it("passes structured args through", () => {
		const out = prepareWorkflowArguments({
			script: "return 1",
			args: { path: "src", n: 3 },
		});
		expect(out.args).toEqual({ path: "src", n: 3 });
	});

	it("leaves invalid JSON strings for execute to reject", () => {
		const out = prepareWorkflowArguments({ args: "{nope" });
		expect(out.args).toBe("{nope");
		const coerced = coerceArgs(out.args);
		expect(coerced.ok).toBe(false);
	});
});
