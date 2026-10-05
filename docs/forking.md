# Publishing an independent Kiln distribution

A public GitHub fork can run checks without publisher credentials, then opt into
publishing its own Hearth, Relay, CLI, and Ember images. Configuration lives in
GitHub repository settings and the deployment environment, not in fork-specific
workflow edits. Keep the shared workflow files when merging upstream.

This supports public GitHub releases and public GHCR images. Private registries,
private release feeds, and replacing GitHub with another forge are outside this
workflow. Custom application changes can still cause ordinary merge conflicts.

## Repository settings

Under **Settings → Secrets and variables → Actions → Variables**, configure:

| Variable               | Purpose                                                                                                  | Kiln upstream value                |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `PUBLISH_IMAGES`       | Set to `true` to publish releases and images. Unset means checks/builds only.                            | `true`                             |
| `INITIAL_RELEASE_LINE` | Optional starting version before the first stable promotion; defaults to `0.1.0`.                        | Leave unset                        |
| `NPM_PACKAGE`          | npm package you own. Enables npm publishing; CLI release downloads are always attached.                  | `kiln-cli`                         |
| `CLI_DEFAULT_URL`      | Optional default panel URL embedded in the CLI. Fork builds without this require a URL or saved profile. | `https://kiln.site`                |
| `BUILD_RUNNER_AMD64`   | Optional Linux x64 runner label for push-triggered image builds and all native CLI checks/builds.        | `blacksmith-4vcpu-ubuntu-2404`     |
| `BUILD_RUNNER_ARM64`   | Optional Linux ARM64 runner label for push-triggered image builds and all native CLI checks/builds.      | `blacksmith-4vcpu-ubuntu-2404-arm` |
| `SENTRY_DSN`           | Optional server telemetry DSN baked into published images.                                               | Your server DSN                    |
| `VITE_SENTRY_DSN`      | Optional browser telemetry DSN baked into Hearth.                                                        | Your browser DSN                   |
| `SENTRY_ORG`           | Optional source-map upload organization.                                                                 | `quartzdev`                        |
| `SENTRY_PROJECT`       | Optional source-map upload project.                                                                      | `kiln`                             |

Source-map uploads also require the `SENTRY_AUTH_TOKEN` Actions **secret**. Both
organization and project must be set to prepare/upload maps. Sentry upload
failures remain non-blocking. No upstream telemetry destination is a fallback.
Explicit deployment environment values override baked server configuration;
Compose's `SENTRY_DSN` defaults to empty, so set it in `.env` to enable server
telemetry. Browser telemetry requires an image rebuild to change.

Normal GitHub `ubuntu-24.04` / `ubuntu-24.04-arm` runners are the default.
Image PRs, manual image runs, and scheduled image builds retain GitHub runners.
Linux native CLI checks and release builds use the configured runners for every
trigger, including PRs and manual retries. macOS and Windows CLI jobs retain their
platform-specific GitHub runners. npm publishing uses a GitHub-hosted runner.

Workflows request `contents: write`, `packages: write`, and, for npm, `id-token:
write` where needed. Organization policies must permit those permissions.
Publishing does not need a personal GitHub token, release bot bypass, or permission
to commit to the default branch. Allow the pinned actions used by these workflows.

## Images and deployment identity

For `example/my-panel`, builds use:

```text
ghcr.io/example/my-panel/hearth
ghcr.io/example/my-panel/relay
ghcr.io/example/my-panel/bricks-java
ghcr.io/example/my-panel/bricks-steamcmd
```

Kiln upstream keeps its existing `ghcr.io/kiln-site/<component>` names and legacy
source labels so installed Relays can still update. Fork source labels point to
the fork. Image names are lowercase; source repository identity preserves GitHub's
canonical spelling.

1. Enable Actions in the fork and set the variables above.
2. Run **Ember images** manually once to seed the runtime images.
3. Run **Nightly release** on `main`.
4. Make each new GHCR package **public** and grant the repository Actions access
   if it was previously created elsewhere. Repository visibility does not make
   packages public. The nightly release deliberately fails before publication
   if Hearth or Relay cannot be pulled anonymously; rerun after fixing visibility.
5. Download `distribution.env` from your release. Prepare `.env` from
   `.env.hearth.example`, including the normal database/auth/bootstrap secrets
   and public hostnames, then deploy from your fork checkout:

```sh
docker compose --env-file .env --env-file distribution.env up -d
```

The release asset supplies `KILN_GIT_REPO` and `KILN_IMAGE_PREFIX`, so Compose
pulls the fork's images. `KILN_IMAGE_TAG` defaults to `latest`; use
`latest-nightly` for the nightly channel. Exact versions and digest pins remain
externally managed and do not enable in-panel updates.

Hearth and Relay images also embed the repository identity as a fallback when
runtime overrides are empty. Set the same explicit `KILN_GIT_REPO` on both if
overriding it. Merely switching repositories is not a supported in-place migration
between distributions: deploy that distribution's matching Hearth and Relay first.

The updater validates the configured distribution's exact image repositories,
immutable digests, source labels, component labels, versions, and protocol. It
never accepts upstream images just because a fork's manifest names them.

The default catalog follows `apps/bricks/catalog.yml` on the fork's `main` branch.
Its bundled Java/SteamCMD references are resolved to the fork's Ember namespace,
without editing recipes. An explicit `KILN_BRICKS_CATALOG_URL` retains that
catalog's original images; use this to intentionally share upstream or another
catalog. Existing server image selections are not automatically rewritten.

## Publish the CLI

Choose an available npm name, such as `@your-npm-org/my-panel-cli`. Your npm scope
can differ from your GitHub owner. The generated package records the fork's
repository and optional default panel URL. Native binaries embed this repository
as their update source. The command is still named `kiln`, so install one
distribution globally at a time.

Bootstrap the launcher and five platform package names once using your own npm
login. Platform package names append `-linux-x64`, `-linux-arm64`, `-darwin-x64`,
`-darwin-arm64`, and `-windows-x64` to your chosen package name. On each supported
platform, build and publish its package (or publish the matching platform tarball
from a GitHub release):

```sh
KILN_GIT_REPO=https://github.com/example/my-panel \
KILN_CLI_PACKAGE=@your-npm-org/my-panel-cli \
KILN_VERSION=1.0.0-test.20260930.000000 \
  vp run -F kiln-cli build
npm publish ./apps/cli/dist/npm-platform --access public --tag test
# After all five platform packages exist at that version:
npm publish ./apps/cli/dist/npm --access public --tag test
```

On npm, configure GitHub trusted publishers on **all six packages** for your
owner/repository and these workflow filenames, allowing `npm publish`:

- `nightly-release.yml` for continuous releases;
- `stable-release.yml` for stable promotions;
- `publish-cli.yml` for manual retries.

npm validates the **calling** workflow when using a reusable workflow. Keep the
existing `publish-cli.yml` publisher on Kiln and add the other two; no npm token is
needed in GitHub. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

Install with `npm install --global @your-npm-org/my-panel-cli`, with optional
dependencies enabled. `kiln update` downloads the matching native executable from
your fork's GitHub releases, preserving the stable/nightly channel; it never
invokes a package manager. `npm install --global @your-npm-org/my-panel-cli@latest`
continues to install from npm. Set `KILN_GIT_REPO` for local builds; release workflows
set it to their own repository automatically. Login uses an explicit URL,
`KILN_URL`, the selected saved profile, then the build's default URL. Forks with
no default get an instruction to supply their panel URL. Credentials remain
scoped to the existing URL/profile system.

## Everyday PR and release workflow

- Open and update PRs normally. **Code checks** runs directly on PRs; **Container
  images** validates both architectures without publishing release images.
  With `PUBLISH_IMAGES=true`, PRs from the same repository log in to GHCR and
  refresh its build caches. Fork PRs and Dependabot PRs do not log in or upload
  caches. Ember changes also run their existing recipe/image checks. PR and Ember
  configuration does not fetch release history or manifests.
- Build caches use the image namespace, for example
  `ghcr.io/example/my-panel/hearth-build-cache:amd64`. Kiln keeps its existing
  `ghcr.io/kiln-site/hearth-build-cache:amd64` location. Release builds reuse these
  caches without uploading them. A missing cache does not prevent a build; make
  cache packages public if external PRs should be able to reuse them anonymously.
- Pushes to `main` run the same code checks. With publishing enabled, image
  builds run in parallel, but a discoverable release and rolling tags are only
  published after checks succeed. Failed validation may leave untagged build
  digests, never a new installable release.
- Nightly versions use the next line recorded in the latest stable release plus
  the commit's UTC timestamp. Before the first stable, `INITIAL_RELEASE_LINE`
  optionally overrides the `0.1.0` default. Display
  numbers use the workflow run number; they no longer reset at each release line.
- CLI publication follows the exact app release tag. It no longer publishes
  independently while the corresponding app build might still fail. As before,
  both nightly and stable CLI publications use npm's `latest` tag.
- Stable promotion accepts the newest nightly in the chosen release line and a
  `next_release` version, just like the previous promotion form.
  It reuses image digests, verifies provenance metadata in the release manifest,
  and does not rebuild app images or write commits to `main`.
- Nightly and stable runs share a queue (up to 100 pending runs), so later
  pushes do not replace a waiting promotion. Run both workflows from `main`.
- Promotion records `nextReleaseLine` in the stable release manifest. Subsequent
  nightlies automatically use that line; no repository-settings change or extra
  token is required. Retry a promotion with the same `next_release` value.
- When migrating a repository whose latest stable manifest lacks this field,
  the next line defaults to its next patch version. `INITIAL_RELEASE_LINE` can
  select a higher starting version once; after promotion, release metadata takes
  precedence over that bootstrap setting.
- Retrying a release preserves published image digests. A retry can finish
  rolling-tag updates after a partial failure. Use **Publish CLI** with the exact
  release tag to retry CLI release downloads and npm separately.
- Nightly configuration resolves the version only on the initial attempt. For
  downstream failures, use **Re-run failed jobs** to reuse the successful
  configuration job's outputs. Full nightly reruns, or rerunning configuration
  itself, stop with **Start a new Nightly release from main.** Start a fresh
  workflow run from `main` in those cases. No run metadata or permanent run tags
  are stored.
- Required PR check names are now `Static checks`, `Tests`, and `Build`, rather
  than the nested code-check job names under Container images. Update rulesets
  referencing the old names. Image-check job names remain separate.

For Kiln, the inspected **Protect Main** ruleset currently requires PRs but has
no required-status-check rule, so no check-name migration is currently necessary.
Review this again if rules change before merge.

## Merging upstream

Merge or rebase upstream normally. Keep upstream's workflows, Dockerfiles, and
release scripts. Your repository variables, npm trust configuration, GHCR packages,
GitHub release history, and deployment `.env` are independent of that merge.
`release.json` is a shared local-development fallback; CI never updates it and
publishing reads that repository's stable release metadata instead. Its version
is intentionally not kept in sync with published releases.

Public fork distribution tests cover version continuity, image/provenance
boundaries, catalog image mapping, CLI login precedence, and fork update planning.
Live publishing still depends on each account's GHCR/npm permissions. A release
check should include installing one version and updating to the next with that
fork's own public artifacts.
