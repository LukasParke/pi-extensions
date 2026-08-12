# Repository instructions

## Mandatory change lifecycle

This applies to every repository change, including docs, chores, and config.

1. Dispatch a dedicated Pi Herdr agent into a Herdr-owned worktree on an `agent/*` branch. The same Herdr mission owns the change through merge; never assign work in this personal repository to Devin or Perry.
2. Keep `/Users/luke/github/pi-extensions` as the clean canonical `main` checkout. Never develop or commit there. Before implementation, fetch and ensure the worktree branch is based on current `origin/main`.
3. Make a focused change, then run `npm run check` after every edit cycle plus relevant package-specific or live verification.
4. Keep commits signed. If 1Password authorization blocks signing, report the block and await authorization; never disable or bypass signing.
5. Commit, push, and open a focused PR automatically. Do not wait for a separate request, and always report a clickable PR link.
6. Attach `sentinel_pr` (or use equivalent GitHub state checks when unavailable). The same Herdr Pi mission investigates and fixes CI failures and actionable review feedback, resolves review threads, and pushes updates; never hand remediation to Devin or Perry.
7. Merge only when every reported CI check passes, no changes-requested review remains, and all review threads are resolved. Use a merge commit and delete the remote branch.
8. After merge, the dispatching session fast-forwards canonical `main`, installs dependencies when manifests or lockfiles changed, verifies relevant package loading, and calls `herdr_task_cleanup`.

## Coding standards

- Extensions ship TypeScript source; Pi transpiles it on load, so there is no build step.
- Put config in `src/config.ts` via `@parke.dev/pi-ext-config`; never hardcode hosts or paths.
- Every package that registers tools must ship a skill teaching the model when to use them.
- Prefer inferred return types. Treat `as any` as a last resort.
