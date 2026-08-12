import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const pathChars = String.raw`A-Za-z0-9_@%+.,=~\-`;
const pathBoundary = new RegExp(`[${pathChars}/:]`);
const explicitPath = new RegExp(
	String.raw`^(?:~\/|\.\.?\/|\/)[${pathChars}]+(?:\/[${pathChars}]+)*(?::\d+(?::\d+)?)?`,
);
const repoPath = new RegExp(String.raw`^[${pathChars}]+(?:\/[${pathChars}]+)+(?::\d+(?::\d+)?)?`);
const quotedPath =
	/^(?:~\/|\.\.?\/|\/)[^\x00-\x1f\x7f"'()[\]<>]+|^[A-Za-z0-9_@%+.,=~-]+(?:\/[^\x00-\x1f\x7f"'()[\]<>]+)+/;
const lineSuffix = /:\d+(?::\d+)?$/;
const trailingPunctuation = /[.,;!?]+$/;
const fileName = /(?:^|\/)(?:[^/]+\.[A-Za-z0-9]{1,12}|AGENTS\.md|Dockerfile|LICENSE|Makefile)$/;

function isEscaped(text: string, index: number) {
	let slashes = 0;
	for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
	return slashes % 2 === 1;
}

function closingBracket(text: string, start: number, open: string, close: string) {
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		if (isEscaped(text, i)) continue;
		if (text[i] === open) depth++;
		if (text[i] === close && --depth === 0) return i;
	}
	return -1;
}

function markdownLinkEnd(text: string, start: number) {
	const labelStart = text[start] === "!" ? start + 1 : start;
	if (text[labelStart] !== "[") return -1;
	const labelEnd = closingBracket(text, labelStart, "[", "]");
	if (labelEnd < 0) return text.length;
	const destinationStart = labelEnd + 1;
	if (text[destinationStart] === "(") {
		const end = closingBracket(text, destinationStart, "(", ")");
		return end < 0 ? text.length : end + 1;
	}
	if (text[destinationStart] === "[") {
		const end = closingBracket(text, destinationStart, "[", "]");
		return end < 0 ? text.length : end + 1;
	}
	return labelEnd + 1;
}

function protectedEnd(text: string, start: number) {
	const char = text[start];
	if (!"`~[!<hHfF".includes(char ?? "")) return -1;
	if (char === "`" || char === "~") {
		let length = 1;
		while (text[start + length] === char) length++;
		if (char === "`" || length >= 2) {
			const marker = char.repeat(length);
			const end = text.indexOf(marker, start + length);
			return end < 0 ? text.length : end + length;
		}
	}

	const linkEnd = markdownLinkEnd(text, start);
	if (linkEnd >= 0) return linkEnd;

	if (char === "<") {
		const end = text.indexOf(">", start + 1);
		if (end >= 0) return end + 1;
	}

	if (/^(?:https?|file):\/\//i.test(text.slice(start))) {
		const match = /^[^\s<>]+/.exec(text.slice(start));
		return start + (match?.[0].length ?? 1);
	}

	return -1;
}

function isBoundary(text: string, start: number) {
	if (start === 0) return true;
	return !pathBoundary.test(text[start - 1] ?? "");
}

function splitSuffix(candidate: string) {
	const suffix = lineSuffix.exec(candidate)?.[0] ?? "";
	return { path: suffix ? candidate.slice(0, -suffix.length) : candidate, suffix };
}

function markdownLink(candidate: string, cwd: string) {
	const { path, suffix } = splitSuffix(candidate);
	const absolute = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(cwd, path);
	const label = `${path}${suffix}`.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
	return `[${label}](${pathToFileURL(absolute).href})`;
}

function pathAt(text: string, start: number) {
	if (!isBoundary(text, start) || isEscaped(text, start)) return undefined;
	const rest = text.slice(start);
	const explicit = explicitPath.exec(rest)?.[0];
	if (explicit) return explicit.replace(trailingPunctuation, "");
	const repo = repoPath.exec(rest)?.[0]?.replace(trailingPunctuation, "");
	if (!repo || /^[^/]+\.[A-Za-z]{2,}\//.test(repo)) return undefined;
	const { path } = splitSuffix(repo);
	return fileName.test(path) ? repo : undefined;
}

function transformInline(text: string, cwd: string) {
	if (/[\p{Cc}\p{Cf}]/u.test(text)) return text;

	let output = "";
	let index = 0;

	while (index < text.length) {
		const end = protectedEnd(text, index);
		if (end >= 0) {
			output += text.slice(index, end);
			index = end;
			continue;
		}

		const quote = text[index];
		if ((quote === '"' || quote === "'") && isBoundary(text, index + 1)) {
			const closing = text.indexOf(quote, index + 1);
			if (closing > index + 1) {
				const candidate = quotedPath.exec(text.slice(index + 1, closing))?.[0];
				if (candidate?.length === closing - index - 1) {
					const { path } = splitSuffix(candidate);
					if (explicitPath.test(candidate) || fileName.test(path)) {
						output += `${quote}${markdownLink(candidate, cwd)}${quote}`;
						index = closing + 1;
						continue;
					}
				}
			}
		}

		const candidate = pathAt(text, index);
		if (candidate) {
			output += markdownLink(candidate, cwd);
			index += candidate.length;
			continue;
		}

		output += text[index];
		index++;
	}

	return output;
}

export function linkLocalPaths(markdown: string, cwd: string, hyperlinks = true) {
	if (!hyperlinks) return markdown;

	const lines = markdown.split("\n");
	let fence: { marker: string; length: number } | undefined;

	return lines
		.map((line) => {
			const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
			if (fence) {
				if (marker?.[0] === fence.marker && marker.length >= fence.length) fence = undefined;
				return line;
			}
			if (marker) {
				fence = { marker: marker[0]!, length: marker.length };
				return line;
			}
			if (/^(?: {4}|\t| {0,3}\[[^\]]+\]:)/.test(line)) return line;
			return transformInline(line, cwd);
		})
		.join("\n");
}
