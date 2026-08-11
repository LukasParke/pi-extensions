# Releasing

Packages publish individually from this monorepo. After the initial manual
publishes, all releases go through GitHub Actions with npm trusted publishing
(OIDC) — no npm tokens, no 2FA prompts.

## Standard release flow

1. Bump the version in `packages/<slug>/package.json`.
2. Commit and push to `main`.
3. Tag and push: `git tag <slug>-v<version> && git push origin <slug>-v<version>`
   (e.g. `pi-git-v0.1.1` — the tag version must match the package version).
4. The `release.yml` workflow runs checks, creates a GitHub release with the
   tarball, and publishes to npm via OIDC.

If a package depends on a workspace sibling, publish the dependency first;
`scripts/release.mjs` enforces this and waits out registry propagation lag.

## One-time setup per package: trusted publisher

npm's trusted publishing must be configured through the npm website for each
package (there is no API/CLI for it):

1. Open `https://www.npmjs.com/package/@parke.dev/<slug>/access`.
2. Under **Trusted Publisher**, select **GitHub Actions** and set:
   - Organization or user: `LukasParke`
   - Repository: `pi-extensions`
   - Workflow filename: `release.yml`
   - Environment: leave blank
3. Optionally set **Publishing access** to _Require two-factor authentication
   or an automation or granular access token_ (OIDC bypasses this correctly).

Until a package has a trusted publisher configured, its CI publish will fail
with an auth error — publish it manually once
(`node scripts/release.mjs publish <slug>`), then configure the trusted
publisher for subsequent releases.

## Manual publish (fallback)

```bash
npm run release:check                      # typecheck + format + tests + pack
node scripts/release.mjs plan              # see what would publish
node scripts/release.mjs publish <slug>    # publish one package
```

The publish script is idempotent: already-published versions are skipped, so
re-running a loop after a partial failure is safe.
