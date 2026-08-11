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

These tools intentionally do not mutate repositories. Use Pi's `bash` tool for commit, rebase, checkout, push, and other operator actions.
