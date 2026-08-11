#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const packagesDir = join(root, "packages");
const packages = readdirSync(packagesDir, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.filter((entry) => existsSync(join(packagesDir, entry.name, "package.json")))
	.map((entry) => {
		const dir = join(packagesDir, entry.name);
		const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		return {
			dir,
			slug: entry.name,
			name: manifest.name,
			version: manifest.version,
			private: manifest.private === true,
			dependencies: Object.keys(manifest.dependencies ?? {}),
		};
	})
	.filter((pkg) => !pkg.private);

const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
const ordered = [];
const visiting = new Set();
function visit(pkg) {
	if (ordered.includes(pkg)) return;
	if (visiting.has(pkg.name)) throw new Error(`Workspace dependency cycle at ${pkg.name}`);
	visiting.add(pkg.name);
	for (const dependency of pkg.dependencies) {
		const workspace = byName.get(dependency);
		if (workspace) visit(workspace);
	}
	visiting.delete(pkg.name);
	ordered.push(pkg);
}
for (const pkg of packages) visit(pkg);

const [command = "plan", requested = process.env.RELEASE_PACKAGE] = process.argv.slice(2);

function publishedVersion(name) {
	try {
		return execFileSync("npm", ["view", name, "version", "--json"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		})
			.trim()
			.replace(/^"|"$/g, "");
	} catch {
		return undefined;
	}
}

function select(value) {
	if (!value) throw new Error("Pass a package slug/name, or set RELEASE_PACKAGE");
	const pkg = packages.find((candidate) => candidate.slug === value || candidate.name === value);
	if (!pkg)
		throw new Error(
			`Unknown package ${value}. Choices: ${packages.map((candidate) => candidate.slug).join(", ")}`,
		);
	return pkg;
}

function assertPublishedWorkspaceDependencies(pkg) {
	for (const dependency of pkg.dependencies) {
		const workspace = byName.get(dependency);
		if (!workspace) continue;
		const published = publishedVersion(workspace.name);
		if (published !== workspace.version) {
			throw new Error(
				`${pkg.name} depends on ${workspace.name}@${workspace.version}, but npm has ${published ?? "no published version"}. Publish ${workspace.slug} first.`,
			);
		}
	}
}

if (command === "plan") {
	for (const pkg of ordered) {
		const published = publishedVersion(pkg.name);
		const status =
			published === pkg.version
				? "published"
				: published
					? `publish ${published} → ${pkg.version}`
					: `first publish ${pkg.version}`;
		console.log(`${pkg.slug.padEnd(24)} ${pkg.name}@${pkg.version}  ${status}`);
	}
	process.exit(0);
}

if (command === "publish") {
	const pkg = select(requested);
	assertPublishedWorkspaceDependencies(pkg);
	console.log(`Publishing ${pkg.name}@${pkg.version} from packages/${basename(pkg.dir)}`);
	const env = { ...process.env };
	delete env.NODE_AUTH_TOKEN;
	delete env.NPM_TOKEN;
	if (pkg.name === "@parke.dev/pi-integrations") {
		const stage = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
		try {
			execFileSync("node", ["scripts/pack-package.mjs", pkg.name, stage], {
				cwd: root,
				stdio: "inherit",
				env,
			});
			const tarball = join(stage, `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`);
			execFileSync("npm", ["publish", tarball, "--access", "public", "--ignore-scripts"], {
				cwd: root,
				stdio: "inherit",
				env,
			});
		} finally {
			execFileSync("rm", ["-rf", stage]);
		}
	} else {
		execFileSync("npm", ["publish", "--workspace", pkg.name, "--access", "public", "--ignore-scripts"], {
			cwd: root,
			stdio: "inherit",
			env,
		});
	}
	process.exit(0);
}

throw new Error(`Unknown command ${command}; expected plan or publish`);
