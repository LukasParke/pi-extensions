# @parke.dev/pi-file-search

First-class [`fd`](https://github.com/sharkdp/fd) and
[`rg`](https://github.com/BurntSushi/ripgrep) tools for the
[pi coding agent](https://pi.dev). Faster and more predictable than asking the
model to compose `find` / `grep` shell pipelines: both respect `.gitignore` by
default, output is bounded and spilled to a file when it overflows, and
user-supplied patterns are never interpreted as command-line flags.

Two tools:

| Tool | What it does                                                         |
| ---- | -------------------------------------------------------------------- |
| `fd` | find files and directories by name (regex by default; optional glob) |
| `rg` | search file contents with ripgrep (`file:line:match`)                |

Ships with a [`file-search` skill](skills/file-search/SKILL.md) that teaches the
model to prefer these over `bash find` / `bash grep`.

## Install

```bash
pi install npm:@parke.dev/pi-file-search
```

You also need `fd` and `rg` on the machine (or dropped into the agent bin dir —
see below). On macOS and Debian/Ubuntu:

```bash
# macOS
brew install fd ripgrep

# Debian / Ubuntu (fd ships as fdfind; the tool probes both names)
apt install fd-find ripgrep
```

Restart pi after installing so the extension re-probes.

## Binary provisioning

Each tool is resolved once per process, in this order:

1. **System `PATH`** — for `fd`, candidates are `fd` then `fdfind` (Debian's
   package name); for `rg`, just `rg`. Each is probed with `--version`.
2. **Agent bin dir** — `~/.pi/agent/bin/fd` or `~/.pi/agent/bin/rg`. The file
   must exist and respond to `--version`.

There is **no automatic download**. If neither location has a working binary,
the tool fails with a one-line install hint (`brew install …` / `apt install …`,
or “drop a binary at `~/.pi/agent/bin/<tool>`”) and asks you to restart pi.

Any platform where you can put a working `fd`/`rg` on `PATH` or in
`~/.pi/agent/bin` is supported. There is no per-OS binary map and no cache of
downloaded releases — install the binaries yourself (package manager, or a
static build from the upstream GitHub releases into `~/.pi/agent/bin`).

## Tools

### `fd` — Find Files

Find files and directories by name. Respects `.gitignore` and skips hidden
files by default. Pattern is a regex unless `glob: true`.

| Parameter   | Type                                     | Default         | Meaning                                                       |
| ----------- | ---------------------------------------- | --------------- | ------------------------------------------------------------- |
| `pattern`   | string                                   | list everything | name pattern (regex unless `glob`)                            |
| `path`      | string                                   | session cwd     | directory to search (`~` and a leading `@` are expanded)      |
| `type`      | `"file"` \| `"directory"` \| `"symlink"` | any             | restrict to one entry type                                    |
| `extension` | string                                   | —               | filter by extension, e.g. `ts` (leading dot optional)         |
| `glob`      | boolean                                  | `false`         | treat `pattern` as a glob instead of a regex                  |
| `hidden`    | boolean                                  | `false`         | include hidden **and** ignored files (`--hidden --no-ignore`) |
| `max_depth` | integer 1–64                             | 64              | max directory depth                                           |
| `limit`     | integer 1–10000                          | 1000            | max results                                                   |

### `rg` — Search Content

Search file contents. Respects `.gitignore`, skips binaries, returns
`file:line:match`. Pattern is a regex unless `fixed_strings: true`.

| Parameter        | Type           | Default     | Meaning                                                             |
| ---------------- | -------------- | ----------- | ------------------------------------------------------------------- |
| `pattern`        | string         | required    | regex to search for (or literal if `fixed_strings`)                 |
| `path`           | string         | session cwd | file or directory to search (`~` and a leading `@` are expanded)    |
| `glob`           | string         | —           | only search paths matching this glob, e.g. `*.ts`                   |
| `file_type`      | string         | —           | ripgrep type, e.g. `ts`, `py`, `rust`                               |
| `case_sensitive` | boolean        | smart-case  | `true` = case sensitive, `false` = ignore case; omit for smart-case |
| `fixed_strings`  | boolean        | `false`     | treat `pattern` as a literal string                                 |
| `hidden`         | boolean        | `false`     | include hidden **and** ignored files (`--hidden --no-ignore`)       |
| `context`        | integer 0–20   | —           | lines of context around each match                                  |
| `limit`          | integer 1–1000 | 100         | max matches **per file**                                            |

Large result sets are truncated for the model and the full output is written to
a temp file whose path is included in the response.

## License

MIT
