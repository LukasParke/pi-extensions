import type { ExtensionAPI, MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import { setCapabilities } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import register from "../extensions/file-links.ts";

describe("file-links extension", () => {
	it("resolves paths against each active session cwd", () => {
		let transformer: MarkdownTransformer | undefined;
		let sessionStart: ((event: unknown, ctx: { cwd: string }) => void) | undefined;
		const pi = {
			registerMarkdownTransformer(value: MarkdownTransformer) {
				transformer = value;
			},
			on(name: string, handler: typeof sessionStart) {
				if (name === "session_start") sessionStart = handler;
			},
		} as unknown as ExtensionAPI;

		setCapabilities({ hyperlinks: true, images: null, trueColor: true });
		register(pi);
		expect(transformer).toBeDefined();

		sessionStart?.({}, { cwd: "/repo/one" });
		expect(
			transformer?.("./src/a.ts", { messageType: "assistant", isStreaming: false, availableWidth: 80 }),
		).toContain("file:///repo/one/src/a.ts");

		sessionStart?.({}, { cwd: "/repo/two" });
		expect(
			transformer?.("./src/a.ts", { messageType: "assistant", isStreaming: true, availableWidth: 80 }),
		).toContain("file:///repo/two/src/a.ts");
		expect(
			transformer?.("./src/a.ts", {
				messageType: "assistant-thinking",
				isStreaming: false,
				availableWidth: 80,
			}),
		).toBe("./src/a.ts");
	});

	it("registers no model-callable tool", () => {
		const registerTool = vi.fn();
		register({ registerTool, registerMarkdownTransformer: vi.fn(), on: vi.fn() } as unknown as ExtensionAPI);
		expect(registerTool).not.toHaveBeenCalled();
	});
});
