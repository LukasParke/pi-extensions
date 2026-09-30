---
name: file-search
description: Prefer the fd and rg tools over bash find/grep for file discovery and content search — faster, respects .gitignore, skips hidden and binary files by default. Use when finding files by name/extension or searching code contents; pass hidden:true to include ignored/generated files.
---

# File Search (`fd` / `rg`)

Prefer these tools over `bash find` and `bash grep`. They are faster, respect
`.gitignore` by default, skip hidden files (and binaries, for `rg`), bound their
output, and cannot turn a user pattern into a shell flag.

## Native `find`/`grep` vs these `fd`/`rg` tools

Pi also ships native `find` and `grep` tools. They are not replacements for these
specialized tools — the `fd`/`rg` tools here preserve semantics the native ones do not:

- gitignore-aware defaults with a single `hidden: true` escape hatch that enables both
  hidden and ignored files
- automatic multiline mode when a pattern contains a newline, and automatic glob retry
  for `*`/`?`-leading fd patterns (with notes when either fires)
- smart-case by default on `rg` (omit `case_sensitive`), with per-file match limits
- partial-I/O tolerance: unreadable paths (broken symlinks, permissions) still return
  real matches, marked `partial: true` with a note, instead of failing the whole search
- bounded output with the full result set spilled to a temp file when truncated

Use `fd`/`rg` when you need any of that (usually: code search in a real repo). The
native `find`/`grep` tools are fine for simple one-off lookups. Both `fd` and `rg`
also return structured results: `fd.paths` contains complete bounded paths;
`rg.output` and `rg.lines` preserve matches, requested context, and filenames without
ambiguous colon parsing. Truncated results include a `file` path for the full output.

Terminal previews are display-only; expand to read context. Ripgrep's displayed
count includes context lines. Preserve partial-I/O caveats and follow the full
results `file` pointer when the bounded output is insufficient.

## `fd` — find files by name

```
fd { pattern?, path?, type?, extension?, glob?, hidden?, max_depth?, limit? }
```

- `pattern` is a **regex by default**. Pass `glob: true` to treat it as a glob
  instead. A pattern starting with `*` or `?` is auto-treated as a glob, and a
  pattern starting with a literal dot (`.env`) auto-includes hidden files (both
  with a note). Omit `pattern` to list everything under `path` (or the session
  cwd).
- `type`: `"file"` | `"directory"` | `"symlink"`.
- `extension`: e.g. `"ts"` (leading dot optional).
- `max_depth`: 1–64 (default 64). `limit`: 1–10000 (default 1000).

## `rg` — search file contents

```
rg { pattern, path?, glob?, file_type?, case_sensitive?, fixed_strings?, hidden?, context?, limit? }
```

- `pattern` is a **regex** unless `fixed_strings: true` (literal string).
- Narrow with `glob: "*.ts"` and/or `file_type: "ts"` (also `"py"`, `"rust"`, …).
- `case_sensitive`: `true` / `false`; omit for smart-case.
- `context`: 0–20 lines around each match. `limit`: max matches **per file**
  (1–1000, default 100). Output is `file:line:match`.
- Newlines in `pattern` automatically enable multiline mode. If some paths are
  unreadable (broken symlinks, permissions), matches are still returned with a
  `some paths were unreadable` note — treat those results as possibly
  incomplete.

## Defaults that hide things

Both tools honor `.gitignore` / ignore files and skip hidden paths unless you
pass `hidden: true` — which enables **both** hidden and ignored files
(`--hidden --no-ignore`). That matters for generated output, build dirs, and
dotfiles: if a match “should” exist and does not show up, retry with
`hidden: true` before assuming it is absent.
