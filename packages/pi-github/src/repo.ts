import { execFile } from "node:child_process";

export interface RepoRef {
	owner: string;
	name: string;
	slug: string;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function parseRepo(input: string): RepoRef | null {
	const cleaned = input.trim().replace(/\.git$/, "");
	const parts = cleaned.split("/");
	if (parts.length !== 2) return null;
	const [owner, name] = parts;
	if (owner === undefined || name === undefined) return null;
	if (!OWNER.test(owner) || !NAME.test(name)) return null;
	if (name === "." || name === "..") return null;
	return { owner, name, slug: `${owner}/${name}` };
}

export function repoFromRemoteUrl(url: string): RepoRef | null {
	const cleaned = url.trim().replace(/\.git$/, "");
	const patterns = [
		/^https?:\/\/[^/]{1,255}\/([^/]{1,100}\/[^/]{1,100})$/,
		/^[^@]{1,100}@[^:]{1,255}:([^/]{1,100}\/[^/]{1,100})$/,
		/^ssh:\/\/[^/]{1,255}\/([^/]{1,100}\/[^/]{1,100})$/,
	];
	for (const p of patterns) {
		const m = p.exec(cleaned);
		if (m?.[1] !== undefined) return parseRepo(m[1]);
	}
	return null;
}

export interface RepoResolveOptions {
	cwd?: string;
	gitRemote?: (cwd: string) => Promise<string | null>;
}

export async function originUrl(cwd: string): Promise<string | null> {
	return await new Promise((resolve) => {
		const child = execFile(
			"git",
			["config", "--get", "remote.origin.url"],
			{ cwd, timeout: 5000 },
			(err, stdout) => {
				if (err !== null) {
					resolve(null);
					return;
				}
				const v = stdout.trim();
				resolve(v === "" ? null : v);
			},
		);
		child.on("error", () => resolve(null));
	});
}

export async function resolveRepo(
	explicit: string | undefined,
	opts: RepoResolveOptions = {},
): Promise<RepoRef | null> {
	if (explicit !== undefined && explicit.trim() !== "") return parseRepo(explicit);
	const cwd = opts.cwd ?? process.cwd();
	const read = opts.gitRemote ?? originUrl;
	const url = await read(cwd);
	if (url === null) return null;
	return repoFromRemoteUrl(url);
}

export const NO_REPO_MESSAGE =
	'Could not tell which repository you mean. Pass `repo` as "owner/name", or run this from a checkout with a GitHub ' +
	"`origin` remote.";
