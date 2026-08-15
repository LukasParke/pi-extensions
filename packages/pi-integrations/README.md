# @parke.dev/pi-integrations

One install for the Git, GitHub, Slack, Linear, and Notion Pi integrations.

```sh
pi install npm:@parke.dev/pi-integrations
```

Install this bundle or individual packages, not both; installing both would register duplicate tool names.

This is an install-only bundle: each integration remains an independent package, so you can instead install only what you use:

```sh
pi install npm:@parke.dev/pi-git
pi install npm:@parke.dev/pi-github
pi install npm:@parke.dev/pi-slack
pi install npm:@parke.dev/pi-linear
pi install npm:@parke.dev/pi-notion
```

## What's included

| Package                |  Tools |
| ---------------------- | -----: |
| `@parke.dev/pi-git`    |      5 |
| `@parke.dev/pi-github` |      9 |
| `@parke.dev/pi-slack`  |      7 |
| `@parke.dev/pi-linear` |      8 |
| `@parke.dev/pi-notion` |      6 |
| **Total**              | **35** |

Each package's skill directory is also loaded (`git-tools`, `github`, `slack`,
`linear`, `notion`).

## Authentication

These bundled REST integrations use provider tokens. For the simplest browser
OAuth experience, prefer each provider's official hosted MCP server through
`pi-mcp-adapter` for Linear and Notion; GitHub already reuses `gh auth login`.
Do not load both the REST extension and its MCP server unless you intentionally
want duplicate tool surfaces. Slack's hosted MCP OAuth requires a registered
Slack app/client identity, so the token-backed REST package remains the generic
fallback.

Run the provider's interactive setup command; credentials are entered in a masked prompt, validated before saving, and stored in `~/.pi/agent/integration-auth.json` with mode `0600`:

```text
/github-login
/slack-login
/linear-login
/notion-login
```

Environment variables take precedence over saved credentials. GitHub also uses `gh auth token` when available. See each provider package for required scopes.

## Safety

Read tools run immediately. Tools that post comments, messages, reviews, or transitions show the exact payload and ask for confirmation. Non-interactive callers must explicitly pass `yes: true`.
