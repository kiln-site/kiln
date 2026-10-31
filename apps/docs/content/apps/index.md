---
title: Apps
description: Run websites, APIs, and other containers on a Relay, built from GitHub or a Dockerfile, or pulled as an image, with zero-downtime deployments.
---

An app is anything you run in Docker that isn't a game server or a database: a
website, an API, a bot. Each app runs on one Relay, on a private network of its
own, from one source: a **GitHub** branch, a Docker **Image**, or a
**Dockerfile** or **Compose** file you write in Hearth. Switch sources later
with **Configure** in the app's **Brick** section; each keeps its settings.

## Deploy from GitHub

First connect GitHub. Kiln reads repositories through a **source**, a private
GitHub App it creates for your account or organization.

1. Open **Sources**, under Infrastructure, and choose **Add source**.
2. Choose **Personal account** or **Organization**, and enter an **App name**
   that's unique on GitHub. An organization needs one of its owners.
3. Choose **Continue to GitHub**, confirm the app, and install it on the
   repositories Kiln may read.

Then create the app:

1. Open **Apps** and choose **Add App**. Keep **GitHub**.
2. Enter a **Name** and choose the **Relay**.
3. Choose the **Source**, **Repository**, and **Branch**. If a repository is
   missing, choose **Give the app access on GitHub**.
4. Under **Build**, choose **Dockerfile** to build one container from the whole
   repository, or **Docker Compose** to run every service in a Compose file.
   Change the path if it isn't `Dockerfile` or `compose.yaml` at the root.
5. Choose **Create and deploy**.

With **Deploy on push** on, each new commit deploys; pushes during a deployment
wait, and only the newest deploys. Without a public HTTPS address for Hearth,
Kiln checks the branch every minute instead.

> [!CAUTION]
> Deploy on push lets anyone who can push to the branch run code on your
> Relay, including a Compose file that mounts paths on the machine. Protect the
> branch, or turn it off, for repositories others can write to.

## Deploy an image, Dockerfile, or Compose file

1. Open **Apps**, choose **Add App**, and choose **Docker**.
2. Enter a **Name**, choose the **Relay**, and choose **Create app**.
3. On the app's **Info** page, choose **Configure** in the **Brick** section.
4. Choose a source:
   - **Image**: enter the **Image and tag**, such as `nginx:latest`. For a
     private registry, see [Private registries](/relays/host#private-registries).
   - **Dockerfile** or **Compose**: choose **Save**, then write the file from
     its button under **Build Strategy**.
5. Choose **Save and deploy**.

A Dockerfile builds with the app's **Files** page as its context. In a Compose
file, services reach each other by name, `${KEY}` reads the app's
[environment variables](/apps/settings#environment-variables), and listed ports
are published on the Relay.

## Deployments

Choose **Deploy** at the top of an app's page to deploy its current settings.
Hearth opens the app's **Logs** page on **Deployment** so you can follow it.

A running app switches over without downtime: new containers start beside the
old ones, and traffic moves once they pass their Docker health check. If they
fail, the old ones keep serving. Give your image a `HEALTHCHECK`; without one,
a container counts as ready once it settles.

The old containers stop first, and the app is briefly down, when the app
publishes ports, has a Tailscale address, mounts a volume or node path
read-write, or the node lacks memory for two copies. The deployment log says
which.

> [!WARNING]
> Containers keep nothing between deployments. Keep data in
> [Volumes](/apps/settings#volumes).

## History and rollback

**Deployments**, under Infrastructure, lists every app's deployments; for one
app, choose **History** on its **Deployment** card. Each has a **Log**, kept for
the app's 20 latest deployments.

To roll back, open **More actions** on an older deployment and choose **Deploy
this commit again**, or **Redeploy** for an image. A GitHub app stays on that
commit until a new one lands.

**Start**, **Stop**, and **Restart** act on the current containers without
deploying. **Delete app** is at the bottom of the **Info** page.

Next: [Domains and HTTPS](/apps/domains), [App settings](/apps/settings), and
[connecting a database](/databases#connect-an-app).
