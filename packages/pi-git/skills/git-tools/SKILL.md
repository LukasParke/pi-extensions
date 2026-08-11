---
name: git-tools
description: Use structured Git tools for status, diffs, branches, history, and pre-PR readiness. Use when inspecting a repository or deciding whether work is ready for review.
---

# Git tools

Prefer `git_status`, `git_diff`, `git_branches`, `git_log`, and `git_checklist` over parsing porcelain output yourself.

- Start with `git_status` for the working tree.
- Use `git_diff` for a parsed patch; pass `ref` for commit ranges.
- Use `git_checklist` before claiming a branch is PR-ready.
- These tools are read-only. Use `bash` for mutations such as commit, rebase, or checkout.
