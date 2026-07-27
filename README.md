# pi-extensions

Extensions for the [pi coding agent](https://pi.dev), published as individual npm
packages. Install only what you want.

Each package ships the skills the model needs to use its tools correctly — an
extension that registers a tool without teaching the model when to reach for it
is only half done.

| Package                                                                  | Tools | What it adds                                                                                                                                            |
| ------------------------------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@parke.dev/pi-steel`](packages/pi-steel)                               | 9     | [Steel](https://github.com/steel-dev/steel-browser) browser: scrape, search, screenshot, PDF, plus a persistent session for logins and multi-step flows |
| [`@parke.dev/pi-firecrawl`](packages/pi-firecrawl)                       | 4     | Firecrawl scrape, search, map, crawl                                                                                                                    |
| [`@parke.dev/pi-background-terminals`](packages/pi-background-terminals) | 4     | Long-running commands: dev servers, watchers, builds, with a `/ps` UI                                                                                   |
| [`@parke.dev/pi-workflows`](packages/pi-workflows)                       | 1     | Multi-phase multi-agent orchestration from a JavaScript program you write                                                                               |
| [`@parke.dev/pi-file-search`](packages/pi-file-search)                   | 2     | First-class `fd` and `rg` tools                                                                                                                         |
| [`@parke.dev/pi-ask-user`](packages/pi-ask-user)                         | 1     | Let the agent ask a multiple-choice question instead of guessing                                                                                        |
| [`@parke.dev/pi-ext-config`](packages/pi-ext-config)                     | —     | Shared typed config loader used by the packages above                                                                                                   |

Subagents live in a separate repo:
[`@parke.dev/pi-subagent`](https://github.com/LukasParke/pi-subagent).
`pi-workflows` depends on it to execute `agent()` calls.

## Install

```bash
pi install npm:@parke.dev/pi-steel
pi install npm:@parke.dev/pi-background-terminals
# …etc
```

Each package's README documents its own configuration and prerequisites.
`pi-steel` needs a Steel instance, `pi-firecrawl` needs a Firecrawl API key or a
self-hosted instance, `pi-workflows` needs `pi-subagent` and a Node build with
`--permission` support. The rest work as-is.

## Configuration

Nothing requires configuration to start, and no package hardcodes a private
host. Where settings exist they resolve **defaults ← `~/.pi/<name>.json` ← environment**,
and a malformed value falls back to its default rather than breaking startup.

See [`pi-ext-config`](packages/pi-ext-config) for the shared loader.

## Develop

```bash
npm install
npm run check      # typecheck + format check + tests
npm test
npm run pack:check # verify tarball contents for every package
```

The repo is npm workspaces. Packages ship TypeScript source with no build step —
pi transpiles extensions on load, which is also why cross-package imports of
`.ts` files work.

## Credits

Inspired by [davis7dotsh/my-pi-setup](https://github.com/davis7dotsh/my-pi-setup),
which showed what pi's extension API can do. These are independent
implementations rather than forks.

## License

MIT
