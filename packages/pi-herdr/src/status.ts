import { herdr as realHerdr } from "./cli.ts";
import type { HerdrRunner } from "./dispatch.ts";
import { assertAgentTarget, isAgentName } from "./names.ts";
import { AmbiguousOrphanWorktreeError, findOrphanWorktree } from "./repos.ts";

export interface HerdrTaskStatus {
	status: string;
	cwd?: string;
	worktreePath?: string | null;
	matches?: string[];
}

export async function getHerdrTaskStatus(
	input: { agent: string; worktreeRoots: string[] },
	options: {
		herdr?: HerdrRunner;
		findOrphan?: (agentName: string, roots: string[]) => string | undefined;
	} = {},
): Promise<HerdrTaskStatus> {
	assertAgentTarget(input.agent);
	const herdr = options.herdr ?? realHerdr;
	try {
		const info = await herdr(["agent", "get", input.agent]);
		if (!info?.agent) throw new Error(`herdr returned no agent named "${input.agent}"`);
		return { status: info.agent.agent_status, cwd: info.agent.cwd };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.includes("agent_not_found")) throw error;
		try {
			const orphan = isAgentName(input.agent)
				? (options.findOrphan ?? findOrphanWorktree)(input.agent, input.worktreeRoots)
				: undefined;
			return { status: "gone", worktreePath: orphan ?? null };
		} catch (error) {
			if (!(error instanceof AmbiguousOrphanWorktreeError)) throw error;
			return { status: "gone", worktreePath: null, matches: error.matches };
		}
	}
}
