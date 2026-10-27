---
title: Image updates
description: Kiln checks every hour whether an image app's tag names a newer image, then tells you or deploys it after a wait.
---

An app that runs an image, such as `nginx:latest`, keeps running the exact
image it pulled, even after the tag moves on. Kiln checks every hour whether the
tag names a newer image, and tells you or deploys it, as you choose.

Image updates apply to apps whose source is **Image**. Apps built from a
Dockerfile, a Compose file, or GitHub don't get them.

## See an app's updates

On the app's **Info** page, the **Deployment** card has an **Updates** row:

| Status | Meaning |
| --- | --- |
| **Up to date** | The app runs the image its tag names. |
| **Update available** | The tag names a newer image. |
| **Skipped** | You skipped the newer image. |
| **Check failed** | Kiln couldn't reach the registry. Hover it to see why. |
| **Deploy to apply** | The app's image changed since its last deployment. |
| **Deploy to track** | Deploy once so Kiln knows which image runs. |
| **Not deployed** / **Not checked yet** | Nothing to compare yet. |
| **Pinned to a digest** | The image names a digest, such as `nginx@sha256:…`, which never moves. |
| **Off** | Checks are off. |

Choose the status to open **Image updates**. It shows the digest the app runs,
the one **Available**, when Kiln last **Checked**, and, for automatic updates,
when the update **Deploys**. Choose **Check now** to check at once.

## Choose what happens

In **Image updates**, choose one, then **Save**:

- **Notify**, the default: Kiln tells everyone who can deploy the app, once
  per new image.
- **Automatic**: Kiln also deploys the new image once it has been out for the
  **Wait**, in days. The default is three days.
- **Off**: Kiln doesn't check.

Registries don't say when a tag moved, so the wait counts from when Kiln first
saw the new image. If the tag moves again before the wait ends, Kiln offers the
newest image and the wait starts over. Kiln never deploys an image the tag has
since moved past.

## Update now or skip

When an update is available:

- **Update now** deploys it at once, whatever the wait.
- **Skip** passes over this image. It won't notify or deploy on its own, and
  the next image the tag names is offered as usual.

An automatic update runs once per image, whether it succeeds or fails.

## Roll back an update

Open **History** on the app's **Deployment** card. On the deployment that ran
the image you want, open **More actions** and choose **Redeploy**. Kiln deploys
that exact image again, and an automatic update won't redeploy the image you
rolled back from.

## How checks work

Every hour, each Relay asks the registry which image each of its apps' tags
names, without pulling it, and compares that with what the app's container
runs. Docker Hub doesn't count these checks against its pull limits. A Relay
skips an app while it deploys. While the registry can't be reached, an
automatic update waits for a check that gets through.
