# Releasing

Releases are published to npm from GitHub Actions using [OIDC trusted publishing](https://docs.npmjs.com/trusted-publishers/) — no npm tokens are stored in the repository. Pushing a `v*` tag triggers `.github/workflows/release.yml`, which builds, tests, packs, and publishes `@seher-ts/sdk` and `@seher-ts/cli` with provenance attestations.

## One-time setup (npmjs.com)

Trusted publishing is configured per package. For **each** of [`@seher-ts/sdk`](https://www.npmjs.com/package/@seher-ts/sdk/access) and [`@seher-ts/cli`](https://www.npmjs.com/package/@seher-ts/cli/access):

1. Open the package's **Settings** page on npmjs.com.
2. Under **Trusted Publisher**, select **GitHub Actions** and enter:
   - Organization or user: `smartcrabai`
   - Repository: `seher-ts`
   - Workflow filename: `release.yml` (filename only, not the full path)
   - Environment name: leave empty
3. Save.

No `NPM_TOKEN` secret is needed on GitHub.

## Cutting a release

On `main` with a clean working tree, run the [`release`](https://github.com/smartcrabai/release) CLI:

```bash
release          # patch bump; or: release minor / release major
```

This bumps the version in all three `package.json` files in lockstep, updates `bun.lock`, commits, tags `vX.Y.Z`, and pushes `main` and the tag. The CLI's own publish step is disabled by `.release.toml` in this repository — the tag push triggers the `Release` workflow, which publishes `@seher-ts/sdk` first, then `@seher-ts/cli`. Check progress under the repository's **Actions** tab.

Manual alternative: bump the three `package.json` versions, run `bun install`, commit as `chore: bump version to X.Y.Z`, then `git tag vX.Y.Z && git push origin main vX.Y.Z`.

## Notes

- `.release.toml` (`publish = false`) makes the `release` CLI skip publishing here — including `--only-publish` — so packages are only ever published from CI with provenance.

- The workflow fails early if the tag does not match the `package.json` version.
- `bun pm pack` resolves `workspace:^` dependencies to concrete versions; the workflow verifies the resulting tarballs contain no `workspace:` references before publishing (guards against [oven-sh/bun#20477](https://github.com/oven-sh/bun/issues/20477)).
- Publishing uses the npm CLI (>= 11.5.1) rather than `bun publish`, because Bun does not support OIDC trusted publishing yet ([oven-sh/bun#22423](https://github.com/oven-sh/bun/issues/22423)).
- Provenance requires the `repository` field in each package's `package.json` to match the GitHub repository exactly.
