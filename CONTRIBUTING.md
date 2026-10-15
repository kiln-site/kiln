# Contributing to Kiln

Thanks for contributing.

## License

Kiln uses a dual-license model from **Marco Technology Consulting Inc.
(“QuartzDev”)**:

- **Open source:** [GNU Affero General Public License v3.0 (AGPL-3.0)](./LICENSE)
- **Commercial option:** a paid [Kiln Commercial License](./COMMERCIAL_LICENSE.md)
  for organizations that need proprietary derivative-work rights or cannot
  comply with AGPL copyleft

This covers the software in this repository, including Hearth, Relay, Bricks,
Embers, and related components.

## Contributor License Agreement (CLA)

Every external contributor must sign the [CLA](./CLA.md) before a pull request
can be merged. The CLA is with Marco Technology Consulting Inc. (“QuartzDev”)
and is based on the Apache Software Foundation CLA.

By signing, you keep copyright in your contributions, and grant QuartzDev a
license to use and sublicense them under both AGPL-3.0 and the Commercial
License. That is what lets commercial customers receive community fixes in
closed-source distributions.

Signing is handled by [CLA Assistant](https://cla-assistant.io) on GitHub. When
you open a PR, the bot prompts you to review and sign the CLA. Do not open a
PR until you are willing to sign. If your employer owns your work, get
permission first (see CLA §4).

Maintainers: enable the repo at [cla-assistant.io](https://cla-assistant.io)
and point it at this repository’s `CLA.md`.

## Development

See the [development guide](docs/development.md) for setup, running the Docker
stack, and worktree cleanup.

## Pull requests

1. Sign the CLA when CLA Assistant prompts you on the pull request.
2. Keep changes focused and consistent with existing patterns.
3. Prefer browser validation for UI work over large speculative test suites.
4. Name branches `<type>/<short-kebab-case-task>` (for example,
   `fix/panel-disconnect` or `chore/repo-cleanup`), without personal or agent prefixes.
   Use a short, human PR title in `<type>(<scope>): <title>` format. Scopes are
   `hearth`, `bricks`, `relay`, and `repo` for repo-wide changes.
5. Use this description format:

   ```md
   # Why

   What it fixes or implements. Link an issue when one exists.

   # Summary

   Brief summary.

   # Notes

   Breaking changes, compatibility notes, migration steps, or anything else reviewers need to know.
   ```

6. Keep the description unchanged during review unless the overall PR changes.

Questions about licensing or the CLA: **contact@kiln.site**.
