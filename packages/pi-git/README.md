# @parke.dev/pi-git

Structured Git reads and configurable verification for the [Pi coding agent](https://pi.dev).
Requires Pi **0.99.1 or newer**.

Tool rows use Pi's native theme and terminal-width handling. Results show at most
five preview rows; expand for patches, logs, branch/worktree detail, and verification
output. Expanded output is bounded to 200 terminal lines with an overflow notice.
Errors and refusals never display a clean working tree. Model-facing content and
structured results are unchanged.

```sh
pi install npm:@parke.dev/pi-git
```

Git reads require no credential, daemon, or network access. `git_checklist` can run arbitrary
configured commands; those commands may modify files or access the network.

| Tool            | Purpose                                                                    |
| --------------- | -------------------------------------------------------------------------- |
| `git_status`    | Parsed branch, upstream, conflict, and working-tree state                  |
| `git_diff`      | Parsed working-tree, staged, or revision-range patch                       |
| `git_branches`  | Local branches, upstream position, and optional worktrees                  |
| `git_log`       | Commit summaries between revisions                                         |
| `git_checklist` | PR-readiness checks, including explicitly configured verification commands |

Ships a [`git-tools` skill](skills/git-tools/SKILL.md) teaching the model when
to reach for these instead of shelling out to `git`.

## Native codemode

Tools are grouped in the native `git` namespace and return typed business data to
Pi's `codemode`; direct calls keep their text and TUI renderers. For example:

```js
const result = await tools.git_status({});
if (result.refused) return result;
return { branch: result.status.branch, conflicts: result.status.conflictPaths };
```

Every output schema includes a `{ refused: true }` alternative. Refusals also set
native `isError`; an empty diff or commit list is a successful result. Git reads
are annotated as read-only and closed-world, but `git_checklist` is conservatively
non-read-only, potentially destructive, non-idempotent, and open-world.

## Parameters and behavior

- `git_status` — optional `path` (a directory inside the repo; defaults to the
  session cwd). Reports branch, upstream ahead/behind, detached HEAD,
  conflicts, and per-file states; text shows at most 200 files, while structured
  data preserves the complete file list.
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

The Git reads do not intentionally mutate repositories. Configured checklist commands
have no such guarantee. Use Pi's `bash` tool for commit, rebase, checkout, push, and
other operator actions.
