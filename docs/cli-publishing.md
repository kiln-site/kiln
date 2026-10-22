# CLI publishing

CLI binaries follow the exact app tag after the nightly app release or stable
promotion succeeds. Nightly CLI builds run alongside container builds using the
resolved version and source commit; publication verifies that commit against the
release tag before consuming the prepared artifacts. Stable releases and manual
retries build from the existing tag through the same build workflow. Every
platform compiles once. No app release publishes to npm or waits for npm.

Release assets include:

- `kiln-<tag>-linux-{x64,arm64}` and matching `.tar.gz` archives;
- `kiln-<tag>-darwin-{x64,arm64}` and matching `.tar.gz` archives;
- `kiln-<tag>-windows-x64.exe` and a matching `.zip` archive.

Archives include the README and license files. macOS executables have ad-hoc
signatures and are not notarized; the README explains browser quarantine handling.
The bootstrap and updater download raw executables and verify their size and
SHA-256 digest supplied by GitHub's release API, then check the executable's version.

**Publish CLI release assets** (`publish-cli.yml`) supports retries with an
existing release tag, replacing matching GitHub assets. `NPM_PACKAGE` is not
required for binary publication. Nightly and stable runs continue to share the
app release queue; npm has a separate queue and cannot hold it up.

## npm bootstrap

`NPM_PACKAGE` names a small, dependency-free launcher (for example `kiln-cli` or
`@example/panel-cli`). It downloads the newest complete nightly for the current
platform from the distribution's public GitHub releases on first invocation.
Newer releases whose CLI asset has not arrived yet are skipped. Stable selection
uses GitHub's latest stable release; an exact selection uses its release tag.
Missing stable or pinned assets report an error and can be retried after upload.

The downloaded binary lives in the package's private `native/` directory. Installs
are locked and staged before replacement, so concurrent first launches share one
installation and failed downloads leave no executable behind. Later invocations
start the installed binary immediately, without network checks. There is no
postinstall script: `npx`, global installs, and package managers that disable
lifecycle scripts use the same first-launch path. Node.js 20+ runs the launcher;
the application runs from its bundled Bun runtime. GitHub must be reachable on
first use, and the package directory must be writable.

For a fresh installation, set `KILN_CLI_CHANNEL=stable` to select stable instead of
the default nightly, or `KILN_CLI_VERSION=0.1.0-nightly.20261022.075517` to select an
exact published version (no leading `v`). Exact selection takes precedence over
the channel. These variables select the initial download only. They do not switch
an already installed binary. `kiln update` subsequently preserves that binary's
stable/nightly channel. Runtime environment variables cannot redirect the repository.

The bootstrap version is **independent of the binary version**. Pinning an npm
version pins the launcher; use `KILN_CLI_VERSION` on a fresh install to pin the
initial binary. `kiln --version` reports the binary version, while npm records the
bootstrap version. A cached `npx` install keeps its downloaded binary until
`kiln update` or a fresh installation.

## Publish or change the bootstrap

1. Update `apps/cli/npm/version.json` when changing the launcher or its bundled
   README/skill. Use a new semver version greater than previously published
   bootstrap versions. Normal CLI changes do not need a bootstrap version bump.
2. Run `vp run -F kiln-cli build:npm` to prepare `dist/npm`, without compiling a
   binary or installing workspace dependencies in the publishing job.
3. Review `npm pack --dry-run ./apps/cli/dist/npm`.
4. Run **Publish npm CLI bootstrap** (`publish-cli-bootstrap.yml`) from `main`.
   It uses the `NPM_PACKAGE` repository variable and npm trusted publishing.
   Already published versions are skipped; accepted uploads wait for registry
   processing only in this independent workflow.

`KILN_GIT_REPO` selects the source GitHub repository at build time, accepting an
HTTPS URL or `owner/repository`. Workflows set it from `github.repository`.
`KILN_CLI_PACKAGE` selects the npm name and `KILN_CLI_DEFAULT_URL` supplies the
package homepage and binary's default Hearth URL. `KILN_VERSION` applies only to
binary builds; it does not change the bootstrap version.

### One-time migration

After merging, configure the existing launcher package's npm trusted publisher
for **`publish-cli-bootstrap.yml`**, then run **Publish npm CLI bootstrap** once.
The initial bootstrap version `0.1.0` supersedes the existing `0.1.0-nightly.*`
npm versions. For a fork with newer published versions, choose a higher bootstrap
version first. Existing packages and historical npm versions remain available;
no platform packages are published going forward. Their trusted publishers can
be removed, as can the launcher's old release-workflow publishers.

Existing installations can continue using `kiln update` without reinstalling.
`npm install --global kiln-cli@latest` migrates to the bootstrap. No package is
published merely by merging this change; perform the one-time publish before
expecting new npm installs to use the bootstrap.

See [forking and publishing](forking.md#publish-the-cli) for first-time npm setup.
Native CI checks exercise packed npm installation with disabled lifecycle scripts,
GitHub bootstrap downloads, self-update while the binary is running, npm
reinstallation, and standalone updates on all five targets.
