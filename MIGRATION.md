# pi-subagent monorepo migration

`@parke.dev/pi-subagent` moved from the standalone `LukasParke/pi-subagent`
repository into `packages/pi-subagent` in this repository.

## Canonical source

- New: `https://github.com/LukasParke/pi-extensions/tree/main/packages/pi-subagent`
- Old: `https://github.com/LukasParke/pi-subagent` (archive/read-only after migration)

The npm package name remains `@parke.dev/pi-subagent`. Existing npm installs do
not change. New releases use package-scoped tags such as
`pi-subagent-v0.7.0` rather than the standalone repository's `v0.7.0` tags.

The standalone repository is now left clean and unchanged. Do not delete it
until its history and release tags are preserved. Archive it with a README
pointer after the monorepo change is pushed and the npm trusted publisher is
updated to `pi-extensions`.

## Release order

Publish in dependency order; independent packages within a step may publish in any order:

1. `pi-ext-config`
2. `pi-integration-http`, `pi-integration-auth`, and `pi-subagent`
3. `pi-git`, `pi-github`, `pi-slack`, `pi-linear`, `pi-notion`, and `pi-workflows`
4. `pi-integrations` and `pi-dashboard` (dashboard depends on `pi-ext-config` + `pi-git`)

Wait for each dependency version to appear on npm before tagging its dependent; the release script enforces this.
`npm run release:plan` prints the current dependency-ordered publish sequence and which versions are unpublished — treat its output, not this list, as live truth.

The initial monorepo publish used `pi-ext-config-v0.1.0`, `pi-integration-http-v0.1.0`, `pi-integration-auth-v0.1.0`, `pi-subagent-v0.7.0`, `pi-git-v0.1.0`, `pi-github-v0.1.0`, `pi-slack-v0.1.0`, `pi-linear-v0.1.0`, `pi-notion-v0.1.0`, `pi-workflows-v0.1.0`, `pi-integrations-v0.1.0`, and `pi-dashboard-v0.1.0`.

## Integration migration

The standalone provider packages formerly developed under `@circle/*` now live here as `@parke.dev/pi-git`, `pi-github`, `pi-slack`, `pi-linear`, and `pi-notion`. Install the `pi-integrations` bundle or individual providers, not both.

Provider credentials now live in `~/.pi/agent/integration-auth.json`. Existing `circle-auth.json` is not modified or deleted because it may still belong to Circle and may contain unrelated binding credentials. Re-authenticate with `/github-login`, `/slack-login`, `/linear-login`, or `/notion-login`, or keep using the documented environment variables. GitHub also reuses `gh auth token`.

## Memory migration

`@parke.dev/pi-memory` is no longer developed in this monorepo (package
source removed). Prefer `@parke.dev/pi-graphiti` for Graphiti-backed shared
memory in Pi. An older `@parke.dev/pi-memory@0.1.0` may still exist on npm
from the initial monorepo publish; do not treat it as maintained here.
