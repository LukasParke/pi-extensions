import type { GitExec } from "./repo.ts";
import { status } from "./repo.ts";

export interface Check {
	name: string;
	state: string;
	detail: string | null;
}

export interface ChecklistResult {
	ready: boolean;
	checks: Check[];
}

export interface ChecklistOptions {
	commands?: Readonly<Record<string, string>>;
	expect?: readonly string[];
	timeoutMs?: number;
	configHint?: (name: string) => string;
}

export const DEFAULT_EXPECTED = ["tests", "typecheck", "lint"] as const;
export const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;

export async function checklist(
	exec: GitExec,
	cwd: string,
	opts: ChecklistOptions = {},
): Promise<ChecklistResult> {
	const checks: Check[] = [];
	const st = await status(exec, cwd);

	checks.push(
		st.conflicted
			? {
					name: "conflicts",
					state: "failing",
					detail: `${String(st.conflictPaths.length)} unresolved: ${st.conflictPaths.slice(0, 3).join(", ")}`,
				}
			: { name: "conflicts", state: "passing", detail: null },
	);

	checks.push(
		st.files.length === 0
			? { name: "working tree", state: "passing", detail: "clean" }
			: {
					name: "working tree",
					state: "warning",
					detail: `${String(st.files.length)} uncommitted change${st.files.length === 1 ? "" : "s"}`,
				},
	);

	const commands = opts.commands ?? {};
	const expected = opts.expect ?? DEFAULT_EXPECTED;
	const hint = opts.configHint ?? ((n: string) => `configure a "${n}" command to run this`);

	for (const name of expected) {
		const command = commands[name];
		if (command === undefined || command.trim() === "") {
			checks.push({ name, state: "not configured", detail: hint(name) });
			continue;
		}
		const parts = command.trim().split(/\s+/);
		const bin = parts[0];
		if (bin === undefined) {
			checks.push({ name, state: "not configured", detail: hint(name) });
			continue;
		}
		const r = await exec.run(bin, parts.slice(1), {
			cwd,
			timeoutMs: opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
		});
		checks.push({
			name,
			state: r.code === 0 ? "passing" : r.timedOut ? "timed out" : "failing",
			detail: r.code === 0 ? null : lastLines(`${r.stdout}${r.stderr}`, 5),
		});
	}

	const ready = checks.every((c) => c.state === "passing" || c.state === "warning");
	return { ready, checks };
}

export function lastLines(text: string, n: number): string {
	const lines = text
		.split("\n")
		.map((l) => l.trimEnd())
		.filter((l) => l !== "");
	return lines.slice(-n).join("\n").slice(0, 2000);
}
