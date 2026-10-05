# CLI publishing

CLI publication follows the exact app tag after **Nightly release** or
**Stable release** succeeds. Every platform compiles once. The same signed binary
is copied into its GitHub archive, its raw update asset, and its npm package.

Release assets include:

- `kiln-<tag>-linux-{x64,arm64}` and matching `.tar.gz` archives;
- `kiln-<tag>-darwin-{x64,arm64}` and matching `.tar.gz` archives;
- `kiln-<tag>-windows-x64.exe` and a matching `.zip` archive;
- the main npm tarball and all five platform npm tarballs.

Archives include the README and license files. macOS executables have ad-hoc
signatures and are not notarized; the README explains browser quarantine handling.
The updater downloads raw executables and verifies the SHA-256 digest supplied
by GitHub's release API before installing them.

## npm packages

`NPM_PACKAGE` names the launcher package (for example `kiln-cli` or
`@example/panel-cli`). Its optional dependencies are that name plus each suffix:
`-linux-x64`, `-linux-arm64`, `-darwin-x64`, `-darwin-arm64`, `-windows-x64`.
Each platform package includes only that platform's executable and declares
npm `os`/`cpu` constraints. All six package names need npm publishing access and
trusted-publisher configuration. Publish platform packages before the launcher.

The launcher copies its platform binary into its own `native/` directory, never
hard-linking it to the package-manager store. A postinstall script prepares it;
first launch also prepares it when install scripts are disabled. Node.js is used
only by this npm launcher; the application runs from the standalone executable.
`kiln update` replaces that private executable directly from GitHub. A later npm
installation selects npm's version again, and does not use GitHub for downloads.

`vp run -F kiln-cli build` produces the native executable, `dist/npm-platform`,
and `dist/npm`. `vp run -F kiln-cli build:npm` prepares only the launcher package,
without compiling again. Release jobs cache dependencies and install only the
CLI workspace and its dependencies. The final publisher downloads the previously
packed platform packages; it does not install workspace dependencies or rebuild.

## Updates and configuration

`KILN_GIT_REPO` selects the source/update GitHub repository at build time, accepting
an HTTPS URL or `owner/repository`. Workflows set it from `github.repository`.
The value is compiled into the executable: runtime environment variables cannot
redirect it. `KILN_VERSION` determines the installed stable/nightly channel.
`KILN_CLI_PACKAGE` selects the npm name, and `KILN_CLI_DEFAULT_URL` selects the
default Hearth URL. Forks do not need to edit source files.

**Publish CLI** supports retries with an existing release tag, replacing matching
GitHub assets and skipping already-published npm versions. Downloads are built
when `NPM_PACKAGE` is unset; setting it also enables npm publication. Stable and
nightly npm publications retain the existing `latest` npm tag.

Before merging the first native-package release, bootstrap the five new platform
names and configure the same trusted publishers as the existing launcher package.
See [forking and publishing](forking.md#publish-the-cli). Native CI checks validate
npm installation (including disabled lifecycle scripts), self-update while the
binary is running, npm reinstallation, and standalone updates on all five targets.
