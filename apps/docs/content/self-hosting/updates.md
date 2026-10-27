---
title: Updates
description: Update Hearth and every Relay from Hearth, choose between stable and nightly releases, and see why an update is unavailable.
---

You update Kiln from Hearth. Hearth and the Relays update the same way: the
Relay on the machine pulls the new image, replaces the container, and puts the
old one back if the new one doesn't come up healthy. Game servers keep
running.

## Update from Hearth

1. Open any Infrastructure page, such as **Relays**, and choose **Updates** at
   the top.
2. The dialog checks for updates and lists the panel and each Relay, with
   "Update available", "Up to date", or why it can't update. **Check for
   updates** checks again.
3. Choose **Update** on one, or **Update all** for everything that has an
   update.
4. Choose **Confirm**. The dialog follows each update until it's done.

**Changelog** in the dialog lists what changed in each release.

Platform administrators can update everything. People who can update a Relay
see the **Updates** button for that Relay too.

> [!NOTE]
> An update that fails is rolled back: "The update failed. The previous
> container was restored." The same happens when the new container doesn't
> pass its health check in time.

A Relay finishes an update it started even if Hearth goes away partway. When
Hearth comes back, the Relays tell it how each update went.

## Stable and nightly

Kiln publishes Hearth and the Relay together, as images on GitHub's container
registry, from the [kiln-site/kiln](https://github.com/kiln-site/kiln)
repository. Each release is a
[GitHub release](https://github.com/kiln-site/kiln/releases).

| Tag | Follows |
| --- | --- |
| `latest` | The newest stable release |
| `latest-nightly` | The newest nightly, built from every change to Kiln's main branch |
| `0.1.0` | One stable release |
| `0.1.0-nightly.20260726.155759` | One nightly |

Your installation follows the tag it runs. The install script and
`compose.yaml` use `latest`; `--nightly`, or `KILN_IMAGE_TAG=latest-nightly`
with Compose, installs the nightly channel instead. A stable release is a
nightly promoted as it is, without rebuilding it.

Before the first stable release, `latest` follows the newest nightly, so a new
installation has a release to start from.

## When an update is unavailable

Hearth updates a container only when all of these are true:

- It's a Hearth or Relay image from Kiln, or from the distribution you
  installed.
- It runs the `latest` or `latest-nightly` tag. An exact version, a pinned
  digest, or a local build is managed outside Kiln, and the dialog says why it
  can't update.
- A Relay can reach the container's Docker. For Hearth, that's the Relay on the
  same machine. Without one, the dialog says "Pair a Relay running on Hearth's
  Docker host to enable updates."
- The release has a valid release manifest.
- The container belongs to this installation.

The dialog also marks a Relay that's **Offline**, a **Custom build**, and a
version **Newer than the latest release**.

> [!TIP]
> To stay on an older version, pin it where you run Kiln, such as an exact
> `KILN_IMAGE_TAG` in Compose. A downgrade made only from Hearth can be
> replaced by your next deployment.

## How an update runs

The Relay pulls the release's exact image and checks its labels, then starts a
short-lived helper that:

1. Stops the container and keeps it as a rollback copy.
2. Creates the new one with the same settings, volumes, ports, and networks.
3. Waits for it to report healthy.
4. Removes the rollback copy, or restores it if the new one failed.

Each release includes a `release-manifest.json` that ties its version and
source commit to the exact Hearth and Relay images. Kiln updates only to
images the manifest names, and only from the distribution it came from.

A platform Relay updates the Hearth it installed the same way, and never
undoes the update in its own checks.

## The kiln command

The `kiln` command updates itself, staying on the stable or nightly channel it
was installed from:

```sh
kiln update
```
