#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = new URL("..", import.meta.url).pathname;
const requested = process.argv[2];
const destination = resolve(process.argv[3] ?? process.cwd());
if (!requested) throw new Error("Usage: pack-package.mjs <package name or slug> [destination]");

const packageDirs = execFileSync("find", ["packages", "-mindepth", "1", "-maxdepth", "1", "-type", "d"], {
	cwd: root,
	encoding: "utf8",
})
	.trim()
	.split("\n")
	.filter(Boolean);
const selected = packageDirs
	.filter((directory) => existsSync(join(root, directory, "package.json")))
	.map((directory) => ({
		directory,
		manifest: JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8")),
	}))
	.find(({ directory, manifest }) => manifest.name === requested || basename(directory) === requested);
if (!selected) throw new Error(`Unknown package ${requested}`);

const run = (command, args, cwd = root, stdio = "inherit") =>
	execFileSync(command, args, { cwd, stdio, env: { ...process.env, npm_config_loglevel: "error" } });

if (selected.manifest.name !== "@parke.dev/pi-integrations") {
	run("npm", ["pack", "--workspace", selected.manifest.name, "--pack-destination", destination]);
	process.exit(0);
}

const stage = mkdtempSync(join(tmpdir(), "pi-integrations-release-"));
const dependencySlugs = [
	"pi-ext-config",
	"pi-integration-auth",
	"pi-integration-http",
	"pi-git",
	"pi-github",
	"pi-slack",
	"pi-linear",
	"pi-notion",
];
const tarball = (slug) => {
	const manifest = JSON.parse(readFileSync(join(root, "packages", slug, "package.json"), "utf8"));
	return join(stage, `${manifest.name.replace("@", "").replace("/", "-")}-${manifest.version}.tgz`);
};
const localizeDependencies = (directory) => {
	const file = join(directory, "package.json");
	const manifest = JSON.parse(readFileSync(file, "utf8"));
	for (const name of Object.keys(manifest.dependencies ?? {})) {
		manifest.dependencies[name] = `file:${tarball(name.split("/")[1])}`;
	}
	writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
};

try {
	for (const slug of dependencySlugs) {
		run(
			"npm",
			["pack", "--silent", "--pack-destination", stage, "--workspace", `@parke.dev/${slug}`],
			root,
			"ignore",
		);
	}
	for (const slug of ["pi-integration-auth", "pi-github", "pi-slack", "pi-linear", "pi-notion"]) {
		const repack = join(stage, "repack");
		rmSync(repack, { recursive: true, force: true });
		mkdirSync(repack);
		run("tar", ["-xzf", tarball(slug)], repack, "ignore");
		localizeDependencies(join(repack, "package"));
		run("tar", ["-czf", tarball(slug), "package"], repack, "ignore");
	}

	const bundle = join(stage, "bundle");
	mkdirSync(bundle);
	for (const file of ["package.json", "README.md", "LICENSE"]) {
		cpSync(join(root, selected.directory, file), join(bundle, file));
	}
	localizeDependencies(bundle);
	run("npm", ["install", "--ignore-scripts"], bundle, "ignore");
	run("npm", ["pack", "--pack-destination", destination], bundle);
} finally {
	rmSync(stage, { recursive: true, force: true });
}
