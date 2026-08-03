# Releasing CodePilot

CodePilot releases are immutable npm packages paired with GitHub releases. Prerelease versions use npm's `next` distribution tag; stable versions use `latest`.

## One-time repository setup

1. Create an npm account, enable two-factor authentication, and confirm that it owns the `@ruthlessz` scope.
2. Bootstrap the first release with a short-lived granular npm token that can publish `@ruthlessz/codepilot` and bypass two-factor authentication. Store it temporarily as the GitHub repository secret `NPM_TOKEN`; never commit it.
3. After the first package version exists, configure npm Trusted Publishing for `@ruthlessz/codepilot`, GitHub repository `RuthlessZhang/CodePilot`, workflow filename `release.yml`, and allowed action `npm publish`.
4. Delete the `NPM_TOKEN` repository secret. Subsequent releases use short-lived OpenID Connect credentials from GitHub Actions instead of a stored npm token.
5. Keep GitHub Actions permissions enabled for the repository. The release workflow needs `contents: write` to create the GitHub release and `id-token: write` for npm Trusted Publishing and provenance.
6. Create the protected GitHub Environment and `DEEPSEEK_API_KEY` described in the README for manually dispatched Provider smoke tests.

The release workflow intentionally disables dependency caching because it has elevated publication permissions. Never store npm or Provider tokens in the repository, package metadata, workflow files, or release artifacts.

## Release checklist

1. Update `package.json` and `package-lock.json` to the exact SemVer version.
2. Move relevant entries from `Unreleased` into a dated CHANGELOG section.
3. Run `npm run release:check` on a clean checkout.
4. Confirm the main CI matrix is green on Linux, Windows, and macOS with Node.js 20 and 24.
5. For Provider, protocol, or release-candidate changes, manually run `DeepSeek Provider Smoke` and inspect its redacted artifact.
6. Commit and push the release preparation changes.
7. Create and push the matching annotated tag only after all gates pass:

```powershell
node scripts/validate-release-tag.mjs v0.3.0-rc.1
git tag -a v0.3.0-rc.1 -m "CodePilot v0.3.0-rc.1"
git push origin v0.3.0-rc.1
```

Pushing a matching `v*` tag runs `.github/workflows/release.yml`. The workflow repeats all release gates, builds a tarball, publishes it to npm with provenance, and then creates a GitHub release containing the exact tarball. The first publication uses the temporary `NPM_TOKEN`; later publications use npm Trusted Publishing automatically. If npm publication fails, the GitHub release is not created.

## Post-release verification

```powershell
npm view @ruthlessz/codepilot@next version dist.integrity
npm install --global @ruthlessz/codepilot@next
codepilot --version
codepilot --help
```

Do not move a prerelease to `latest` manually. Publish a stable SemVer version through the same tagged workflow after the release candidate has passed real-project evaluation.
