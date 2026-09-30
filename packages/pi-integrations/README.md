# @parke.dev/pi-integrations

The bundled providers use native-themed, width-aware call/result previews.
Expand for actual patches, threads, pages, diagnostics and mutation links;
model-facing text and typed business results remain available unchanged.

One install for the Git, GitHub, Slack, Linear, and Notion Pi integrations.
Requires Pi **0.99.1 or newer**.

All 35 tools have native namespaces, effect annotations, and business output
schemas. Direct calls retain their text/renderers; native codemode receives
structured data. Refusals return native errors with `{ refused: true, error }`,
so scripts can inspect the failure rather than parse prose. Authentication,
confirmation, masking, and approval guards still apply to nested calls.

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
Pi's native MCP support (`mcp.json` and `pi mcp login`) for Linear and Notion;
GitHub already reuses `gh auth login`. An installed `pi-mcp-adapter` replaces
the built-in MCP manager, so remove that adapter only when intentionally migrating
your existing configuration. This bundle does not change user MCP settings.
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
