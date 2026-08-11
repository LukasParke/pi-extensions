---
name: notion
description: Use Notion search, page reading, and append tools. Use when finding, reading, or updating Notion pages.
---

# Notion

- Use `notion_search` to locate a page, then `notion_page` for its structured blocks.
- Unsupported Notion block types are labeled rather than silently discarded.
- `notion_append` asks for confirmation and appends plain-text paragraphs; it is not a Markdown converter.
- Authentication: run `/notion-login` interactively or set `NOTION_TOKEN`/`NOTION_API_KEY`.
- Share pages with the integration in Notion or they remain invisible to the API.
