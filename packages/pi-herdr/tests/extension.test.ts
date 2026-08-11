import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import herdrExtension from "../extensions/herdr.ts";

interface RegisteredTool {
	name: string;
	parameters: {
		required?: string[];
		properties: Record<string, { description?: string }>;
	};
}

describe("herdr_task schema", () => {
	it("requires a subject-based workspace name", () => {
		const tools = new Map<string, RegisteredTool>();
		herdrExtension({
			on: () => {},
			registerCommand: () => {},
			registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		} as unknown as ExtensionAPI);

		const schema = tools.get("herdr_task")?.parameters;
		expect(schema?.required).toContain("name");
		expect(schema?.properties.name?.description).toContain("SUBJECT");
		expect(schema?.properties.name?.description).toContain("workspace-naming");
	});
});
