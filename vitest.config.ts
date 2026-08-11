import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["packages/*/tests/**/*.test.ts"],
		exclude: ["packages/pi-memory/tests/perf.test.ts", "**/node_modules/**"],
		globals: true,
	},
});
