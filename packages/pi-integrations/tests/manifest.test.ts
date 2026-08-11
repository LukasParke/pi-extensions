import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
	dependencies: Record<string, string>;
	pi: { extensions: string[]; skills: string[] };
};

describe("integration bundle", () => {
	it("loads all five independently versioned integration packages", () => {
		expect(Object.keys(manifest.dependencies).sort()).toEqual([
			"@parke.dev/pi-git",
			"@parke.dev/pi-github",
			"@parke.dev/pi-linear",
			"@parke.dev/pi-notion",
			"@parke.dev/pi-slack",
		]);
		expect(manifest.pi.extensions).toHaveLength(5);
		expect(manifest.pi.skills).toHaveLength(5);
		for (const dependency of Object.keys(manifest.dependencies)) {
			expect(manifest.pi.extensions.some((entry) => entry.includes(dependency))).toBe(true);
			expect(manifest.pi.skills.some((entry) => entry.includes(dependency))).toBe(true);
		}
	});
});
