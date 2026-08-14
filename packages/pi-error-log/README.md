# @parke.dev/pi-error-log

Captures every tool error in a pi session into one reviewable place: a single
append-only JSONL log at `~/.pi/logs/errors.jsonl`, plus an `error_log` tool
so the agent (or you) can ask "what failed recently?" and get real answers.

## What gets captured

The extension hooks `tool_execution_end`; whenever `event.isError` is true it
appends one JSON line:

```json
{
  "ts": "2026-08-14T12:00:00.000Z",
  "session": "/Users/you/.pi/agent/sessions/2026-08-14.jsonl",
  "cwd": "/Users/you/project",
  "kind": "tool",
  "tool": "bash",
  "toolCallId": "call_abc123",
  "args": "{\"command\":\"curl -H ...\",\"token\":\"[redacted]\"}",
  "error": { "message": "exit code 1: ...", "stack": "..." },
  "model": { "provider": "openrouter", "id": "anthropic/claude-opus-4" }
}
```

| Field        | Meaning                                                        |
| ------------ | -------------------------------------------------------------- |
| `ts`         | ISO timestamp                                                  |
| `session`    | session file path, when the session is persisted               |
| `cwd`        | working directory of the session                               |
| `kind`       | `tool` (pi's extension API exposes no `extension_error` event) |
| `tool`       | tool name                                                      |
| `toolCallId` | correlates with the transcript                                 |
| `args`       | sanitized, serialized tool args (see below)                    |
| `error`      | message, plus stack when present                               |
| `model`      | provider/id of the active model, when available                |

### Args safety

Tool args often contain credentials, so before anything hits disk:

- values under keys matching `token|secret|key|password|passwd|credential|authorization|cookie|bearer` (case-insensitive) become `[redacted]`
- string values that _look_ like secrets (40+ char base64/hex runs, `Bearer ...`) become `[redacted]` even under innocent keys
- circular structures become `[circular]`
- the serialized args are capped at 4KB with a `...[truncated]` marker

The logger never throws: a logging failure cannot break tool execution.

### Rotation

Before each append, if the file exceeds `maxBytes` (default 10MB) it is
renamed to `errors.jsonl.1`, replacing any existing `.1`. One generation of
history, no unbounded growth.

## The `error_log` tool

```
error_log({ tool?: string, kind?: "tool" | "extension", since?: string, limit?: number })
```

- `since` accepts an ISO timestamp or a duration like `30m`, `2h`, `1d`
- entries come back newest-first, `limit` defaults to 20
- the text result shows a one-line preview per entry; full entries are in `details.entries`
- corrupt or partial lines in the log are skipped, never fatal

## Configuration

Precedence: **defaults ← `~/.pi/error-log.json` ← environment**.

| Field      | Env                      | Default                   |
| ---------- | ------------------------ | ------------------------- |
| `enabled`  | `PI_ERROR_LOG_ENABLED`   | `true`                    |
| `path`     | `PI_ERROR_LOG_PATH`      | `~/.pi/logs/errors.jsonl` |
| `maxBytes` | `PI_ERROR_LOG_MAX_BYTES` | `10485760` (10MB)         |
