# Versioning and updates

Kiln publishes Hearth and Relay together from the public
[`kiln-site/kiln`](https://github.com/kiln-site/kiln) repository. GitHub
Releases is the release index and GHCR is the only image source.

## Versions and channels

- The active publishing line comes from the `RELEASE_LINE` repository variable.
  `release.json` is only a local-development fallback; any major version is supported.
- Every successful push to `main` reserves a
  `<major>.<minor>.<patch>-nightly.<YYYYMMDD>.<HHMMSS>` version from the source commit's UTC
  timestamp.
- GitHub release titles keep a shorter display alias such as
  `v0.1.0 Nightly #12`. The alias is presentation-only; tags, manifests,
  images, update comparisons, and links use the timestamp version.
- Nightlies are GitHub prereleases. A stable release promotes a selected
  nightly without rebuilding its images.
- After stable promotion, maintainers set `RELEASE_LINE` to the next desired
  line in repository settings. The workflow never commits release bookkeeping.
  Display aliases use the workflow run number and no longer reset.

Published image tags:

| Tag                             | Meaning                   |
| ------------------------------- | ------------------------- |
| `0.1.0-nightly.20260726.155759` | Exact nightly             |
| `latest-nightly`                | Newest nightly            |
| `0.1.0`                         | Exact stable release      |
| `latest`                        | Newest stable release     |
| `sha-<commit>`                  | Source-build traceability |

Before the first stable release, `latest` temporarily follows the newest
nightly so a new installation has a usable default. Stable promotion takes
over that tag permanently.

Each GitHub release includes `release-manifest.json`, which binds the release
version and source commit to immutable Hearth and Relay image digests. Runtime
release discovery and image pulls are anonymous. CI verifies that both GHCR
images are publicly readable before it publishes a GitHub release.

Migrated releases may also include `imageVersion`, which records the legacy
version baked into an existing image. Hearth and Relay use that alias only to
match the unchanged image to its canonical timestamp release.

## Update eligibility

The Updates page is available to platform administrators at `/infra/updates`.
The normal Servers page is at `/infra/servers`; `/servers` remains a redirect.

One-click updates are enabled only when all of these are true:

1. The target is a Hearth or Relay image from the configured distribution.
2. Its configured image is `:latest` or `:latest-nightly`.
3. A paired Relay can access the target's Docker daemon.
4. The selected release has a valid public release manifest.

Exact version tags, digest pins, locally built images, and unsupported registries
remain externally managed. Kiln explains why their update button is disabled.
To persist a downgrade, pin the older version in the external Compose or
Coolify configuration; an in-panel downgrade alone can be replaced by the next
external deployment.

Hearth itself does not receive the Docker socket. A co-located Relay performs
its update. Relay updates use the Relay's own socket.

## Container replacement

Relay pulls the selected immutable digest and verifies its image labels. It
then launches a short-lived updater from the selected Relay digest. The helper:

1. Inspects the current container.
2. Stops it gracefully and renames it as a rollback copy.
3. Creates the replacement with the existing environment, mounts, labels,
   ports, restart policy, and Docker networks.
4. Waits for the replacement health check.
5. Removes the rollback copy on success, or restores it on failure.

Update operation state lives in the Relay data volume, so a Relay can report
the outcome after replacing itself. Hearth polls through disconnects and shows
that it is waiting for reconnection. Hearth's existing Relay connection state
continues to mark instances offline while Hearth is unavailable.

Coolify remains free to manage the same containers. Kiln does not call the
Coolify API and does not modify its project configuration. A later Coolify
deployment is authoritative and may reapply the tag configured there.
Pushes to `main` publish a nightly but no longer trigger provider deployment
webhooks. Existing installations that relied on push-to-deploy must update
through `/infra/updates` or redeploy through their provider.

## Relay provisioning policy

Relays allow new server provisioning by default. Set
`KILN_RELAY_ALLOW_PROVISIONING=false` only on a Relay that should provide
host-level update support without accepting new servers. Hearth omits that
Relay from the add-server selector, and Relay also rejects direct create
requests.

## Release operations

With `PUBLISH_IMAGES=true`, default-branch pushes publish through
`nightly-release.yml` after code checks pass. Promote the newest nightly in its
release line through `stable-release.yml`, supplying the nightly version without
`v`. Then change `RELEASE_LINE` in repository settings when ready for the next line.

Promotion reuses the nightly's exact image digests and creates a stable tag at its
source commit. CLI publishing follows the resulting app release tag. Retries do
not rewrite already published image digests. No workflow writes to `main`.

See [forking and publishing](forking.md) for repository settings, package identity,
GHCR visibility, npm trust, and the changes from the previous release workflow.

When a release changes the Relay control protocol, update Hearth first. The
transitional Hearth release must continue speaking the previous Relay protocol
long enough to update the fleet; Relay updates remain blocked until the running
Hearth recognizes the manifest protocol.
