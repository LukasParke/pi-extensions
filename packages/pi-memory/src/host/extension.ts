import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { FallbackEmbedder, HashEmbedder, MEMORY_SCHEMA_UP, MemoryEngine, OnnxEmbedder } from "../index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const configuredAgentDir = process.env.PI_CODING_AGENT_DIR?.trim();
const STATE_DIR = configuredAgentDir ? resolve(configuredAgentDir) : join(homedir(), ".pi", "agent");
const DB_PATH = join(STATE_DIR, "circle-memory.db");
const PEER_PATH = join(STATE_DIR, "circle-memory-peer");

function redact(text: string): string {
	const patterns: [RegExp, string][] = [
		[/sk-[A-Za-z0-9_-]{20,}/g, "openai-key"],
		[/sk-or-[A-Za-z0-9_-]{20,}/g, "openrouter-key"],
		[/xox[baprs]-[A-Za-z0-9-]{10,}/g, "slack-token"],
		[/gh[pousr]_[A-Za-z0-9]{20,}/g, "github-token"],
		[/lin_api_[A-Za-z0-9]{20,}/g, "linear-key"],
		[/ntn_[A-Za-z0-9]{20,}/g, "notion-token"],
		[/AKIA[0-9A-Z]{16}/g, "aws-key"],
		[/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "private-key"],
		[/(password|passwd|secret|api[_-]?key)\s*[:=]\s*\S{8,}/gi, "generic-secret"],
	];
	let out = text;
	for (const [re, kind] of patterns) out = out.replace(re, `«redacted:${kind}»`);
	return out;
}

function peerId(): string {
	if (existsSync(PEER_PATH)) return readFileSync(PEER_PATH, "utf8").trim();
	const id = `pi-${hostname()}-${Date.now().toString(36)}`;
	writeFileSync(PEER_PATH, id, { mode: 0o600 });
	return id;
}

interface ToolResult {
	content: { type: "text"; text: string }[];
	details: unknown;
}
function ok(text: string, details: unknown = {}): ToolResult {
	return { content: [{ type: "text", text }], details };
}

export default function memory(pi: ExtensionAPI): void {
	let enginePromise: Promise<any> | null = null;

	async function engine(): Promise<any> {
		enginePromise ??= (async () => {
			const onnx = new OnnxEmbedder();
			const embedder = onnx.available() ? new FallbackEmbedder(onnx, new HashEmbedder()) : new HashEmbedder();
			const db = new DatabaseSync(DB_PATH);
			const hasSchema = db
				.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_entries'")
				.get();
			if (hasSchema === undefined) db.exec(MEMORY_SCHEMA_UP);
			return new MemoryEngine({ db, peerId: peerId(), embedder, redact });
		})();
		return enginePromise;
	}

	pi.on("session_shutdown", async () => {
		if (enginePromise !== null) await (await enginePromise).close();
	});

	pi.registerTool({
		name: "memory_remember",
		label: "Remember a fact",
		description:
			"Store a fact in long-term memory for future sessions. Near-duplicates are folded into the existing entry " +
			"instead of duplicated. Secrets are redacted before storage; a fact that is only a secret is dropped. " +
			'Use scope "global" (default) unless the fact is only true of one project.',
		parameters: Type.Object({
			text: Type.String({ description: "The fact to remember, as a sentence." }),
			scope: Type.Optional(Type.Union([Type.Literal("global"), Type.Literal("project")])),
			projectId: Type.Optional(Type.String({ description: 'Required when scope is "project".' })),
		}),
		async execute(_id, params) {
			const p = params as { text: string; scope?: "global" | "project"; projectId?: string };
			const e = await engine();
			const result = await e.add({
				text: p.text,
				scope: p.scope ?? "global",
				project_id: p.projectId ?? null,
				extracted_by: "user",
			});
			if (result === null) {
				return ok(
					"Not stored — empty after redaction, too long, or a project-scoped fact with no projectId.",
					{
						stored: false,
					},
				);
			}
			return ok(
				result.deduped
					? `Already known — confirmed the existing entry (${result.entry.id}).`
					: `Remembered (${result.entry.id}).`,
				{ stored: true, deduped: result.deduped, entry: result.entry },
			);
		},
	});

	pi.registerTool({
		name: "memory_recall",
		label: "Recall memories",
		description:
			"Search long-term memory: hybrid semantic + exact-token retrieval, fused by reciprocal rank. " +
			"Returns matching facts with ids, scopes and confirmation counts.",
		parameters: Type.Object({
			query: Type.String({ description: "What to recall, in words or exact tokens (e.g. a ticket id)." }),
			limit: Type.Optional(Type.Number()),
			mode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("global"), Type.Literal("project")])),
			projectId: Type.Optional(Type.String()),
		}),
		async execute(_id, params) {
			const p = params as {
				query: string;
				limit?: number;
				mode?: "all" | "global" | "project";
				projectId?: string;
			};
			const e = await engine();
			const filter: any = {
				mode: p.mode ?? "all",
				...(p.projectId !== undefined ? { project_id: p.projectId } : {}),
			};
			const { hits, tookMs } = await e.recall(p.query, filter, p.limit ?? 8);
			if (hits.length === 0) return ok("Nothing remembered matches that.", { hits: [], tookMs });
			const lines = hits.map((h: any) => {
				const ent = h.entry;
				const scope = ent.scope === "project" ? `project:${ent.project_id}` : "global";
				return `- [${ent.id}] (${scope}, confirmed ${ent.provenance.confirmations}x) ${ent.text}`;
			});
			return ok(lines.join("\n"), { hits, tookMs });
		},
	});

	pi.registerTool({
		name: "memory_forget",
		label: "Forget a memory",
		description: "Delete a memory entry by id (ids come from memory_recall or memory_remember).",
		parameters: Type.Object({
			id: Type.String({ description: "The entry id to forget." }),
		}),
		async execute(_id, params) {
			const { id } = params as { id: string };
			const e = await engine();
			return e.forget(id)
				? ok(`Forgot ${id}.`, { forgotten: true })
				: ok(`No live entry with id ${id}.`, { forgotten: false });
		},
	});

	pi.registerTool({
		name: "memory_stats",
		label: "Memory stats",
		description: "Report memory-store size, semantic availability, and where the data lives.",
		parameters: Type.Object({}),
		async execute() {
			const e = await engine();
			const stats = e.stats();
			const modelId: string = e.opts.embedder.modelId;
			const semantic = !modelId.includes("NOT-SEMANTIC");
			const lines = [
				`Entries: ${stats.total} (${stats.global} global` +
					(stats.by_project.length > 0
						? `; projects: ${stats.by_project.map((p: any) => `${p.project_id}=${p.n}`).join(", ")}`
						: "") +
					").",
				`Awaiting embedding: ${e.awaitingEmbedding()}.`,
				`Embedder: ${modelId} (semantic recall ${semantic ? "ON" : "OFF — exact-token only"}).`,
				`Database: ${DB_PATH}.`,
			];
			return ok(lines.join("\n"), { stats, dbPath: DB_PATH, semantic, modelId });
		},
	});
}
