/**
 * Append-only workflow journal.
 *
 * Canonical run state lives on disk under the run directory. The journal is the
 * source of truth for contiguous-prefix replay: completed agent entries are
 * returned on resume when request ids and hashes still match.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hashJson, sha256 } from "./hash.ts";
import type { UsageStats } from "./subagent-sdk.ts";
import { addUsage, emptyUsage } from "./subagent-sdk.ts";
import { safeStringify } from "./sandbox.ts";

export type WorkflowRunState = "pending" | "running" | "completed" | "failed" | "cancelled" | "timeout";

export interface WorkflowIdentity {
	runId: string;
	sourceHash: string;
	argsHash: string;
	cwd: string;
	label: string;
	/** Saved workflow name, when launched by name. */
	workflowName?: string;
}

export interface AgentRunResult {
	ok: boolean;
	output: string;
	structured?: unknown;
	error?: string;
	usage?: UsageStats;
	worktreeBranch?: string;
}

export interface AgentJournalEntry {
	kind: "agent";
	requestId: number;
	requestHash: string;
	phase?: string;
	label: string;
	status: "started" | "completed" | "failed";
	startedAt: number;
	endedAt?: number;
	result?: AgentRunResult;
	isolation?: "workflow" | "worktree";
	worktree?: { cwd: string; branch: string; changed?: boolean };
}

export interface PhaseJournalEntry {
	kind: "phase";
	title: string;
	at: number;
}

export interface MetaJournalEntry {
	kind: "meta";
	event: string;
	at: number;
	detail?: unknown;
}

export type JournalEntry = AgentJournalEntry | PhaseJournalEntry | MetaJournalEntry;

export interface WorkflowDefinitionFile {
	version: 1;
	identity: WorkflowIdentity;
	source: string;
	args?: unknown;
	configSnapshot: {
		maxAgentRequests: number;
		maxConcurrency: number;
		agentMaxTurns: number;
		agentMaxCost: number;
		agentTimeoutMs: number;
		workflowTimeoutMs: number;
	};
	createdAt: number;
}

export interface WorkflowSummary {
	runId: string;
	label: string;
	state: WorkflowRunState;
	phase?: string;
	startedAt: number;
	endedAt?: number;
	agentCount: number;
	completedAgents: number;
	failedAgents: number;
	usage: UsageStats;
	artifactPath: string;
	failure?: string;
	workflowBranch?: string;
	workflowName?: string;
}

const DEFINITION = "definition.json";
const JOURNAL = "journal.jsonl";
const RESULT = "result.json";
const SUMMARY = "summary.json";
const SCRIPT = "script.js";

export function runsRoot(agentDir: string) {
	return path.join(agentDir, "workflows", "runs");
}

export function runDir(agentDir: string, runId: string) {
	return path.join(runsRoot(agentDir), runId);
}

export function sourceHashOf(source: string) {
	return sha256(source);
}

export function argsHashOf(args: unknown) {
	return hashJson(args === undefined ? null : args);
}

export function requestHashOf(prompt: string, options: Record<string, unknown>) {
	return hashJson({ prompt, options });
}

export async function initRunArtifacts(options: {
	agentDir: string;
	definition: WorkflowDefinitionFile;
}): Promise<string> {
	const dir = runDir(options.agentDir, options.definition.identity.runId);
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	await fs.writeFile(path.join(dir, SCRIPT), options.definition.source, { mode: 0o600 });
	await fs.writeFile(path.join(dir, DEFINITION), safeStringify(options.definition, 2 * 1024 * 1024), {
		mode: 0o600,
	});
	await fs.writeFile(path.join(dir, JOURNAL), "", { mode: 0o600 });
	return dir;
}

export async function appendJournal(dir: string, entry: JournalEntry) {
	const line = `${safeStringify(entry, 512 * 1024)}\n`;
	await fs.appendFile(path.join(dir, JOURNAL), line, { mode: 0o600 });
}

export async function readJournal(dir: string): Promise<JournalEntry[]> {
	let raw: string;
	try {
		raw = await fs.readFile(path.join(dir, JOURNAL), "utf8");
	} catch {
		return [];
	}
	const entries: JournalEntry[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line) as JournalEntry);
		} catch {
			// skip corrupt trailing line
		}
	}
	return entries;
}

export async function readDefinition(dir: string): Promise<WorkflowDefinitionFile | undefined> {
	try {
		return JSON.parse(await fs.readFile(path.join(dir, DEFINITION), "utf8")) as WorkflowDefinitionFile;
	} catch {
		return undefined;
	}
}

export async function writeResult(dir: string, result: unknown) {
	await fs.writeFile(path.join(dir, RESULT), safeStringify(result, 1024 * 1024), { mode: 0o600 });
}

export async function writeSummary(dir: string, summary: WorkflowSummary) {
	await fs.writeFile(path.join(dir, SUMMARY), safeStringify(summary, 256 * 1024), { mode: 0o600 });
}

export async function readSummary(dir: string): Promise<WorkflowSummary | undefined> {
	try {
		return JSON.parse(await fs.readFile(path.join(dir, SUMMARY), "utf8")) as WorkflowSummary;
	} catch {
		return undefined;
	}
}

/**
 * Contiguous completed prefix: walk agent entries in requestId order and keep
 * only a prefix where every id is present, completed/failed with a result, and
 * hashes will be checked at replay time against the live request.
 */
export function contiguousCompletedPrefix(entries: JournalEntry[]): AgentJournalEntry[] {
	const byId = new Map<number, AgentJournalEntry>();
	for (const entry of entries) {
		if (entry.kind !== "agent") continue;
		const prev = byId.get(entry.requestId);
		// Last write wins (started → completed).
		if (!prev || (entry.endedAt ?? 0) >= (prev.endedAt ?? 0)) byId.set(entry.requestId, entry);
	}
	const prefix: AgentJournalEntry[] = [];
	for (let id = 1; id <= byId.size + 1; id++) {
		const entry = byId.get(id);
		if (!entry || entry.status === "started" || !entry.result) break;
		prefix.push(entry);
	}
	return prefix;
}

export function aggregateUsageFromJournal(entries: JournalEntry[]): UsageStats {
	let usage = emptyUsage();
	const seen = new Set<number>();
	for (const entry of entries) {
		if (entry.kind !== "agent" || !entry.result?.usage) continue;
		if (entry.status === "started") continue;
		if (seen.has(entry.requestId)) continue;
		seen.add(entry.requestId);
		usage = addUsage(usage, entry.result.usage);
	}
	return usage;
}

export async function listRecentSummaries(agentDir: string, limit = 20): Promise<WorkflowSummary[]> {
	const root = runsRoot(agentDir);
	let names: string[];
	try {
		names = (await fs.readdir(root)).sort().reverse();
	} catch {
		return [];
	}
	const out: WorkflowSummary[] = [];
	for (const name of names) {
		if (out.length >= limit) break;
		const summary = await readSummary(path.join(root, name));
		if (summary) out.push(summary);
	}
	return out;
}
