import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function cmuxTarget(env: NodeJS.ProcessEnv, sessionId: string) {
	const workspace = env.CMUX_WORKSPACE_ID;
	const surface = env.CMUX_SURFACE_ID;
	if (
		env.CMUX_PI_HOOKS_DISABLED === "1" ||
		workspace?.length !== 36 ||
		!UUID.test(workspace) ||
		surface?.length !== 36 ||
		!UUID.test(surface) ||
		!sessionId
	)
		return;
	// A new owner on every load also isolates late cleanup from reloads and
	// simultaneous instances of the same session in the same surface.
	const owner = createHash("sha256")
		.update(`${surface}:${sessionId}:${process.pid}:${randomUUID()}`)
		.digest("hex")
		.slice(0, 24);
	return { workspace, key: `sentinel-${owner}`, binary: env.CMUX_BUNDLED_CLI_PATH || "cmux" };
}

type CmuxTarget = NonNullable<ReturnType<typeof cmuxTarget>>;
export type CmuxRunner = (binary: string, args: string[]) => Promise<void>;

export const runCmux: CmuxRunner = (binary, args) =>
	new Promise((resolve, reject) => {
		execFile(
			binary,
			args,
			{
				timeout: 1500,
				killSignal: "SIGKILL",
				maxBuffer: 16384,
				windowsHide: true,
			},
			(error) => (error ? reject(error) : resolve()),
		);
	});

/** Latest-value queue, driven only by Sentinel's authoritative status changes. */
export function createCmuxStatus(target: CmuxTarget, run: CmuxRunner = runCmux) {
	let desired: string | undefined;
	let revision = 0;
	let handled = 0;
	let worker: Promise<void> | undefined;
	let closed = false;
	let last: string | undefined;
	// A fresh, unique key has no badge. Don't spawn a CLI for empty startup.
	let known = true;

	function queue(value: string | undefined) {
		desired = value;
		revision++;
		if (worker) return;
		worker = Promise.resolve()
			.then(async () => {
				while (handled !== revision) {
					const current = revision;
					const value = desired;
					if (!known || last !== value) {
						const args =
							value === undefined
								? ["clear-status", target.key, "--workspace", target.workspace]
								: [
										"set-status",
										target.key,
										value,
										"--workspace",
										target.workspace,
										"--icon",
										"eye",
										"--color",
										"#e5b567",
									];
						try {
							await run(target.binary, args);
							last = value;
							known = true;
						} catch {
							// Quiet, best-effort UI. Retry only on the next update, never
							// poll or fall back to a different workspace/binary.
							known = false;
						}
					}
					handled = current;
				}
			})
			.finally(() => {
				worker = undefined;
				if (handled !== revision) queue(desired);
			});
	}

	async function flush() {
		while (worker) await worker;
	}

	return {
		// Only the count summary from sentinelStatus(), before theme formatting.
		update(status: string | undefined) {
			if (!closed) queue(status ? `Watching · ${status.replace(/^◉ /, "")}` : undefined);
		},
		flush,
		async close() {
			if (!closed) {
				closed = true;
				queue(undefined);
			}
			await flush();
		},
	};
}
