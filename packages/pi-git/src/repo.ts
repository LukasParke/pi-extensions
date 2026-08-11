import { type ParsedDiff, parseDiff } from "./diff.ts";

export interface GitExec {
	run(
		command: string,
		args: readonly string[],
		opts: { cwd: string; timeoutMs?: number; maxBuffer?: number },
	): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>;
}

export interface FileChange {
	path: string;
	status: string;
	staged: boolean;
	oldPath: string | null;
}

export interface RepoStatus {
	isRepo: boolean;
	branch: string | null;
	detached: boolean;
	ahead: number;
	behind: number;
	upstream: string | null;
	files: FileChange[];
	conflicted: boolean;
	conflictPaths: string[];
}

export interface BranchInfo {
	name: string;
	current: boolean;
	upstream: string | null;
	ahead: number;
	behind: number;
	subject: string | null;
	at: number | null;
}

export interface WorktreeInfo {
	path: string;
	branch: string | null;
	main: boolean;
	detached: boolean;
	locked: boolean;
}

const T = 15_000;

export async function status(exec: GitExec, cwd: string): Promise<RepoStatus> {
	const r = await exec.run("git", ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"], {
		cwd,
		timeoutMs: T,
	});

	if (r.code !== 0) {
		return {
			isRepo: false,
			branch: null,
			detached: false,
			ahead: 0,
			behind: 0,
			upstream: null,
			files: [],
			conflicted: false,
			conflictPaths: [],
		};
	}

	const out: RepoStatus = {
		isRepo: true,
		branch: null,
		detached: false,
		ahead: 0,
		behind: 0,
		upstream: null,
		files: [],
		conflicted: false,
		conflictPaths: [],
	};

	const records = r.stdout.split("\0").filter((s) => s !== "");

	for (let i = 0; i < records.length; i++) {
		const line = records[i] as string;

		if (line.startsWith("# branch.head ")) {
			const head = line.slice("# branch.head ".length);
			if (head === "(detached)") out.detached = true;
			else out.branch = head;
			continue;
		}
		if (line.startsWith("# branch.upstream ")) {
			out.upstream = line.slice("# branch.upstream ".length);
			continue;
		}
		if (line.startsWith("# branch.ab ")) {
			const ab = line.slice("# branch.ab ".length).split(" ");
			out.ahead = Math.abs(Number(ab[0] ?? 0));
			out.behind = Math.abs(Number(ab[1] ?? 0));
			continue;
		}
		if (line.startsWith("#")) continue;

		const kind = line.charAt(0);

		if (kind === "1") {
			const parts = line.split(" ");
			const xy = parts[1] ?? "..";
			const path = parts.slice(8).join(" ");
			out.files.push({
				path,
				status: describeXY(xy),
				staged: (xy.charAt(0) ?? ".") !== ".",
				oldPath: null,
			});
			continue;
		}

		if (kind === "2") {
			const parts = line.split(" ");
			const xy = parts[1] ?? "..";
			const path = parts.slice(9).join(" ");
			const oldPath = records[i + 1] ?? null;
			i++;
			out.files.push({
				path,
				status: "renamed",
				staged: (xy.charAt(0) ?? ".") !== ".",
				oldPath,
			});
			continue;
		}

		if (kind === "u") {
			const parts = line.split(" ");
			const path = parts.slice(10).join(" ");
			out.conflicted = true;
			out.conflictPaths.push(path);
			out.files.push({ path, status: "conflicted", staged: false, oldPath: null });
			continue;
		}

		if (kind === "?") {
			out.files.push({
				path: line.slice(2),
				status: "untracked",
				staged: false,
				oldPath: null,
			});
		}
	}

	return out;
}

function describeXY(xy: string): string {
	const x = xy.charAt(0);
	const y = xy.charAt(1);
	const code = x !== "." ? x : y;
	switch (code) {
		case "M":
			return "modified";
		case "A":
			return "added";
		case "D":
			return "deleted";
		case "R":
			return "renamed";
		case "C":
			return "copied";
		case "T":
			return "type changed";
		case "U":
			return "conflicted";
		default:
			return "modified";
	}
}

export interface DiffTarget {
	kind: "worktree" | "staged" | "range" | "file";
	spec?: string;
	path?: string;
}

const REVISION = /^[A-Za-z0-9._/@^~{}+-]{1,200}$/;

export function isSafeRevisionSpec(spec: string): boolean {
	if (spec === "" || spec.startsWith("-")) return false;
	return REVISION.test(spec);
}

export async function diff(
	exec: GitExec,
	cwd: string,
	target: DiffTarget,
	opts: { maxLinesPerFile?: number; maxFiles?: number } = {},
): Promise<ParsedDiff> {
	const args = ["diff", "--no-color", "-M", "-C", "--find-renames"];

	if (target.kind === "staged") args.push("--cached");
	if (target.kind === "range" && target.spec !== undefined) {
		if (!isSafeRevisionSpec(target.spec)) {
			throw new Error(
				`refusing to use ${JSON.stringify(target.spec)} as a git revision: it must look like a ref or a range`,
			);
		}
		args.push(target.spec);
	}
	if (target.path !== undefined) args.push("--", target.path);

	const r = await exec.run("git", args, { cwd, timeoutMs: T, maxBuffer: 64 * 1024 * 1024 });
	return parseDiff(r.stdout, opts);
}

export async function branches(exec: GitExec, cwd: string): Promise<BranchInfo[]> {
	const SEP = "\u0001";
	const r = await exec.run(
		"git",
		[
			"for-each-ref",
			"--sort=-committerdate",
			`--format=%(refname:short)${SEP}%(HEAD)${SEP}%(upstream:short)${SEP}%(upstream:track)${SEP}%(contents:subject)${SEP}%(committerdate:unix)`,
			"refs/heads/",
		],
		{ cwd, timeoutMs: T },
	);
	if (r.code !== 0) return [];

	return r.stdout
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => {
			const [name, head, upstream, track, subject, date] = l.split(SEP);
			const ab = parseTrack(track ?? "");
			return {
				name: name ?? "",
				current: (head ?? "").trim() === "*",
				upstream: upstream !== undefined && upstream !== "" ? upstream : null,
				ahead: ab.ahead,
				behind: ab.behind,
				subject: subject !== undefined && subject !== "" ? subject : null,
				at: date !== undefined && date !== "" ? Number(date) * 1000 : null,
			};
		});
}

function parseTrack(track: string): { ahead: number; behind: number } {
	const ahead = /ahead (\d{1,9})/.exec(track);
	const behind = /behind (\d{1,9})/.exec(track);
	return {
		ahead: ahead === null ? 0 : Number(ahead[1]),
		behind: behind === null ? 0 : Number(behind[1]),
	};
}

export async function worktrees(exec: GitExec, cwd: string): Promise<WorktreeInfo[]> {
	const r = await exec.run("git", ["worktree", "list", "--porcelain"], { cwd, timeoutMs: T });
	if (r.code !== 0) return [];

	const out: WorktreeInfo[] = [];
	let current: Partial<WorktreeInfo> & { path?: string } = {};

	const flush = () => {
		if (current.path !== undefined) {
			out.push({
				path: current.path,
				branch: current.branch ?? null,
				main: out.length === 0,
				detached: current.detached ?? false,
				locked: current.locked ?? false,
			});
		}
		current = {};
	};

	for (const line of r.stdout.split("\n")) {
		if (line.trim() === "") {
			flush();
			continue;
		}
		if (line.startsWith("worktree ")) current.path = line.slice("worktree ".length);
		else if (line.startsWith("branch ")) {
			current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
		} else if (line === "detached") current.detached = true;
		else if (line.startsWith("locked")) current.locked = true;
	}
	flush();
	return out;
}

export async function headCommit(
	exec: GitExec,
	cwd: string,
): Promise<{ sha: string; subject: string } | null> {
	const r = await exec.run("git", ["log", "-1", "--format=%H%x01%s"], { cwd, timeoutMs: T });
	if (r.code !== 0) return null;
	const [sha, subject] = r.stdout.trim().split("\u0001");
	if (sha === undefined || sha === "") return null;
	return { sha, subject: subject ?? "" };
}

export async function commitsBetween(
	exec: GitExec,
	cwd: string,
	range: string,
	limit = 50,
): Promise<{ sha: string; subject: string }[]> {
	if (!isSafeRevisionSpec(range)) {
		throw new Error(
			`refusing to use ${JSON.stringify(range)} as a git range: it must look like a ref or a range`,
		);
	}
	const r = await exec.run("git", ["log", `--max-count=${String(limit)}`, "--format=%H%x01%s", range], {
		cwd,
		timeoutMs: T,
	});
	if (r.code !== 0) return [];
	return r.stdout
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => {
			const [sha, subject] = l.split("\u0001");
			return { sha: sha ?? "", subject: subject ?? "" };
		});
}

export async function remoteUrl(exec: GitExec, cwd: string): Promise<string | null> {
	const r = await exec.run("git", ["remote", "get-url", "origin"], { cwd, timeoutMs: T });
	if (r.code !== 0) return null;
	const url = r.stdout.trim();
	return url === "" ? null : url;
}

export function parseRepoSlug(url: string | null): string | null {
	if (url === null) return null;
	const cleaned = url.replace(/\.git$/, "");
	const https = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)$/.exec(cleaned);
	if (https !== null) return https[1] ?? null;
	const sshColon = /^[^@]+@[^:]+:([^/]+\/[^/]+)$/.exec(cleaned);
	if (sshColon !== null) return sshColon[1] ?? null;
	const sshProto = /^ssh:\/\/[^/]+\/([^/]+\/[^/]+)$/.exec(cleaned);
	if (sshProto !== null) return sshProto[1] ?? null;
	return null;
}
