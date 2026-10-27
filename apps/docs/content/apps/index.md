---
title: Apps
description: Run websites, APIs, and other containers on a Relay, built from GitHub or pulled as a Docker image, with zero-downtime deployments.
---

An app is anything you run in Docker that isn't a game server or a database: a
website, an API, a bot, a dashboard. Each app runs on one Relay, in containers
of its own, on a private network of its own.

## Ways to deploy

An app deploys from one of four sources. You choose one when you create the
app, and you can switch later from **Configure** in the app's **Brick** section.

| Source         | What Kiln runs                                                         |
| -------------- | ---------------------------------------------------------------------- |
| **GitHub**     | A repository branch, built from its Dockerfile or run from its Compose file |
| **Image**      | A Docker image pulled from Docker Hub or another registry               |
| **Dockerfile** | A Dockerfile you paste into Hearth, built on the Relay                   |
| **Compose**    | A Compose file you paste into Hearth, with every service it lists       |

An app keeps each source's settings when you switch, so switching back loses
nothing. Only the selected one deploys.

- [Deploy from GitHub](/apps/github)
- [Deploy an image, Dockerfile, or Compose file](/apps/images-and-compose)

## Create an app

1. Open **Apps** and choose **Add App**.
2. Under **Type**, choose **GitHub** or **Docker**.
3. Enter a **Name** and choose the **Relay** to run it on.
4. For **GitHub**, choose the repository and build, then **Create and deploy**.
   For **Docker**, choose **Create app**, then pick what it runs on its
   **Info** page.

Hearth creates the app with its own network and data folder on the Relay, then
opens the app.

## How a deployment runs

Choose **Deploy** at the top of an app's page, or on its row in **Apps**, to
deploy what the app's settings say now. Most changes to an app apply on its
next deployment, and the dialogs that make them offer **Save and deploy**.

When the app is already running, a deployment starts the new containers beside
the old ones. Each new container must stay up for a short settle and pass its
Docker health check, within ten minutes. Only then does traffic move to it and
the old containers stop. If the new containers fail, Kiln removes them and the
old ones keep serving.

A container without a health check counts as ready once it settles. Give your
image a `HEALTHCHECK`, or a Compose service a `healthcheck`, so traffic only
moves to a copy that works.

A Compose project switches over as a whole: every service must be healthy, or
have exited cleanly, before any traffic moves.

### When the old containers stop first

Two copies of an app can't always run at once. The old containers stop before
the new ones start when:

- the app publishes ports on the Relay, or has a Tailscale address;
- the app mounts a volume or a path on the node read-write;
- a Compose service keeps data in a volume, or uses another network mode;
- the node doesn't have the memory to hold both copies.

The deployment log says which. The app is down while the new containers start.

> [!WARNING]
> Containers keep nothing from one deployment to the next. Keep data an app
> needs in a volume from its **Volumes** section. See
> [Volumes](/apps/settings#volumes).

## Deployment history

**Deployments**, under Infrastructure, lists every app's deployments, newest
first, across the Relays you can see. To see one app's, choose **History** on
the **Deployment** card of its **Info** page.

Each row shows the app, the commit or image, what started it, when, and how
long it took. A deployment's status is **Deploying**, **Deployed**, **Failed**,
or **Unknown** when its Relay restarted partway through.

- Choose **Log** to read the deployment's log. The Relay keeps the logs of each
  app's 20 latest deployments.
- From **More actions**, choose **Deploy this commit again** on a GitHub
  deployment to roll back to that commit. On an image deployment, **Redeploy**
  deploys the exact image it ran.

To follow a deployment live, open the app's **Logs** page and choose
**Deployment**. Hearth takes you there when you deploy.

## Start, stop, and delete

**Start**, **Stop**, and **Restart** act on the app's current containers
without deploying. They appear once the app has been deployed.

To delete an app, choose **Delete app** at the bottom of its **Info** page.

## Next steps

- [Domains and HTTPS](/apps/domains)
- [App settings](/apps/settings): environment, ports, volumes, and a terminal
- [Image updates](/apps/updates)
- [Connect a database](/databases/connect)
