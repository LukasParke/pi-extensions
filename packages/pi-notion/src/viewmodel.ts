import { type ApiBlock, type ApiPage, pageTitle, parentLabel } from "./client.ts";

export type PageBlock =
	| { type: "heading"; level: 1 | 2 | 3; text: string }
	| { type: "paragraph"; text: string }
	| { type: "list"; ordered: boolean; items: string[] }
	| { type: "code"; language: string | null; source: string }
	| { type: "quote"; text: string }
	| { type: "divider" }
	| { type: "table"; headers: string[]; rows: string[][] }
	| { type: "unsupported"; label: string };

export interface PageRow {
	id: string;
	title: string;
	url: string;
	lastEditedAt: number;
	parent: string;
}

export interface PageDetail extends PageRow {
	blocks: PageBlock[];
	truncated: boolean;
}

const ts = (s: string | null | undefined): number => (s == null ? 0 : Date.parse(s) || 0);

export function toPageRow(p: ApiPage): PageRow {
	return {
		id: p.id,
		title: pageTitle(p.properties) ?? "Untitled",
		url: p.url ?? "",
		lastEditedAt: ts(p.last_edited_time),
		parent: parentLabel(p.parent),
	};
}

export function mapBlock(b: ApiBlock): PageBlock {
	const text = (key: string): string => {
		const node = b[key] as { rich_text?: { plain_text?: string }[] } | undefined;
		return (node?.rich_text ?? []).map((t) => t.plain_text ?? "").join("");
	};

	switch (b.type) {
		case "heading_1":
			return { type: "heading", level: 1, text: text("heading_1") };
		case "heading_2":
			return { type: "heading", level: 2, text: text("heading_2") };
		case "heading_3":
			return { type: "heading", level: 3, text: text("heading_3") };
		case "paragraph":
			return { type: "paragraph", text: text("paragraph") };
		case "bulleted_list_item":
			return { type: "list", ordered: false, items: [text("bulleted_list_item")] };
		case "numbered_list_item":
			return { type: "list", ordered: true, items: [text("numbered_list_item")] };
		case "quote":
			return { type: "quote", text: text("quote") };
		case "divider":
			return { type: "divider" };
		case "code": {
			const node = b.code as { language?: string } | undefined;
			return { type: "code", language: node?.language ?? null, source: text("code") };
		}
		default:
			return { type: "unsupported", label: b.type };
	}
}

export function toPageDetail(page: ApiPage, blocks: ApiBlock[], truncated: boolean): PageDetail {
	return {
		...toPageRow(page),
		blocks: blocks.map(mapBlock),
		truncated,
	};
}

export function blockToText(b: PageBlock): string {
	switch (b.type) {
		case "heading":
			return `${"#".repeat(b.level)} ${b.text}`;
		case "paragraph":
			return b.text;
		case "list":
			return b.items.map((i, idx) => (b.ordered ? `${String(idx + 1)}. ${i}` : `- ${i}`)).join("\n");
		case "code":
			return `\`\`\`${b.language ?? ""}\n${b.source}\n\`\`\``;
		case "quote":
			return `> ${b.text}`;
		case "divider":
			return "---";
		case "table":
			return [b.headers.join(" | "), ...b.rows.map((r) => r.join(" | "))].join("\n");
		case "unsupported":
			return `[unsupported Notion block: ${b.label}]`;
		default: {
			const never: never = b;
			return String(never);
		}
	}
}

export function pageToText(detail: PageDetail): string {
	const lines = [
		detail.title,
		detail.url === "" ? detail.id : detail.url,
		`parent: ${detail.parent}`,
		"",
		...detail.blocks.map(blockToText),
	];
	if (detail.truncated) {
		lines.push("", "(block list truncated — the page has more children than were fetched)");
	}
	return lines.join("\n");
}
