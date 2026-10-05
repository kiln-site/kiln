# CLI publishing

CLI publication follows the exact app release tag after **Nightly release** or
**Stable release** succeeds. Each GitHub release receives the npm package tarball
(`.tgz`) and standalone CLI archives:

- `kiln-<tag>-linux-{x64,arm64}.tar.gz`
- `kiln-<tag>-darwin-{x64,arm64}.tar.gz`
- `kiln-<tag>-windows-x64.zip`

The archives contain `kiln` (or `kiln.exe`), the README, and license files.
Binaries are built and smoke-tested on their native platform. They do not
require Node.js or Bun, and `kiln update` points them at the release page
instead of a package manager.

macOS binaries have only an ad-hoc signature and are not notarized. Browsers
quarantine the archive, `tar` carries the flag onto `kiln`, and Gatekeeper then
refuses to run it. The README documents downloading with `curl` or running
`xattr -d com.apple.quarantine kiln`. Notarizing would remove that step but
needs an Apple Developer account and signing secrets in CI.

**Publish CLI** supports manual retries with an existing release tag, replacing
matching release assets. Downloads are built even when `NPM_PACKAGE` is unset.
Set `NPM_PACKAGE` to also publish to npm; both nightly and stable versions retain
the `latest` npm tag, and retries skip versions already published there.

The package name, repository metadata, default panel URL, self-update package,
and the release page that standalone binaries link to are resolved at build time. Forks do not edit `apps/cli/package.json` or workflow
files to rename their published package.

See [forking and publishing](forking.md#publish-the-cli) for npm bootstrap,
trusted-publisher configuration (including the calling workflows), and examples.
