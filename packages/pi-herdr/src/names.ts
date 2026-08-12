/** Herdr agent names, generated labels, and status/cleanup targets. */

export const AGENT_NAME_MAX = 32;
export const AGENT_NAME_PATTERN = String.raw`^[a-z][a-z0-9_-]{0,31}$`;
const PANE_ID = String.raw`w[0-9A-HJKMNP-TV-Z]+:p[0-9A-HJKMNP-TV-Z]+`;
export const PANE_ID_PATTERN = `^${PANE_ID}$`;
export const AGENT_TARGET_PATTERN = `^(?:${AGENT_NAME_PATTERN.slice(1, -1)}|${PANE_ID})$`;
export const INVALID_AGENT_NAME_MESSAGE =
	"agent name must start with a lowercase letter and contain only lowercase letters, digits, '-' or '_' (1-32 characters)";
export const INVALID_AGENT_TARGET_MESSAGE =
	"agent target must be a Herdr agent name or pane id such as w7:p3";
export const NAME_GENERATE_TIMEOUT_MS = 8_000;

const agentNameRe = new RegExp(AGENT_NAME_PATTERN);
const paneIdRe = new RegExp(PANE_ID_PATTERN);
const agentTargetRe = new RegExp(AGENT_TARGET_PATTERN);

export function isAgentName(value: string): boolean {
	return agentNameRe.test(value);
}

export function isPaneId(value: string): boolean {
	return paneIdRe.test(value);
}

export function isAgentTarget(value: string): boolean {
	return agentTargetRe.test(value);
}

export function assertAgentName(agentName: string) {
	if (!isAgentName(agentName)) throw new Error(INVALID_AGENT_NAME_MESSAGE);
}

export function assertAgentTarget(target: string) {
	if (isAgentName(target) || isPaneId(target)) return;
	if (!target || target === "." || target === ".." || /[/\\]/.test(target)) {
		throw new Error(INVALID_AGENT_TARGET_MESSAGE);
	}
	throw new Error(INVALID_AGENT_NAME_MESSAGE);
}

function trimSlug(value: string): string {
	return value.slice(0, AGENT_NAME_MAX).replace(/-+$/, "");
}

/** Deterministic Herdr-valid slug. Empty, non-Latin, and digit-leading inputs fall back to `task-…`. */
export function slugify(text: string, now: () => number = Date.now): string {
	const slug = trimSlug(
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, ""),
	);
	if (isAgentName(slug)) return slug;
	const fallback = trimSlug(`task-${slug || now().toString(36)}`);
	return isAgentName(fallback) ? fallback : "task";
}

/** Strip quotes/backticks/explanation from untrusted model output, then slugify. */
export function normalizeGeneratedName(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const line = raw.split(/\r?\n/)[0]?.trim() ?? "";
	const quoted = line.match(/[`"'“”‘’]([^`"'“”‘’]+)[`"'“”‘’]/);
	const extracted = (quoted?.[1] ?? line)
		.replace(/[`"'“”‘’]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!extracted) return undefined;
	const first = extracted.split(" ")[0] ?? "";
	const candidate = /^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(first)
		? first
		: extracted.split(" ").slice(0, 4).join(" ");
	const slug = slugify(candidate);
	return isAgentName(slug) ? slug : undefined;
}

export type NameGenerator = (task: string) => Promise<string | undefined>;

export async function resolveOmittedAgentName(task: string, generate?: NameGenerator): Promise<string> {
	if (generate) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const generated = await Promise.race([
				generate(task),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("name generation timed out")), NAME_GENERATE_TIMEOUT_MS);
				}),
			]);
			const normalized = normalizeGeneratedName(generated);
			if (normalized) return normalized;
		} catch {
			// Naming must never block dispatch.
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	return slugify(task);
}

/** Explicit names stay user intent. Omitted names are generated, then slug-fallback. */
export async function resolveHerdrTaskName(
	input: { task: string; name?: string },
	generate?: NameGenerator,
): Promise<string> {
	if (input.name !== undefined) {
		assertAgentName(input.name);
		return input.name;
	}
	return resolveOmittedAgentName(input.task, generate);
}
