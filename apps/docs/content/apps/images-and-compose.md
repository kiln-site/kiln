---
title: Deploy an image or Compose file
description: Run a Docker image, a Dockerfile built on the Relay, or a Compose file you paste into Hearth.
---

A **Docker** app runs an image from a registry, a Dockerfile you paste into
Hearth, or a Compose file you paste into Hearth. To build from a repository
instead, see [Deploy from GitHub](/apps/github).

## Create the app

1. Open **Apps** and choose **Add App**.
2. Under **Type**, choose **Docker**.
3. Enter a **Name**, choose the **Relay**, and choose **Create app**.
4. On the app's **Info** page, choose **Configure** in the **Brick** section.
5. Choose **Image**, **Dockerfile**, or **Compose**, set it up as below, and
   choose **Save and deploy**.

**Save** keeps the change for the next deployment without deploying now.

## Image

Enter the **Image and tag**, such as `nginx:latest` or
`ghcr.io/owner/name:1.4`. The Relay pulls it on every deployment, from Docker
Hub or any registry it can reach. For a private registry, see
[Private registries](/relays/runtime#private-registries).

Kiln runs the image by digest: each deployment asks the registry which image
the tag names, pulls exactly that one, and runs it. Kiln can then tell you when
the tag moves to a newer image. See [Image updates](/apps/updates).

**Start command** replaces the image's own command. Leave it empty to use the
image's default.

## Dockerfile

Choose **Dockerfile**, then **Save**. In the **Brick** section, choose the
**Dockerfile** button under **Build Strategy** to write it, and choose **Save
and deploy**.

The Relay builds the Dockerfile with the app's files as its context, so `COPY`
can use anything you upload to the app's **Files** page.

```dockerfile title="Dockerfile"
FROM node:24-alpine
WORKDIR /app
COPY . .
CMD ["node", "server.js"]
```

## Compose file

Choose **Compose**, then **Save**. In the **Brick** section, choose the
**compose.yaml** button under **Build Strategy** to write it, and choose **Save
and deploy**.

```yaml title="compose.yaml"
services:
  web:
    image: nginx:latest
    ports:
      - 8080:80
```

Every service in the file runs as one of the app's containers:

- Services reach each other by name on the app's network.
- The app's environment variables are passed to the file, so `${KEY}` works.
  See [Environment variables](/apps/settings#environment-variables).
- Ports the file publishes are opened on the Relay. Compose apps don't use the
  **Published ports** section.
- The file's relative paths resolve from the app's folder on the Relay, the
  one its **Files** page shows.

The app's **Brick** section lists each service as a tag that shows whether its
container runs. Choose a tag to show that container in the **Container**
section.

### How a Compose app switches over

A Compose app deploys as a whole. Kiln starts a fresh copy of the project
beside the running one, with its own networks, and waits until every service
is healthy or has exited cleanly. Only then does traffic move and the old copy
stop.

When a service keeps data in a volume, publishes ports, uses another network
mode, or has a Tailscale address, two copies can't run at once. Kiln then stops
the old project first and deploys under the app's own project name, so Compose
keeps its volumes. See
[When the old containers stop first](/apps#when-the-old-containers-stop-first).
