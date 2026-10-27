---
title: Deploy your first app
description: Deploy an app from a GitHub repository or a Docker image, then serve it at your own domain over HTTPS.
---

This tutorial deploys an app, either built from a GitHub repository or pulled
as a Docker image, and then serves it at a domain of yours with HTTPS.

## Before you start

- **A Relay to run the app.** The machine you
  [installed Kiln](/get-started/install) on has one.
- **For a domain, a Relay that runs Traefik.** Domains need the Relay's
  **Proxy mode** to be **Bundled Traefik** or **Coolify Traefik**. Machines you
  add with Hearth's install command run Bundled Traefik when ports 80 and 443
  are free. The Relay that installed Kiln uses **Hearth proxy** mode, which
  doesn't serve app domains. To check a Relay, open it and look at **Proxy** on
  its **Info** page.

## Deploy from GitHub

Kiln reads your repository through a GitHub source: a private GitHub App that
Kiln creates for your account or organization.

### Connect GitHub

1. In the sidebar, open **Apps**, choose **Add App**, and keep **GitHub**
   selected. Until you connect an account, the dialog says "Connect a GitHub
   account first." Choose **Add a source**.
2. On **Sources**, choose **Add source**. Under **Where are your repositories?**, choose **Personal account** or
   **Organization**, and give the **App name**, which must be unique on GitHub.
3. Choose **Continue to GitHub**. Confirm the app there, then install it on
   the repositories Kiln should read.

GitHub sends you back to **Sources**. See [Deploy from GitHub](/apps/github).

### Create the app

1. In the sidebar, open **Apps** and choose **Add App**.
2. Under **Type**, choose **GitHub**.
3. Give it a **Name** and pick its **Relay**.
4. Choose the **Source**, **Repository**, and **Branch**.
5. Under **Build**, choose **Dockerfile** to build one container, or **Docker
   Compose** to run every service in a Compose file. Change the path if the
   file isn't `Dockerfile` or `compose.yaml` at the repository's root.
6. Leave **Deploy on push** on to deploy every new commit on the branch.
7. Choose **Create and deploy**.

Kiln downloads the branch, builds it on the Relay, and starts it.

## Deploy a Docker image

1. In the sidebar, open **Apps** and choose **Add App**.
2. Under **Type**, choose **Docker**.
3. Give it a **Name**, pick its **Relay**, and choose **Create app**.
4. On the app's **Info** page, find **Brick** and choose **Configure**.
5. Choose **Image**, and enter the **Image and tag**, such as `nginx:latest`.
   Kiln pulls it from Docker Hub or any registry the Relay can reach.
6. Choose **Save and deploy**.

## Watch it deploy

Kiln opens the app's **Logs** page on **Deployment**, so you can follow the
build and start. The **Deployment** card on the app's **Info** page shows
whether the last deployment succeeded.

To deploy again, choose **Deploy** at the top of the app's page.

When the app is already running, a deployment starts the new containers beside
the old ones and switches over only once they're healthy. If they fail, the old
ones keep serving.

## Add a domain

1. Point your domain's DNS at the machine the app's Relay runs on, with an `A`
   record for its IP address.
2. Open the app's **Network** page. Under **Web routes**, choose **Add route**.
3. Keep **Serve**, and enter the **Domain**.
4. Choose the **Service** and the **Port** the app listens on inside its
   container.
5. Choose **Add route**.

Traefik gets a Let's Encrypt certificate for the domain, and **Redirect HTTP to
HTTPS** is on by default. A route shows **Live** when it's serving, or
**Pending deploy** when the app needs a deployment to pick it up; choose
**Deploy to apply**. The first route becomes the app's primary domain, shown in
its header. See [Domains](/apps/domains).

## Next steps

- Set environment variables from **Environment** on the app's **Info** page.
- Keep data across deployments with **Volumes**. Containers keep nothing from
  one deployment to the next.
- [Add a database](/databases) next to the app.
