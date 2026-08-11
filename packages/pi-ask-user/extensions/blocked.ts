import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export async function withBlockedSignal<T>(pi: ExtensionAPI, label: string, fn: () => Promise<T>) {
	pi.events.emit("herdr:blocked", { active: true, label });
	try {
		return await fn();
	} finally {
		pi.events.emit("herdr:blocked", { active: false });
	}
}
