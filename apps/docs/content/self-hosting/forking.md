---
title: Publish your own distribution
description: Build and publish your own Hearth, Relay, CLI, and Ember images from a public GitHub fork of Kiln, with updates from your own releases.
---

A public GitHub fork of Kiln can publish its own Hearth, Relay, `kiln` command,
and Ember images, and installations of it update from its own releases. You
configure it in the fork's GitHub settings, without editing Kiln's workflows,
so merging upstream stays clean.

This works with public GitHub releases and public images on GitHub's container
registry (GHCR). Private registries, private release feeds, and forges other
than GitHub aren't supported.

## Set up the repository

In the fork, open **Settings → Secrets and variables → Actions → Variables**
and add:

| Variable | Purpose |
| --- | --- |
| `PUBLISH_IMAGES` | `true` to publish releases and images. Unset, the workflows only check and build. |
| `INITIAL_RELEASE_LINE` | Optional version to start from before your first stable release. Default: `0.1.0` |
| `NPM_PACKAGE` | The npm package you own for the CLI's installer, such as `@your-npm-org/my-panel-cli` |
| `CLI_DEFAULT_URL` | Optional panel address built into your CLI. Without it, people give their panel's address when they sign in. |
| `BUILD_RUNNER_AMD64`, `BUILD_RUNNER_ARM64` | Optional runner labels for image and CLI builds. Default: GitHub's own runners |
| `OTEL_*` | Optional telemetry settings built into your images. See [Telemetry](#telemetry). |

Organization policies must allow the workflows to request `contents: write`,
`packages: write`, and, for npm, `id-token: write`, and must allow the actions
they use. Publishing needs no personal token.

## Publish your first release

1. Enable Actions in the fork and set the variables above.
2. Run the **Ember images** workflow once to publish the runtime images Bricks
   use.
3. Run **Nightly release** on `main`.
4. Make each new package on GHCR **public**. Making the repository public
   doesn't make its packages public. The nightly release stops before
   publishing if Hearth or the Relay can't be pulled anonymously; run it again
   once they're public.

Your images are named after the repository. For `example/my-panel`:

```text
ghcr.io/example/my-panel/hearth
ghcr.io/example/my-panel/relay
ghcr.io/example/my-panel/bricks-java
ghcr.io/example/my-panel/bricks-steamcmd
```

After that, every push to `main` publishes a nightly once its checks pass. To
make a stable release, run **Stable release** with the nightly's version,
without the `v`, and the next version to work towards, such as
`next_release=0.2.0`. It reuses the nightly's images without rebuilding them.

## Install your distribution

1. Download `distribution.env` from one of your releases.
2. In a checkout of your fork, copy `.env.example` to `.env` and set
   `KILN_URL`.
3. Start it:

   ```sh
   docker compose --env-file .env --env-file distribution.env up -d
   ```

`distribution.env` sets `KILN_GIT_REPO` and `KILN_IMAGE_PREFIX`, so Compose
pulls your Relay and the Relay installs your Hearth. `KILN_IMAGE_TAG` defaults
to `latest`; use `latest-nightly` for your nightly channel.

Installations update only from your distribution's releases. Kiln checks each
image's repository, digest, labels, and version, and never takes upstream
images only because your release names them. Switching an existing
installation between distributions isn't supported.

Game servers use the Brick catalog on your fork's `main` branch
(`apps/bricks/catalog.yml`), with its Embers pulled from your images.

## Terms and privacy

Kiln's Terms of Use and Privacy Policy don't cover your panel. Without your
own, Hearth's footer links go to a page on kiln.site that says Kiln doesn't run
your panel and to contact its operator. Publish your own terms and privacy
policy at `/terms` and `/privacy` on a site, and set `KILN_MARKETING_URL` to
it. See [Configuration](/self-hosting/configuration#hearth).

## Publish the CLI

The `kiln` command's native builds are attached to each of your GitHub
releases and update from them. For people to install it from npm:

1. Choose an npm package name, such as `@your-npm-org/my-panel-cli`, and set
   `NPM_PACKAGE`.
2. Set `apps/cli/npm/version.json` to a version newer than any you've
   published, then publish the installer package once from your machine:

   ```sh
   KILN_GIT_REPO=https://github.com/example/my-panel \
   KILN_CLI_PACKAGE=@your-npm-org/my-panel-cli \
     vp run -F kiln-cli build:npm
   npm publish ./apps/cli/dist/npm --access public --tag latest
   ```

3. On npm, add a
   [trusted publisher](https://docs.npmjs.com/trusted-publishers/) for that
   package: your repository and the `publish-cli-bootstrap.yml` workflow.
   Later updates to the installer run from **Publish npm CLI bootstrap**.

People then install it with:

```sh
npm install --global @your-npm-org/my-panel-cli
```

The command is still named `kiln`, so install one distribution's CLI at a time.

## Telemetry

Your images don't report anywhere unless you say so. To build in a telemetry
backend, set these repository variables: `OTEL_EXPORTER_OTLP_ENDPOINT`,
`OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_TRACES_EXPORTER`, `OTEL_LOGS_EXPORTER`,
`OTEL_METRICS_EXPORTER`, `OTEL_TRACES_SAMPLER_ARG`, and
`OTEL_RESOURCE_ATTRIBUTES`. Only the endpoint is required.

> [!CAUTION]
> These values ship inside every image anyone can pull, so the headers must
> grant nothing but write access to telemetry.

Installations can override them or turn telemetry off; see
[Telemetry](/self-hosting/telemetry).

## Merge upstream

Merge or rebase Kiln's changes as usual, and keep upstream's workflows,
Dockerfiles, and release scripts. Your repository variables, npm setup, GHCR
packages, releases, and deployments' `.env` files don't depend on that merge.
