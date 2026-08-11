#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const stage = mkdtempSync(join(tmpdir(), "pi-integrations-pack-"));
const providers = ["pi-git", "pi-github", "pi-slack", "pi-linear", "pi-notion"];
const run = (command, args, cwd = root) =>
	execFileSync(command, args, {
		cwd,
		stdio: "ignore",
		env: { ...process.env, npm_config_loglevel: "error" },
	});

try {
	run("node", ["scripts/pack-package.mjs", "@parke.dev/pi-integrations", stage]);
	const manifest = JSON.parse(readFileSync(join(root, "packages/pi-integrations/package.json"), "utf8"));
	const tarball = join(stage, `parke.dev-pi-integrations-${manifest.version}.tgz`);
	if (!existsSync(tarball)) throw new Error("release packer did not create the bundle tarball");

	const install = join(stage, "install");
	mkdirSync(install);
	run("npm", ["init", "-y"], install);
	run("npm", ["install", "--ignore-scripts", tarball], install);

	for (const slug of providers) {
		const nested = join(install, "node_modules/@parke.dev/pi-integrations/node_modules/@parke.dev", slug);
		if (!existsSync(join(nested, "extensions/index.ts")))
			throw new Error(`${slug} extension was not bundled`);
		const skill = join(nested, "skills", slug === "pi-git" ? "git-tools" : slug.slice(3), "SKILL.md");
		if (!existsSync(skill)) throw new Error(`${slug} skill was not bundled`);
	}

	const auth = join(
		install,
		"node_modules/@parke.dev/pi-integrations/node_modules/@parke.dev/pi-integration-auth/src/index.ts",
	);
	const http = join(
		install,
		"node_modules/@parke.dev/pi-integrations/node_modules/@parke.dev/pi-integration-http/src/index.ts",
	);
	if (!existsSync(auth) || !existsSync(http)) throw new Error("provider runtime libraries were not bundled");

	console.log("Release bundle contains all extensions, skills, and runtime libraries.");
} finally {
	rmSync(stage, { recursive: true, force: true });
}
