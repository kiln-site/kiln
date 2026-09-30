# CLI publishing

CLI publication follows the exact app release tag after **Nightly release** or
**Stable release** succeeds. **Publish CLI** also supports manual retries with an
existing release tag. Set `NPM_PACKAGE` to enable it; both nightly and stable
versions retain the `latest` npm tag.

The package name, repository metadata, default panel URL, and self-update package
are resolved at build time. Forks do not edit `apps/cli/package.json` or workflow
files to rename their published package.

See [forking and publishing](forking.md#publish-the-cli) for npm bootstrap,
trusted-publisher configuration (including the calling workflows), and examples.
