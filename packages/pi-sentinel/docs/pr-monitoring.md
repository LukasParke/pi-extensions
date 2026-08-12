# Native PR monitoring

## Goal

Attach a GitHub pull request to the current Pi session and wake the agent only when it can act:

- merge conflicts appear;
- CI becomes failing for a head commit;
- a reviewer adds feedback, requests changes, or opens a review thread;
- the PR is merged or closed.

Private and internal repositories use the existing `@parke.dev/pi-github` credential chain.

## Design

`sentinel_pr` resolves the repository and credential, validates the PR with one GraphQL request, then registers an idle-only poll with `SentinelManager`. Each poll reduces GitHub data to a stable snapshot and diffs it against the previous snapshot. Actionable transitions flow through Sentinel's existing coalesced wakeup delivery.

The monitor is session-scoped like other sentinels. Its states are:

- `waiting` before the first successful probe;
- `passing` when the PR needs no action;
- `failing` when the PR needs action or a probe fails;
- `complete` when the PR merges or closes;
- `timeout` when its optional deadline expires.

Actionable transitions emit `conflicts`, `ci_failure`, `review_feedback`, `merged`, or `closed` events. The monitor does not add webhooks, persistence, a second delivery path, or a separate GitHub authentication mechanism.

## Verification

- Pure transition and GraphQL mapping tests
- Manager baseline, CI regression, and terminal-state tests
- Extension tool-registration and status tests
- Live authenticated GraphQL probe against a real PR
- Package typecheck, formatting, tests, and pack checks
