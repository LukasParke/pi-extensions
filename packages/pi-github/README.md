# @parke.dev/pi-github

GitHub pull requests, reviews, checks and issues, as a Pi extension.

```sh
pi install npm:@parke.dev/pi-github      # once published
```

Nothing else. If you have the GitHub CLI authenticated, there is no credential step either.

---

## What it does

| Tool                                   | What it is for                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `github_prs`                           | What is open, what is failing, what needs review                                                        |
| `github_pr`                            | One PR in full — body, diff, checks, reviews. Enough to review it in one call                           |
| `github_issues`                        | Issues, filterable by label and assignee                                                                |
| `github_checks`                        | Why CI is red, for any branch, tag or SHA                                                               |
| `github_comment`                       | Comment on a PR or issue — **asks you first**                                                           |
| `github_review`                        | Comment (default), request changes, or approve (Luke-only: `lukeApproved` + `yes`) — **asks you first** |
| `github_status`                        | Whether it works, which credential, and what it will not do                                             |
| `github_connect` / `github_disconnect` | Store or remove a token, if you need one                                                                |

**No repository argument needed** inside a checkout — it reads your `origin` remote.

```
> what's failing on the vitest repo?
github prs vitest-dev/vitest
#10844 ci: add semgrep                      (sheremet-va; approved, passing)
#9958  fix(deps): update all non-major …    (renovate[bot]; no reviews, failing)
```

## Credentials

GitHub also offers an official remote MCP server with OAuth, but this extension
already gets the simplest local coding-agent auth path: it reuses the GitHub
CLI's OAuth-backed keyring after `gh auth login`. That keeps the curated tool
surface and write confirmations without asking you for another token. Do not
load both unless you intentionally want duplicate tools.

The fallback interactive setup keeps the secret out of the model conversation:

```text
/github-login
```

The command uses a masked prompt, validates the credential with the provider, then stores it with `0600` permissions.

Three sources, tried in order:

1. **`$GITHUB_TOKEN` / `$GH_TOKEN`** — CI's convention. Explicit beats implicit.
2. **`~/.pi/agent/integration-auth.json`** — what `/github-login` writes, `0600`, beside Pi's own `auth.json`.
3. **`gh auth token`** — the GitHub CLI's keyring, **read but never copied**.

The third is worth explaining. If you have `gh` authenticated, you have already decided to keep a token on this machine, in
a keyring that is _stronger_ than the file this extension would otherwise write. Asking you to paste a second token would
be asking you to weaken your own setup for our convenience. So it reads yours, stores nothing, and if you run
`gh auth logout` the credential goes away — because it was never ours.

Run `github_status` to see which one is in use.

## Writes ask first

Both writing tools call Pi's `ctx.ui.confirm` before anything is posted, showing the full text you are about to send.
While a confirmation is open, the extension emits `herdr:blocked` on Pi's extension event bus so external supervisors can
see that the agent is waiting for a human. The signal is released when the dialog settles and is a no-op without a listener.

| Where you are                            | What happens                                                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| A Pi TUI session                         | a confirmation dialog                                                                  |
| A host app that speaks Pi's RPC protocol | the request arrives as `extension_ui_request` and the app renders it however it likes  |
| `pi -p` (non-interactive)                | **refused**, because nobody can be asked. Pass `yes: true` if you have already decided |

That last row matters: in print mode `ctx.ui.confirm` returns `false` without prompting, so a naive implementation would
report "you declined" when nobody was ever asked. This one tells you which happened.

`github_review` defaults to `comment`. `event: "approve"` is Luke-only: it needs `lukeApproved: true` and `yes: true`.
An `Agent:` prefix on the body is not an agent vote — GitHub records the approval as the authenticated user (LukasParke).

`github_connect` has **no** `yes` escape hatch, deliberately. A flag that skips confirmation on a credential-storing tool
is one injected instruction away from an attacker's token being used for all your writes.

## What it deliberately will not do

Published in `describe()`, and a test asserts each is genuinely absent from the source:

| Not available         | Why                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------- |
| **merge**             | Cannot be undone, and a dialog is not sufficient protection for it. Use `gh pr merge` |
| **close**             | Discards review context that is tedious to reconstruct                                |
| **workflow dispatch** | Spends someone else's compute and can deploy. An operator action                      |
| **secrets**           | A credential operation. This holds one token and does not broker others               |
| **webhooks**          | Need an inbound URL. Reads poll, and say when data is stale                           |

## Rate limits

GitHub returns your remaining budget on every response, so every tool reports it:

```
(4986/5000 API calls left this hour)
```

That is GitHub's number, not an estimate. Listing PRs fetches check and review state for the first rows only — one call
per PR is how an integration spends your whole budget on a list view — and later rows honestly say `no checks` rather than
guessing.

## Using it from your own code

The package is importable as well as installable. `src/` has no Pi dependency, so a UI can render its view models
without going through a tool call:

```ts
import { GitHubClient, GITHUB_DESCRIPTION, resolveToken } from "@parke.dev/pi-github";

const token = await resolveToken();
const prs = await new GitHubClient({ token: token!.token }).pulls({ owner: "o", name: "r", slug: "o/r" });
// prs.data[0].checks === 'passing' | 'failing' | 'pending' | 'no checks'
```

`GITHUB_DESCRIPTION` declares every segment, every field on a row, and every refusal — so a UI can render a panel for
this provider without any provider-specific code, and a conformance test fails the build if it stops being true.

GitHub Enterprise: pass `baseUrl`.

## Status words, never colour alone

Every status is a word a reader can read: `passing`, `failing`, `changes requested`, `behind the base branch`. Colour is
decoration on top. A red dot says nothing to a screen reader, and nothing to someone who cannot distinguish it from the
green one.
