import { execFile } from "node:child_process";
import type { GitExec } from "./repo.ts";

export interface LocalGitOptions {
	bin?: string;
	defaultTimeoutMs?: number;
	defaultMaxBuffer?: number;
}

export const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 20_000;

export class LocalGitExec implements GitExec {
	constructor(private readonly opts: LocalGitOptions = {}) {}

	async run(
		command: string,
		args: readonly string[],
		opts: { cwd: string; timeoutMs?: number; maxBuffer?: number },
	): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
		return await new Promise((resolve) => {
			let timedOut = false;
			const child = execFile(
				this.opts.bin ?? command,
				[...args],
				{
					cwd: opts.cwd,
					timeout: opts.timeoutMs ?? this.opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
					maxBuffer: opts.maxBuffer ?? this.opts.defaultMaxBuffer ?? DEFAULT_MAX_BUFFER,
					env: { ...process.env, LANG: "C", LC_ALL: "C" },
				},
				(err, stdout, stderr) => {
					const code =
						err !== null && typeof (err as { code?: unknown }).code === "number"
							? (err as { code: number }).code
							: err !== null
								? null
								: 0;
					if (err !== null && (err as { killed?: boolean }).killed === true) timedOut = true;
					resolve({
						stdout: typeof stdout === "string" ? stdout : String(stdout),
						stderr: typeof stderr === "string" ? stderr : String(stderr),
						code,
						timedOut,
					});
				},
			);
			child.on("error", () => {
				resolve({ stdout: "", stderr: "could not run git", code: null, timedOut: false });
			});
		});
	}
}

export async function isRepository(exec: GitExec, cwd: string): Promise<boolean> {
	const r = await exec.run("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeoutMs: 5000 });
	return r.code === 0 && r.stdout.trim() === "true";
}

export async function repositoryRoot(exec: GitExec, cwd: string): Promise<string | null> {
	const r = await exec.run("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: 5000 });
	const out = r.stdout.trim();
	return r.code === 0 && out !== "" ? out : null;
}
