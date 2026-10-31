---
title: Publish your own distribution
description: Build and publish your own Hearth, Relay, CLI, and Ember images from a public GitHub fork of Kiln.
---

A public GitHub fork of Kiln can publish its own images and `kiln` command,
and its installations update from its releases. Setup lives in the fork's
GitHub settings, so merging upstream stays clean. Releases and GHCR images must
be public.

## Set up the fork

In **Settings → Secrets and variables → Actions → Variables**, add:

| Variable | Purpose |
| --- | --- |
| `PUBLISH_IMAGES` | `true` to publish. Unset, workflows only check and build. |
| `INITIAL_RELEASE_LINE` | Version to start from before your first stable release. Default: `0.1.0` |
| `NPM_PACKAGE` | Your npm package for the CLI, such as `@your-npm-org/my-panel-cli` |
| `CLI_DEFAULT_URL` | Optional panel address built into your CLI |
| `BUILD_RUNNER_AMD64`, `BUILD_RUNNER_ARM64` | Optional runner labels |
| `OTEL_*` | Optional [telemetry](#telemetry) built into your images |

Workflows need `contents: write`, `packages: write`, and for npm
`id-token: write`. No personal token is needed.

## Publish a release

1. Enable Actions and set the variables.
2. Run **Ember images** once.
3. Run **Nightly release** on `main`.
4. Make each new GHCR package **public**, then run the nightly again if it
   stopped because Hearth or the Relay couldn't be pulled anonymously.

Images are named after the repository, such as
`ghcr.io/example/my-panel/hearth`. Each push to `main` then publishes a
nightly. For a stable release, run **Stable
release** with the nightly's version, without the `v`, and `next_release`, such
as `0.2.0`.

## Install it

Download `distribution.env` from a release. In a checkout of your fork, copy
`.env.example` to `.env`, set `KILN_URL`, and run:

```sh
docker compose --env-file .env --env-file distribution.env up -d
```

Installations update only from your releases, and game servers use the Brick
catalog on your fork's `main`. Switching an installation between distributions
isn't supported.

Kiln's Terms and Privacy don't cover your panel. Publish your own at `/terms`
and `/privacy` and set `KILN_MARKETING_URL` to that site.

## Publish the CLI

The CLI's builds attach to each release. To publish it on npm:

1. Set `NPM_PACKAGE`, and set `apps/cli/npm/version.json` above any version
   you've published.
2. Publish the installer once:

   ```sh
   KILN_GIT_REPO=https://github.com/example/my-panel \
   KILN_CLI_PACKAGE=@your-npm-org/my-panel-cli \
     vp run -F kiln-cli build:npm
   npm publish ./apps/cli/dist/npm --access public --tag latest
   ```

3. On npm, add a [trusted publisher](https://docs.npmjs.com/trusted-publishers/)
   for your repository and `publish-cli-bootstrap.yml`.

The command is still `kiln`, so install one distribution's CLI at a time.

## Telemetry

Your images report nowhere unless you set `OTEL_EXPORTER_OTLP_ENDPOINT` and,
optionally, the other `OTEL_*` variables in the fork.

> [!CAUTION]
> These values ship inside every public image. Headers must grant only write
> access to telemetry.

## Merge upstream

Merge Kiln's changes as usual, keeping upstream's workflows, Dockerfiles, and
release scripts.
