import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCapabilities } from "@earendil-works/pi-tui";
import { linkLocalPaths } from "../src/links.ts";

export default function (pi: ExtensionAPI) {
	let cwd = process.cwd();

	pi.on("session_start", (_event, ctx) => {
		cwd = ctx.cwd;
	});

	pi.registerMarkdownTransformer((markdown, { messageType }) =>
		messageType === "assistant-thinking"
			? markdown
			: linkLocalPaths(markdown, cwd, getCapabilities().hyperlinks),
	);
}
