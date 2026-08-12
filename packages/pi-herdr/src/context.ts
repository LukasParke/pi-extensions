export interface HerdrEnvironment {
	HERDR_ENV?: string;
	HERDR_SOCKET_PATH?: string;
	HERDR_WORKSPACE_ID?: string;
	HERDR_TAB_ID?: string;
	HERDR_PANE_ID?: string;
}

export interface HerdrContext {
	mode: "managed" | "standalone";
	managed: boolean;
	workspaceId?: string;
	tabId?: string;
	paneId?: string;
}

export const HERDR_TOOL_NAMES = new Set(["herdr_task", "herdr_task_status", "herdr_task_cleanup"]);

const value = (input: string | undefined) => input?.trim() || undefined;
const identity = (input: string | undefined) => {
	const normalized = value(input);
	return normalized && /^[a-zA-Z0-9._:-]+$/.test(normalized) ? normalized : undefined;
};

export function detectHerdrContext(env: HerdrEnvironment = process.env) {
	const workspaceId = identity(env.HERDR_WORKSPACE_ID);
	const tabId = identity(env.HERDR_TAB_ID);
	const paneId = identity(env.HERDR_PANE_ID);
	const managed =
		env.HERDR_ENV === "1" &&
		value(env.HERDR_SOCKET_PATH) !== undefined &&
		value(env.HERDR_PANE_ID) !== undefined;

	return {
		mode: managed ? "managed" : "standalone",
		managed,
		...(workspaceId && { workspaceId }),
		...(tabId && { tabId }),
		...(paneId && { paneId }),
	} satisfies HerdrContext;
}

export function withoutHerdrTools(activeTools: string[]) {
	return activeTools.filter((name) => !HERDR_TOOL_NAMES.has(name));
}

export function requireManagedHerdr(context = detectHerdrContext()) {
	if (!context.managed) {
		throw new Error(
			"Herdr is unavailable in this standalone Pi session. Use subagent or background terminals instead.",
		);
	}
	return context;
}

export function herdrContextLine(context: HerdrContext) {
	if (!context.managed) {
		return "Herdr context: standalone Pi session; Herdr control and dispatch are unavailable. Use subagent or background terminals instead.";
	}

	const identity = [
		context.workspaceId && `workspace ${context.workspaceId}`,
		context.tabId && `tab ${context.tabId}`,
		context.paneId && `pane ${context.paneId}`,
	].filter(Boolean);
	return `Herdr context: managed Pi session${identity.length ? ` (${identity.join(", ")})` : ""}; Herdr control and dispatch are available.`;
}

export function withHerdrContext(systemPrompt: string, context: HerdrContext) {
	const line = herdrContextLine(context);
	const existing = /^Herdr context:.*$/m;
	if (existing.test(systemPrompt)) return systemPrompt.replace(existing, line);
	return `${systemPrompt}\n\n${line}`;
}
