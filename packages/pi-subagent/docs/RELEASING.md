# Releasing pi-subagent from the monorepo

`@parke.dev/pi-subagent` is developed and published from the
[`pi-extensions`](https://github.com/LukasParke/pi-extensions) monorepo.

## Release

1. Update `packages/pi-subagent/package.json` and `CHANGELOG.md`.
2. If its public SDK changed, update dependent workspace ranges such as
   `packages/pi-workflows/package.json` in the same change.
3. Verify the whole workspace:

   ```bash
   npm ci
   npm run release:check
   npm run release:plan
   ```

4. Tag the package, not the repository as a whole:

   ```bash
   VERSION=$(node -p "require('./packages/pi-subagent/package.json').version")
   git tag "pi-subagent-v${VERSION}"
   git push origin main "pi-subagent-v${VERSION}"
   ```

The monorepo release workflow validates the package-scoped tag, publishes only
`packages/pi-subagent`, and creates a matching GitHub Release.

## npm trusted publishing

Configure npm's trusted publisher for `@parke.dev/pi-subagent` with:

| Field | Value |
|---|---|
| Provider | GitHub Actions |
| Organization or user | `LukasParke` |
| Repository | `pi-extensions` |
| Workflow filename | `release.yml` |
| Allowed action | `npm publish` |

The first publish of a new npm package name still requires an authenticated
manual bootstrap. `@parke.dev/pi-subagent` already exists, so subsequent
publishes can use OIDC after the trusted publisher points at this repository.

## Install

```bash
pi install npm:@parke.dev/pi-subagent
```

For monorepo development:

```bash
pi install /absolute/path/to/pi-extensions/packages/pi-subagent
```
