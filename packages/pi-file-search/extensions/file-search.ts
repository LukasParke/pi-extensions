/**
 * `fd` and `rg` as first-class tools.
 *
 * Faster and far more predictable than asking the model to compose shell
 * pipelines: both respect .gitignore by default, output is bounded and spilled
 * to a file when it overflows, and user-supplied patterns can never be
 * interpreted as command-line flags.
 *
 * Deliberately NOT ported from the reference implementation: its
 * download-a-binary bootstrap (pinned versions, SHA-256 maps, redirect
 * handling, tar extraction). That is ~700 lines of supply-chain-sensitive code
 * whose failure mode is executing an attacker-controlled binary, and it exists
 * only to serve users who lack fd/rg. We resolve from PATH and
 * ~/.pi/agent/bin, and if a tool is genuinely missing we say so with the
 * one-line install command. Not shipping a downloader is the safer default.
 *
 * Flag-injection safety: every user value is passed as a separate argv element
 * (never a shell string), and the pattern plus path go after a literal `--`, so
 * a pattern like `-rf` or `--help` is a search term, not an option.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const EXEC_TIMEOUT_MS = 60_000;
/** Guard against a pathological match set eating memory before truncation. */
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;

const FD_DEFAULT_LIMIT = 1000;
const FD_MAX_LIMIT = 10_000;
const FD_MAX_DEPTH = 64;
const RG_DEFAULT_LIMIT = 100;
const RG_MAX_LIMIT = 1_000;
const RG_MAX_CONTEXT = 20;

interface Resolved {
	command: string;
	source: "path" | "agent-bin";
}

const cache = new Map<string, Resolved | null>();

/** Candidate names per tool; Debian ships fd as fdfind. */
const CANDIDATES: Record<string, string[]> = { fd: ["fd", "fdfind"], rg: ["rg"] };

function agentBinDir(): string {
	return path.join(os.homedir(), ".pi", "agent", "bin");
}

function run(
	command: string,
	args: string[],
	options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		// spawn, not execFile: we must set stdin to "ignore".
		//
		// rg with no path argument reads stdin when stdin is not a TTY. execFile
		// always gives the child an open stdin pipe (its options have no stdio
		// field), so `rg pattern` with no path hung until the 60s timeout while
		// the identical command took 10ms in a shell. Verified both ways.
		const child = spawn(command, args, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});
		let stdout = "";
		let stderr = "";
		let bytes = 0;
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			fn();
		};
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* gone */
			}
			finish(() => reject(new Error(`${command} timed out after ${options.timeoutMs ?? EXEC_TIMEOUT_MS}ms`)));
		}, options.timeoutMs ?? EXEC_TIMEOUT_MS);
		timer.unref?.();
		const onAbort = () => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* gone */
			}
			finish(() => reject(new Error(`${command} was cancelled`)));
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			bytes += Buffer.byteLength(chunk, "utf8");
			// Stop accumulating well past any limit the model will ever see.
			if (bytes <= MAX_CAPTURE_BYTES) stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			if (stderr.length < 64 * 1024) stderr += chunk;
		});
		child.on("error", (error) =>
			finish(() =>
				reject(
					(error as { code?: string }).code === "ENOENT"
						? new Error(`${command} not found`)
						: (error as Error),
				),
			),
		);
		child.on("close", (code) => finish(() => resolve({ code: code ?? 0, stdout, stderr })));
	});
}

/** PATH first, then ~/.pi/agent/bin. Probed once per process. */
async function resolveTool(tool: "fd" | "rg"): Promise<Resolved | null> {
	if (cache.has(tool)) return cache.get(tool)!;
	const probeArgs = tool === "fd" ? ["--version"] : ["--version"];
	for (const name of CANDIDATES[tool]!) {
		try {
			await run(name, probeArgs, { timeoutMs: 5_000, cwd: os.tmpdir() });
			const resolved: Resolved = { command: name, source: "path" };
			cache.set(tool, resolved);
			return resolved;
		} catch {
			/* try next */
		}
	}
	const local = path.join(agentBinDir(), tool);
	try {
		await fs.access(local);
		await run(local, probeArgs, { timeoutMs: 5_000, cwd: os.tmpdir() });
		const resolved: Resolved = { command: local, source: "agent-bin" };
		cache.set(tool, resolved);
		return resolved;
	} catch {
		/* not there either */
	}
	cache.set(tool, null);
	return null;
}

function missingMessage(tool: "fd" | "rg"): string {
	const brew = tool === "fd" ? "brew install fd" : "brew install ripgrep";
	const apt = tool === "fd" ? "apt install fd-find" : "apt install ripgrep";
	return `${tool} is not installed. Install it with \`${brew}\` (macOS) or \`${apt}\` (Debian/Ubuntu), or drop a binary at ${path.join(agentBinDir(), tool)}, then restart pi.`;
}

/** Strip a leading @ and expand ~, matching how people paste paths. */
function normalizePath(value: string | undefined): string | undefined {
	if (!value) return undefined;
	let out = value.trim();
	if (!out) return undefined;
	if (out.startsWith("@")) out = out.slice(1);
	if (out === "~") return os.homedir();
	if (out.startsWith("~/")) return path.join(os.homedir(), out.slice(2));
	return out || undefined;
}

const clamp = (value: number | undefined, min: number, max: number, fallback: number): number =>
	value === undefined ? fallback : Math.min(max, Math.max(min, Math.trunc(value)));

/** Bound model-facing output, spilling the remainder to a file. */
async function present(
	stdout: string,
	label: string,
): Promise<{ text: string; truncated: boolean; totalLines: number; file?: string }> {
	const trimmed = stdout.replace(/\n+$/, "");
	const lines = trimmed ? trimmed.split("\n") : [];
	const totalLines = lines.length;
	let shown = lines;
	let truncated = false;
	if (shown.length > DEFAULT_MAX_LINES) {
		shown = shown.slice(0, DEFAULT_MAX_LINES);
		truncated = true;
	}
	let text = shown.join("\n");
	if (Buffer.byteLength(text, "utf8") > DEFAULT_MAX_BYTES) {
		text = Buffer.from(text, "utf8").subarray(0, DEFAULT_MAX_BYTES).toString("utf8");
		truncated = true;
	}
	if (!truncated) return { text, truncated, totalLines };
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `pi-${label}-`));
	const file = path.join(dir, "results.txt");
	await fs.writeFile(file, trimmed, "utf8");
	return {
		text: `${text}\n\n[truncated: showing ${shown.length} of ${totalLines} lines (${formatSize(
			Buffer.byteLength(text, "utf8"),
		)} of ${formatSize(Buffer.byteLength(trimmed, "utf8"))}). Full results: ${file}]`,
		truncated,
		totalLines,
		file,
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "fd",
		label: "Find Files",
		description:
			"Find files and directories by name using fd. Respects .gitignore and skips hidden files by default. Much faster and more predictable than `find` via bash. The pattern is a regex unless glob:true.",
		parameters: Type.Object(
			{
				pattern: Type.Optional(
					Type.String({ description: "Name pattern (regex by default). Omit to list everything." }),
				),
				path: Type.Optional(
					Type.String({ description: "Directory to search. Defaults to the session cwd." }),
				),
				type: Type.Optional(
					StringEnum(["file", "directory", "symlink"], { description: "Restrict to one entry type." }),
				),
				extension: Type.Optional(
					Type.String({ description: "Filter by extension, e.g. 'ts' (leading dot optional)." }),
				),
				glob: Type.Optional(Type.Boolean({ description: "Treat pattern as a glob instead of a regex." })),
				hidden: Type.Optional(Type.Boolean({ description: "Include hidden and ignored files." })),
				max_depth: Type.Optional(
					Type.Integer({ minimum: 1, maximum: FD_MAX_DEPTH, description: "Max directory depth." }),
				),
				limit: Type.Optional(
					Type.Integer({
						minimum: 1,
						maximum: FD_MAX_LIMIT,
						description: `Max results. Defaults to ${FD_DEFAULT_LIMIT}.`,
					}),
				),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params: any, signal, _onUpdate, ctx: ExtensionContext) {
			const tool = await resolveTool("fd");
			if (!tool) throw new Error(missingMessage("fd"));
			const args = ["--color=never"];
			if (params.hidden) args.push("--hidden", "--no-ignore");
			if (params.glob) args.push("--glob");
			if (params.type)
				args.push("--type", params.type === "file" ? "f" : params.type === "directory" ? "d" : "l");
			if (params.extension) args.push("--extension", String(params.extension).replace(/^\.+/, ""));
			args.push("--max-depth", String(clamp(params.max_depth, 1, FD_MAX_DEPTH, FD_MAX_DEPTH)));
			args.push("--max-results", String(clamp(params.limit, 1, FD_MAX_LIMIT, FD_DEFAULT_LIMIT)));
			// Everything after `--` is data: a pattern of "-rf" cannot become a flag.
			args.push("--", params.pattern ?? "");
			const searchPath = normalizePath(params.path);
			if (searchPath) args.push(searchPath);

			const result = await run(tool.command, args, { cwd: ctx.cwd, signal });
			if (result.code !== 0 && !result.stdout.trim()) {
				throw new Error(`fd failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
			}
			if (!result.stdout.trim()) {
				return { content: [{ type: "text" as const, text: "No files found" }], details: { matches: 0 } };
			}
			const shown = await present(result.stdout, "fd");
			return {
				content: [{ type: "text" as const, text: shown.text }],
				details: { matches: shown.totalLines, truncated: shown.truncated, file: shown.file ?? null },
			};
		},
	});

	pi.registerTool({
		name: "rg",
		label: "Search Content",
		description:
			"Search file contents with ripgrep. Respects .gitignore, skips binaries, and returns file:line:match. Much faster than grep via bash. Pattern is a regex unless fixed_strings:true.",
		parameters: Type.Object(
			{
				pattern: Type.String({ description: "Regex to search for." }),
				path: Type.Optional(
					Type.String({ description: "File or directory to search. Defaults to the session cwd." }),
				),
				glob: Type.Optional(
					Type.String({ description: "Only search paths matching this glob, e.g. '*.ts'." }),
				),
				file_type: Type.Optional(
					Type.String({ description: "Restrict to a ripgrep type, e.g. 'ts', 'py', 'rust'." }),
				),
				case_sensitive: Type.Optional(
					Type.Boolean({ description: "true = case sensitive, false = ignore case. Omit for smart-case." }),
				),
				fixed_strings: Type.Optional(Type.Boolean({ description: "Treat the pattern as a literal string." })),
				hidden: Type.Optional(Type.Boolean({ description: "Include hidden and ignored files." })),
				context: Type.Optional(
					Type.Integer({
						minimum: 0,
						maximum: RG_MAX_CONTEXT,
						description: "Lines of context around each match.",
					}),
				),
				limit: Type.Optional(
					Type.Integer({
						minimum: 1,
						maximum: RG_MAX_LIMIT,
						description: `Max matches per file. Defaults to ${RG_DEFAULT_LIMIT}.`,
					}),
				),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params: any, signal, _onUpdate, ctx: ExtensionContext) {
			const tool = await resolveTool("rg");
			if (!tool) throw new Error(missingMessage("rg"));
			const args = ["--line-number", "--color=never", "--no-heading", "--with-filename"];
			if (params.case_sensitive === true) args.push("--case-sensitive");
			else if (params.case_sensitive === false) args.push("--ignore-case");
			else args.push("--smart-case");
			if (params.fixed_strings) args.push("--fixed-strings");
			if (params.hidden) args.push("--hidden", "--no-ignore");
			if (params.context !== undefined)
				args.push("--context", String(clamp(params.context, 0, RG_MAX_CONTEXT, 0)));
			if (params.glob) args.push("--glob", params.glob);
			if (params.file_type) args.push("--type", params.file_type);
			args.push("--max-count", String(clamp(params.limit, 1, RG_MAX_LIMIT, RG_DEFAULT_LIMIT)));
			args.push("--", params.pattern);
			const searchPath = normalizePath(params.path);
			if (searchPath) args.push(searchPath);

			const result = await run(tool.command, args, { cwd: ctx.cwd, signal });
			// ripgrep exits 1 for "no matches", which is not an error.
			if (result.code === 1 && !result.stdout.trim()) {
				return { content: [{ type: "text" as const, text: "No matches found" }], details: { matches: 0 } };
			}
			if (result.code > 1 || (result.code === 1 && result.stderr.trim())) {
				throw new Error(`rg failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
			}
			if (!result.stdout.trim()) {
				return { content: [{ type: "text" as const, text: "No matches found" }], details: { matches: 0 } };
			}
			const shown = await present(result.stdout, "rg");
			return {
				content: [{ type: "text" as const, text: shown.text }],
				details: { matches: shown.totalLines, truncated: shown.truncated, file: shown.file ?? null },
			};
		},
	});
}
