# @parke.dev/pi-git

Structured, read-only Git tools for the [Pi coding agent](https://pi.dev).

```sh
pi install npm:@parke.dev/pi-git
```

No credential, daemon, or network access is required.

| Tool            | Purpose                                                                    |
| --------------- | -------------------------------------------------------------------------- |
| `git_status`    | Parsed branch, upstream, conflict, and working-tree state                  |
| `git_diff`      | Parsed working-tree, staged, or revision-range patch                       |
| `git_branches`  | Local branches, upstream position, and optional worktrees                  |
| `git_log`       | Commit summaries between revisions                                         |
| `git_checklist` | PR-readiness checks, including explicitly configured verification commands |

Ships a [`git-tools` skill](skills/git-tools/SKILL.md) teaching the model when
to reach for these instead of shelling out to `git`.

## Parameters and behavior

- `git_status` — optional `path` (a directory inside the repo; defaults to the
  session cwd). Reports branch, upstream ahead/behind, detached HEAD,
  conflicts, and per-file states; the file list is capped at 200 entries.
- `git_diff` — optional `ref` (omit for the working tree, `"--staged"` for the
  index, otherwise a revision or range), plus optional `file` and `path`.
  Unsafe revision specs are refused.
- `git_branches` — optional `path` and `include_worktrees` (also lists each
  linked worktree's path and checked-out branch).
- `git_log` — optional `from`, `to` (default `HEAD`), `limit` (default 50, max
  200), `path`, and `format` (`"short"` \| `"full"`). Entries are `sha` +
  `subject` only.
- `git_checklist` — optional `path`, a `commands` map of name → shell command,
  and `expect` (default `["tests", "typecheck", "lint"]`). Built-in checks
  cover conflicts and working-tree cleanliness (a dirty tree is a warning, not
  a blocker); an expected check with no configured command counts as **not
  ready**.

These tools intentionally do not mutate repositories. Use Pi's `bash` tool for commit, rebase, checkout, push, and other operator actions.
