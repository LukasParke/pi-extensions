# pi-extensions

Extensions for the [pi coding agent](https://pi.dev), published as individual npm
packages. Install only what you want.

Every package that registers tools ships the skills the model needs to use them
correctly — a tool without teaching the model when to reach for it is only half
done. UI-only and library-only packages (no tools) do not need skills.

| Package                                                                  | Downloads                                                                                                                                                                  | Tools | What it adds                                                                                                                                                      |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@parke.dev/pi-steel`](packages/pi-steel)                               | [![downloads](https://img.shields.io/npm/dm/%40parke.dev%2Fpi-steel?label=&color=353b42)](https://www.npmjs.com/package/@parke.dev/pi-steel)                               | 9     | [Steel](https://github.com/steel-dev/steel-browser) browser: scrape, search, screenshot, PDF, plus a persistent session for logins and multi-step flows           |
| [`@parke.dev/pi-firecrawl`](packages/pi-firecrawl)                       | [![downloads](https://img.shields.io/npm/dm/%40parke.dev%2Fpi-firecrawl?label=&color=353b42)](https://www.npmjs.com/package/@parke.dev/pi-firecrawl)                       | 4     | Firecrawl scrape, search, map, crawl                                                                                                                              |
| [`@parke.dev/pi-background-terminals`](packages/pi-background-terminals) | [![downloads](https://img.shields.io/npm/dm/%40parke.dev%2Fpi-background-terminals?label=&color=353b42)](https://www.npmjs.com/package/@parke.dev/pi-background-terminals) | 4     | Long-running commands: dev servers, watchers, builds, with a `/ps` UI                                                                                             |
| [`@parke.dev/pi-sentinel`](packages/pi-sentinel)                         | [![downloads](https://img.shields.io/npm/dm/%40parke.dev%2Fpi-sentinel?label=&color=353b42)](https://www.npmjs.com/package/@parke.dev/pi-sentinel)                         | 6     | Criteria-gated wakeups for CI, reviews, deployments, timers, and other external state                                                                             |
| [`@parke.dev/pi-subagent`](packages/pi-subagent)                         | [![downloads](https://img.shields.io/npm/dm/%40parke.dev%2Fpi-subagent?label=&color=353b42)](https://www.npmjs.com/package/@parke.dev/pi-subagent)                         | 2     | Production-grade isolated child agents, worktrees, budgets, retries, and the subagent execution SDK used by pi-workflows                                          |
| [`@parke.dev/pi-workflows`](packages/pi-workflows)                       | [![downloads](https://img.shields.io/npm/dm/%40parke.dev%2Fpi-workflows?label=&color=353b42)](https://www.npmjs.com/package/@parke.dev/pi-workflows)                       | 1     | Multi-phase multi-agent orchestration from a JavaScript program you write                                                                                         |
| [`@parke.dev/pi-file-search`](packages/pi-file-search)                   | [![downloads](https://img.shields.io/npm/dm/%40parke.dev%2Fpi-file-search?label=&color=353b42)](https://www.npmjs.com/package/@parke.dev/pi-file-search)                   | 2     | First-class `fd` and `rg` tools                                                                                                                                   |
| [`@parke.dev/pi-file-links`](packages/pi-file-links)                     | [![downloads](https://img.shields.io/npm/dm/%40parke.dev%2Fpi-file-links?label=&color=353b42)](https://www.npmjs.com/package/@parke.dev/pi-file-links)                     | —     | Clickable local file paths in normal user and assistant Markdown                                                                                                  |
| [`@parke.dev/pi-ask-user`](packages/pi-ask-user)                         | [![downloads](https://img.shields.io/npm/dm/%40parke.dev%2Fpi-ask-user?label=&color=353b42)](https://www.npmjs.com/package/@parke.dev/pi-ask-user)                         | 1     | Let the agent ask a multiple-choice question instead of guessing                                                                                                  |
| [`@parke.dev/pi-gauntlet`](packages/pi-gauntlet)                         | [![downloads](https://img.shields.io/npm/dm/%40parke.dev%2Fpi-gauntlet?label=&color=353b42)](https://www.npmjs.com/package/@parke.dev/pi-gauntlet)                         | 1     | Goal + gauntlet loop: named shell checks that must all pass before the agent stops iterating                                                                      |
| [`@parke.dev/pi-dispatch`](packages/pi-dispatch)                         | [![downloads](https://img.shields.io/npm/dm/%40parke.dev%2Fpi-dispatch?label=&color=353b42)](https://www.npmjs.com/package/@parke.dev/pi-dispatch)                         | —     | Session-level notification queue: one batched delivery path for sentinel events, subagent completions, and escalations                                            |
| [`@parke.dev/pi-error-log`](packages/pi-error-log)                       | [![downloads](https://img.shields.io/npm/dm/%40parke.dev%2Fpi-error-log?label=&color=353b42)](https://www.npmjs.com/package/@parke.dev/pi-error-log)                       | 1     | Every tool error captured to one reviewable JSONL log with sanitized args, plus an `error_log` query tool                                                         |
| [`@parke.dev/pi-graphiti`](packages/pi-graphiti)                         | [![downloads](https://img.shields.io/npm/dm/%40parke.dev%2Fpi-graphiti?label=&color=353b42)](https://www.npmjs.com/package/@parke.dev/pi-graphiti)                         | 3     | Shared Graphiti memory: recall, remember, and health-check tools backed by a Graphiti MCP server                                                                  |
| [`@parke.dev/pi-ext-config`](packages/pi-ext-config)                     | [![downloads](https://img.shields.io/npm/dm/%40parke.dev%2Fpi-ext-config?label=&color=353b42)](https://www.npmjs.com/package/@parke.dev/pi-ext-config)                     | —     | Shared typed config loader used by the packages above                                                                                                             |
| [`@parke.dev/pi-integration-auth`](packages/pi-integration-auth)         | [![downloads](https://img.shields.io/npm/dm/%40parke.dev%2Fpi-integration-auth?label=&color=353b42)](https://www.npmjs.com/package/@parke.dev/pi-integration-auth)         | —     | Shared credential resolution, `/…-login` helpers, and `integration-auth.json` storage used by the GitHub/Slack/Linear/Notion providers                            |
| [`@parke.dev/pi-integration-http`](packages/pi-integration-http)         | [![downloads](https://img.shields.io/npm/dm/%40parke.dev%2Fpi-integration-http?label=&color=353b42)](https://www.npmjs.com/package/@parke.dev/pi-integration-http)         | —     | Shared bounded-retry HTTP client used by the integration providers                                                                                                |
| [`@parke.dev/pi-herdr`](packages/pi-herdr)                               | [![downloads](https://img.shields.io/npm/dm/%40parke.dev%2Fpi-herdr?label=&color=353b42)](https://www.npmjs.com/package/@parke.dev/pi-herdr)                               | 3     | Dispatch, monitor, and safely clean up pi agents in [herdr](https://github.com/LukasParke/herdr)-managed worktrees, with PR-review dispatch and trust             |
| [`@parke.dev/pi-git`](packages/pi-git)                                   | [![downloads](https://img.shields.io/npm/dm/%40parke.dev%2Fpi-git?label=&color=353b42)](https://www.npmjs.com/package/@parke.dev/pi-git)                                   | 5     | Structured Git status, diffs, branches, history, and pre-PR checks                                                                                                |
| [`@parke.dev/pi-github`](packages/pi-github)                             | [![downloads](https://img.shields.io/npm/dm/%40parke.dev%2Fpi-github?label=&color=353b42)](https://www.npmjs.com/package/@parke.dev/pi-github)                             | 9     | GitHub PRs, reviews, checks, issues, comments, and authentication                                                                                                 |
| [`@parke.dev/pi-slack`](packages/pi-slack)                               | [![downloads](https://img.shields.io/npm/dm/%40parke.dev%2Fpi-slack?label=&color=353b42)](https://www.npmjs.com/package/@parke.dev/pi-slack)                               | 7     | Slack channels, threads, search, messages, and authentication                                                                                                     |
| [`@parke.dev/pi-linear`](packages/pi-linear)                             | [![downloads](https://img.shields.io/npm/dm/%40parke.dev%2Fpi-linear?label=&color=353b42)](https://www.npmjs.com/package/@parke.dev/pi-linear)                             | 8     | Linear issue search, details, comments, states, transitions, and authentication                                                                                   |
| [`@parke.dev/pi-notion`](packages/pi-notion)                             | [![downloads](https://img.shields.io/npm/dm/%40parke.dev%2Fpi-notion?label=&color=353b42)](https://www.npmjs.com/package/@parke.dev/pi-notion)                             | 6     | Notion search, page reading, append, and authentication                                                                                                           |
| [`@parke.dev/pi-integrations`](packages/pi-integrations)                 | [![downloads](https://img.shields.io/npm/dm/%40parke.dev%2Fpi-integrations?label=&color=353b42)](https://www.npmjs.com/package/@parke.dev/pi-integrations)                 | 35    | One-install bundle for Git, GitHub, Slack, Linear, and Notion                                                                                                     |
| [`@parke.dev/pi-dashboard`](packages/pi-dashboard)                       | [![downloads](https://img.shields.io/npm/dm/%40parke.dev%2Fpi-dashboard?label=&color=353b42)](https://www.npmjs.com/package/@parke.dev/pi-dashboard)                       | —     | Optional header/footer dashboard (cwd, model, full cost, tok/s, git, PR); off by default                                                                          |
| [`@parke.dev/pi-openrouter`](packages/pi-openrouter)                     | [![downloads](https://img.shields.io/npm/dm/%40parke.dev%2Fpi-openrouter?label=&color=353b42)](https://www.npmjs.com/package/@parke.dev/pi-openrouter)                     | —     | CLI that syncs the full OpenRouter catalog into models.json, routing each model to its best-fit API surface, plus a benchmark harness that keeps the rules honest |

[`@parke.dev/pi-subagent`](packages/pi-subagent) lives in this monorepo and
provides the execution engine used by `pi-workflows`. Keeping both packages in
one workspace means their SDK boundary, tests, versions, and publish order are
validated together.

## Install

```bash
pi install npm:@parke.dev/pi-steel
pi install npm:@parke.dev/pi-background-terminals
pi install npm:@parke.dev/pi-sentinel
# …etc

# Install all productivity integrations together
pi install npm:@parke.dev/pi-integrations
```

GitHub, Slack, Linear, and Notion each provide a masked interactive setup
command: `/github-login`, `/slack-login`, `/linear-login`, and `/notion-login`.
Credentials are validated before being stored in
`~/.pi/agent/integration-auth.json` with `0600` permissions. Environment
variables take precedence, and GitHub reuses `gh auth token` when available.
For browser OAuth, use the providers' official hosted MCP servers through
`pi-mcp-adapter`: Linear and Notion support ordinary interactive OAuth; Slack
requires a pre-registered Slack app/client identity. Avoid enabling both MCP
and the corresponding REST package unless duplicate tool surfaces are desired.

Each package's README documents its own configuration and prerequisites.
`pi-steel` needs a Steel instance, `pi-firecrawl` needs a Firecrawl API key or a
self-hosted instance, `pi-workflows` needs `pi-subagent` and a Node build with
`--permission` support. The rest work as-is.

## Configuration

Nothing requires configuration to start, and no package hardcodes a private
host. Where settings exist they resolve **defaults ← `~/.pi/<name>.json` ← environment**,
and a malformed value falls back to its default rather than breaking startup.

See [`pi-ext-config`](packages/pi-ext-config) for the shared loader.

Notable opt-ins:

- **Dashboard** — install [`@parke.dev/pi-dashboard`](packages/pi-dashboard),
  then set `"enabled": true` in `~/.pi/dashboard.json` (or
  `PI_DASHBOARD_ENABLED=true`).

## Develop

```bash
npm install
npm run check      # typecheck + format check + tests
npm test
npm run pack:check # verify tarball contents for every package
npm run release:plan # show publish order and unpublished versions
```

Publishing uses package-scoped tags (`pi-subagent-v0.7.0`,
`pi-workflows-v0.1.0`). The release workflow publishes only the tagged package,
so independently versioned packages remain independent while CI and local
implementation stay consolidated. `release:plan` is dependency-ordered, and
`release:publish` refuses to publish a package until its workspace dependencies
at the requested versions are available on npm. The full release flow
(tag → CI → npm trusted publishing / OIDC) is in [RELEASING.md](RELEASING.md).
See [MIGRATION.md](MIGRATION.md)
for the current dependency-ordered release sequence, including the integration
libraries, individual providers, and bundle.

The repo is npm workspaces. Packages ship TypeScript source with no build step —
pi transpiles extensions on load, which is also why cross-package imports of
`.ts` files work.

## Credits

Inspired by [davis7dotsh/my-pi-setup](https://github.com/davis7dotsh/my-pi-setup),
which showed what pi's extension API can do. These are independent
implementations rather than forks.

## License

MIT
