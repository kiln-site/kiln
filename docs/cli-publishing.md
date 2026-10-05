# CLI publishing

CLI publication follows the exact app release tag after **Nightly release** or
**Stable release** succeeds. Each GitHub release receives the npm package tarball
(`.tgz`) and standalone CLI archives:

- `kiln-<tag>-linux-{x64,arm64}.tar.gz`
- `kiln-<tag>-darwin-{x64,arm64}.tar.gz`
- `kiln-<tag>-windows-x64.zip`

The archives contain `kiln` (or `kiln.exe`), the README, and license files.
Binaries are built and smoke-tested on their native platform; macOS binaries
use the existing ad-hoc signing step. They do not require Node.js or Bun.

**Publish CLI** supports manual retries with an existing release tag, replacing
matching release assets. Downloads are built even when `NPM_PACKAGE` is unset.
Set `NPM_PACKAGE` to also publish to npm; both nightly and stable versions retain
the `latest` npm tag, and retries skip versions already published there.

The package name, repository metadata, default panel URL, and self-update package
are resolved at build time. Forks do not edit `apps/cli/package.json` or workflow
files to rename their published package.

See [forking and publishing](forking.md#publish-the-cli) for npm bootstrap,
trusted-publisher configuration (including the calling workflows), and examples.
