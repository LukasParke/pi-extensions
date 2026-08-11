import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export type Predicate =
	{ exit_code: number } | { output_contains: string } | { output_json: { path: string; equals: unknown } };

export interface ProbeResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
}

export interface GateState {
	passes: Record<string, boolean>;
	passingSince?: number;
	complete: boolean;
}

export interface GateUpdate {
	state: GateState;
	changes: Array<{ name: string; from: boolean; to: boolean }>;
}

export function evaluatePredicate(result: ProbeResult, predicate?: Predicate) {
	if (!predicate) return result.exitCode === 0;
	if ("exit_code" in predicate) return result.exitCode === predicate.exit_code;
	if ("output_contains" in predicate) return result.stdout.includes(predicate.output_contains);

	try {
		const value = predicate.output_json.path
			.split(".")
			.filter(Boolean)
			.reduce<unknown>((current, segment) => {
				if (current === null || typeof current !== "object") return undefined;
				return (current as Record<string, unknown>)[segment];
			}, JSON.parse(result.stdout));
		return isDeepStrictEqual(value, predicate.output_json.equals);
	} catch {
		return false;
	}
}

export function validatePredicate(predicate?: Record<string, unknown>) {
	if (!predicate) return;
	const keys = ["exit_code", "output_contains", "output_json"].filter((key) => key in predicate);
	if (keys.length !== 1)
		throw new Error("A predicate must set exactly one of exit_code, output_contains, or output_json");
}

export function hashOutput(output: string) {
	return createHash("sha256").update(output).digest("hex");
}

export function truncateOutput(output: string, maxBytes = 4_096) {
	const bytes = Buffer.from(output, "utf8");
	if (bytes.length <= maxBytes) return output;

	const marker = Buffer.from("\n… output truncated …\n");
	const available = Math.max(0, maxBytes - marker.length);
	const headSize = Math.ceil(available / 2);
	const tailSize = Math.floor(available / 2);
	let headEnd = headSize;
	while (headEnd > 0 && headEnd < bytes.length && (bytes[headEnd]! & 0xc0) === 0x80) headEnd--;
	let tailStart = bytes.length - tailSize;
	while (tailStart < bytes.length && (bytes[tailStart]! & 0xc0) === 0x80) tailStart++;
	return Buffer.concat([bytes.subarray(0, headEnd), marker, bytes.subarray(tailStart)]).toString("utf8");
}

export function combinedOutput(result: ProbeResult) {
	return [result.stdout || "(stdout empty)", result.stderr ? `stderr:\n${result.stderr}` : undefined]
		.filter(Boolean)
		.join("\n");
}

export function updateGateState(
	previous: GateState,
	passes: Record<string, boolean>,
	now: number,
	quietForMs = 0,
): GateUpdate {
	const changes = Object.entries(passes).flatMap(([name, to]) => {
		const from = previous.passes[name];
		return from === undefined || from === to ? [] : [{ name, from, to }];
	});
	const allPass = Object.keys(passes).length > 0 && Object.values(passes).every(Boolean);
	const wasAllPass =
		Object.keys(previous.passes).length === Object.keys(passes).length &&
		Object.values(previous.passes).every(Boolean);
	const passingSince = allPass ? (wasAllPass ? (previous.passingSince ?? now) : now) : undefined;

	return {
		state: {
			passes: { ...passes },
			passingSince,
			complete: allPass && now - passingSince! >= quietForMs,
		},
		changes,
	};
}
