export type DiffLineKind = "add" | "del" | "ctx" | "meta";

export interface DiffLine {
	kind: DiffLineKind;
	text: string;
	oldLine: number | null;
	newLine: number | null;
}

export interface DiffHunk {
	header: string;
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	lines: DiffLine[];
	anchor: string;
}

export type FileStatus =
	"added" | "deleted" | "modified" | "renamed" | "copied" | "mode_changed" | "type_changed";

export interface DiffFile {
	path: string;
	oldPath: string | null;
	status: FileStatus;
	additions: number;
	deletions: number;
	hunks: DiffHunk[];
	binary: boolean;
	oldMode: string | null;
	newMode: string | null;
	noNewlineAtEof: boolean;
	truncated: boolean;
}

export interface ParsedDiff {
	files: DiffFile[];
	additions: number;
	deletions: number;
	truncated: boolean;
}

export interface ParseDiffOptions {
	maxLinesPerFile?: number;
	maxFiles?: number;
}

export const DEFAULT_MAX_LINES_PER_FILE = 2000;
export const DEFAULT_MAX_FILES = 300;

const DIFF_GIT = /^diff --git /;
const HUNK_HEADER = /^@@ -(\d{1,10})(?:,(\d{1,10}))? \+(\d{1,10})(?:,(\d{1,10}))? @@/;

export function parseDiff(raw: string, opts: ParseDiffOptions = {}): ParsedDiff {
	const maxLines = opts.maxLinesPerFile ?? DEFAULT_MAX_LINES_PER_FILE;
	const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;

	const files: DiffFile[] = [];
	let truncatedFiles = false;

	const lines = raw.split("\n");
	let i = 0;

	while (i < lines.length) {
		const line = lines[i] as string;
		if (!DIFF_GIT.test(line)) {
			i++;
			continue;
		}

		if (files.length >= maxFiles) {
			truncatedFiles = true;
			break;
		}

		const header = stripCr(line);
		const paths = parseGitHeader(header);
		i++;

		const file: DiffFile = {
			path: paths.newPath,
			oldPath: null,
			status: "modified",
			additions: 0,
			deletions: 0,
			hunks: [],
			binary: false,
			oldMode: null,
			newMode: null,
			noNewlineAtEof: false,
			truncated: false,
		};

		while (i < lines.length) {
			const h = stripCr(lines[i] as string);
			if (h.startsWith("@@") || DIFF_GIT.test(h)) break;

			if (h.startsWith("new file mode ")) {
				file.status = "added";
				file.newMode = h.slice("new file mode ".length).trim();
			} else if (h.startsWith("deleted file mode ")) {
				file.status = "deleted";
				file.oldMode = h.slice("deleted file mode ".length).trim();
			} else if (h.startsWith("old mode ")) {
				file.oldMode = h.slice("old mode ".length).trim();
			} else if (h.startsWith("new mode ")) {
				file.newMode = h.slice("new mode ".length).trim();
			} else if (h.startsWith("rename from ")) {
				file.status = "renamed";
				file.oldPath = h.slice("rename from ".length);
			} else if (h.startsWith("rename to ")) {
				file.status = "renamed";
				file.path = h.slice("rename to ".length);
			} else if (h.startsWith("copy from ")) {
				file.status = "copied";
				file.oldPath = h.slice("copy from ".length);
			} else if (h.startsWith("copy to ")) {
				file.status = "copied";
				file.path = h.slice("copy to ".length);
			} else if (h.startsWith("Binary files ") || h.startsWith("GIT binary patch")) {
				file.binary = true;
			}
			i++;
		}

		if (
			file.status === "modified" &&
			file.oldMode !== null &&
			file.newMode !== null &&
			file.oldMode !== file.newMode
		) {
			file.status = "mode_changed";
		}

		let linesKept = 0;

		while (i < lines.length) {
			const h = stripCr(lines[i] as string);
			if (DIFF_GIT.test(h)) break;

			const m = HUNK_HEADER.exec(h);
			if (m === null) {
				i++;
				continue;
			}

			const oldStart = Number(m[1]);
			const oldCount = m[2] === undefined ? 1 : Number(m[2]);
			const newStart = Number(m[3]);
			const newCount = m[4] === undefined ? 1 : Number(m[4]);

			const hunk: DiffHunk = {
				header: h,
				oldStart,
				oldCount,
				newStart,
				newCount,
				lines: [],
				anchor: `${file.path}:${oldStart}`,
			};
			i++;

			let oldNo = oldStart;
			let newNo = newStart;

			while (i < lines.length) {
				const body = lines[i] as string;
				const stripped = stripCr(body);
				if (DIFF_GIT.test(stripped) || HUNK_HEADER.test(stripped)) break;

				if (stripped.startsWith("\\")) {
					file.noNewlineAtEof = true;
					hunk.lines.push({ kind: "meta", text: stripped, oldLine: null, newLine: null });
					i++;
					continue;
				}

				const marker = stripped.charAt(0);
				const text = stripped.slice(1);

				if (marker === "+") {
					hunk.lines.push({ kind: "add", text, oldLine: null, newLine: newNo++ });
					file.additions++;
					linesKept++;
				} else if (marker === "-") {
					hunk.lines.push({ kind: "del", text, oldLine: oldNo++, newLine: null });
					file.deletions++;
					linesKept++;
				} else if (marker === " " || stripped === "") {
					hunk.lines.push({ kind: "ctx", text, oldLine: oldNo++, newLine: newNo++ });
					linesKept++;
				} else {
					break;
				}
				i++;
			}

			if (linesKept > maxLines) {
				file.truncated = true;
				file.hunks = [];
				while (i < lines.length && !DIFF_GIT.test(stripCr(lines[i] as string))) {
					const stripped = stripCr(lines[i] as string);
					if (stripped.startsWith("+")) file.additions++;
					else if (stripped.startsWith("-")) file.deletions++;
					i++;
				}
				break;
			}

			file.hunks.push(hunk);
		}

		files.push(file);
	}

	return {
		files,
		additions: files.reduce((n, f) => n + f.additions, 0),
		deletions: files.reduce((n, f) => n + f.deletions, 0),
		truncated: truncatedFiles,
	};
}

function parseGitHeader(header: string): { oldPath: string; newPath: string } {
	const rest = header.slice("diff --git ".length);
	if (rest.startsWith('"')) {
		const parts = rest.split('" "');
		if (parts.length === 2) {
			const left = parts[0] as string;
			const right = parts[1] as string;
			return {
				oldPath: stripPrefix(left.slice(1)),
				newPath: stripPrefix(right.replace(/"$/, "")),
			};
		}
	}
	const half = Math.floor(rest.length / 2);
	const sep = rest.indexOf(" b/", half - 1);
	if (sep === -1) {
		const bits = rest.split(" ");
		return {
			oldPath: stripPrefix(bits[0] as string),
			newPath: stripPrefix(bits[bits.length - 1] as string),
		};
	}
	return {
		oldPath: stripPrefix(rest.slice(0, sep)),
		newPath: stripPrefix(rest.slice(sep + 1)),
	};
}

function stripPrefix(p: string): string {
	if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
	return p;
}

function stripCr(s: string): string {
	return s.endsWith("\r") ? s.slice(0, -1) : s;
}

export function summarizeDiff(d: ParsedDiff): string {
	const n = d.files.length;
	const files = `${n} file${n === 1 ? "" : "s"}`;
	return `${files} · +${d.additions} −${d.deletions}${d.truncated ? " · truncated" : ""}`;
}
