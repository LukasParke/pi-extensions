# pi-extensions

Extensions for the [pi coding agent](https://pi.dev), published as individual npm
packages. Install only what you want.

Every package that registers tools ships the skills the model needs to use them
correctly — a tool without teaching the model when to reach for it is only half
done. UI-only and library-only packages (no tools) do not need skills.

| Package                                                                  | Tools | What it adds                                                                                                                                            |
| ------------------------------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@parke.dev/pi-steel`](packages/pi-steel)                               | 9     | [Steel](https://github.com/steel-dev/steel-browser) browser: scrape, search, screenshot, PDF, plus a persistent session for logins and multi-step flows |
| [`@parke.dev/pi-firecrawl`](packages/pi-firecrawl)                       | 4     | Firecrawl scrape, search, map, crawl                                                                                                                    |
| [`@parke.dev/pi-background-terminals`](packages/pi-background-terminals) | 4     | Long-running commands: dev servers, watchers, builds, with a `/ps` UI                                                                                   |
| [`@parke.dev/pi-sentinel`](packages/pi-sentinel)                         | 5     | Criteria-gated wakeups for CI, reviews, deployments, timers, and other external state                                                                   |
| [`@parke.dev/pi-subagent`](packages/pi-subagent)                         | 2     | Production-grade isolated child agents, worktrees, budgets, retries, and the workflow execution SDK                                                     |
| [`@parke.dev/pi-workflows`](packages/pi-workflows)                       | 1     | Multi-phase multi-agent orchestration from a JavaScript program you write                                                                               |
| [`@parke.dev/pi-file-search`](packages/pi-file-search)                   | 2     | First-class `fd` and `rg` tools                                                                                                                         |
| [`@parke.dev/pi-file-links`](packages/pi-file-links)                     | —     | Clickable local file paths in normal user and assistant Markdown                                                                                        |
| [`@parke.dev/pi-ask-user`](packages/pi-ask-user)                         | 1     | Let the agent ask a multiple-choice question instead of guessing                                                                                        |
| [`@parke.dev/pi-ext-config`](packages/pi-ext-config)                     | —     | Shared typed config loader used by the packages above                                                                                                   |
| [`@parke.dev/pi-herdr`](packages/pi-herdr)                               | 3     | Dispatch, monitor, and safely clean up pi agents in [herdr](https://github.com/LukasParke/herdr)-managed worktrees, with PR-review dispatch and trust   |
| [`@parke.dev/pi-git`](packages/pi-git)                                   | 5     | Structured Git status, diffs, branches, history, and pre-PR checks                                                                                      |
| [`@parke.dev/pi-github`](packages/pi-github)                             | 9     | GitHub PRs, reviews, checks, issues, comments, and authentication                                                                                       |
| [`@parke.dev/pi-slack`](packages/pi-slack)                               | 7     | Slack channels, threads, search, messages, and authentication                                                                                           |
| [`@parke.dev/pi-linear`](packages/pi-linear)                             | 8     | Linear issue search, details, comments, states, transitions, and authentication                                                                         |
| [`@parke.dev/pi-notion`](packages/pi-notion)                             | 6     | Notion search, page reading, append, and authentication                                                                                                 |
| [`@parke.dev/pi-integrations`](packages/pi-integrations)                 | 35    | One-install bundle for Git, GitHub, Slack, Linear, and Notion                                                                                           |
| [`@parke.dev/pi-dashboard`](packages/pi-dashboard)                       | —     | Optional header/footer dashboard (cwd, model, full cost, tok/s, git, PR); off by default                                                                |
| [`@parke.dev/pi-memory`](packages/pi-memory)                             | 4     | Local semantic memory engine plus remember, recall, forget, and stats tools                                                                             |
| [`@parke.dev/pi-openrouter`](packages/pi-openrouter)                     | —     | OpenRouter's three API surfaces (chat completions, responses, messages) as selectable providers, plus a benchmark harness comparing them                |

[`@parke.dev/pi-memory`](packages/pi-memory) is the canonical local semantic-memory engine and Pi extension; Circle consumes the same package through a thin product-specific wrapper.

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
  `PI_DASHBOARD_ENABLED=true`). The bundled GitHub Dark Default theme is a
  separate choice in `~/.pi/agent/settings.json` (`"theme": "github-dark-default"`)
  and is never auto-selected.

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
at the requested versions are available on npm. See [MIGRATION.md](MIGRATION.md)
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
