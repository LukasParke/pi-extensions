---
name: github
description: Use GitHub pull request, review, check, issue, and comment tools. Use when a task involves GitHub repositories, PRs, CI checks, reviews, or issues.
---

# GitHub

1. Use `github_status` when authentication or repository inference may be the problem.
2. Use `github_pr` for review: it returns the body, files, patches, checks, and reviews in one call.
3. Prefer `github_checks` when the question is specifically why CI is red.
4. Writes (`github_comment`, `github_review`) require confirmation unless the user explicitly chose non-interactive execution.
5. Authentication: run `/github-login` interactively, use `gh auth login`, or set `GITHUB_TOKEN`/`GH_TOKEN`.
