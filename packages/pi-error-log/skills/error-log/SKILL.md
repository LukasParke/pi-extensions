---
name: error-log
description: Review captured tool errors with the `error_log` tool — every failed tool execution in the session is appended to ~/.pi/logs/errors.jsonl with sanitized args. Use when the user asks what went wrong, what failed recently, or wants to inspect tool errors.
---

# Error Log

Every tool execution that ends with `isError: true` is appended as one JSON
line to `~/.pi/logs/errors.jsonl`. Args are deep-redacted (sensitive keys,
secret-looking values) and capped at 4KB. The file rotates to
`errors.jsonl.1` at 10MB.

## Tool

`error_log` — newest-first entries from the log.

| Param   | Meaning                                       |
| ------- | --------------------------------------------- |
| `tool`  | only errors from this tool name               |
| `kind`  | `tool` or `extension`                         |
| `since` | ISO timestamp or duration (`30m`, `2h`, `1d`) |
| `limit` | max entries, default 20                       |

The text result is a one-line preview per entry; full entries (including the
serialized args and stack) are in `details.entries`.

## Config

`~/.pi/error-log.json` or env: `enabled` (`PI_ERROR_LOG_ENABLED`, default
true), `path` (`PI_ERROR_LOG_PATH`), `maxBytes` (`PI_ERROR_LOG_MAX_BYTES`,
default 10MB).
