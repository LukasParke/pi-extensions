---
name: file-search
description: Prefer the fd and rg tools over bash find/grep for file discovery and content search — faster, respects .gitignore, skips hidden and binary files by default. Use when finding files by name/extension or searching code contents; pass hidden:true to include ignored/generated files.
---

# File Search (`fd` / `rg`)

Prefer these tools over `bash find` and `bash grep`. They are faster, respect
`.gitignore` by default, skip hidden files (and binaries, for `rg`), bound their
output, and cannot turn a user pattern into a shell flag.

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
