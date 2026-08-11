import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "../src/config.ts";
import {
	createUltracodeState,
	disableUltracodeSession,
	enableUltracodeSession,
	isUltracodeActive,
	registerUltracode,
	ultracodePolicyText,
} from "../src/ultracode.ts";

function fakePi() {
	let thinking: "medium" | "xhigh" | "high" = "medium";
	const handlers = new Map<string, Function[]>();
	const pi = {
		getThinkingLevel: () => thinking,
		setThinkingLevel: (level: typeof thinking) => {
			thinking = level;
		},
		on: (event: string, handler: Function) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand: vi.fn(),
		_handlers: handlers,
		_thinking: () => thinking,
	};
	return pi as unknown as ExtensionAPI & { _handlers: Map<string, Function[]>; _thinking: () => string };
}

describe("ultracode", () => {
	it("builds policy with size guidelines", () => {
		const text = ultracodePolicyText(defaultConfig, "medium");
		expect(text).toMatch(/Ultracode is active/);
		expect(text).toMatch(/under 15/);
	});

	it("arms one-shot mode only for interactive input and restores thinking", async () => {
		const pi = fakePi();
		const state = createUltracodeState("medium");
		registerUltracode(pi, state, defaultConfig);
		const input = pi._handlers.get("input")![0]!;
		const transformed = await input({ source: "interactive", text: "ultracode: audit auth" });
		expect(transformed).toEqual({ action: "transform", text: "audit auth" });
		expect(state.oneShot).toBe(true);
		expect(pi._thinking()).toBe("xhigh");
		expect(await input({ source: "rpc", text: "ultracode: ignored" })).toEqual({ action: "continue" });
		await pi._handlers.get("agent_end")![0]!({});
		expect(state.oneShot).toBe(false);
		expect(pi._thinking()).toBe("medium");
	});

	it("sets and restores xhigh on session toggle", () => {
		const pi = fakePi();
		const state = createUltracodeState("medium");
		enableUltracodeSession(pi, state);
		expect(isUltracodeActive(state)).toBe(true);
		expect(pi._thinking()).toBe("xhigh");
		disableUltracodeSession(pi, state);
		expect(isUltracodeActive(state)).toBe(false);
		expect(pi._thinking()).toBe("medium");
	});
});
