---
title: App settings
description: Set an app's environment, ports, and volumes, keep its image up to date, and open its logs, files, and a shell.
---

Most changes apply on the app's next deployment. The dialogs that make them
offer **Save and deploy**, or **Save** to wait for the next one.

## Environment variables

On the app's **Info** page, choose **Environment**. Write one `KEY=VALUE` per
line; lines starting with `#` are comments. Only people who can manage the app
see the values.

```ini title=".env"
DATABASE_URL=postgres://…
NODE_ENV=production
```

**Start command**, in the **Brick** section's **Configure** dialog, replaces
the image's command. A Compose app sets commands in its file.

## Published ports

An app is reachable only on its own network and through its
[web routes](/apps/domains) unless you publish a port. On its **Network** page,
under **Published ports**, choose **Add port**, enter the **Host port**,
**Container port**, and protocol, choose **Save ports**, and deploy. A Compose
app publishes the ports its file lists instead.

## Volumes

Containers keep nothing between deployments. Choose **Configure** in the
**Info** page's **Volumes** section and add:

- a **Volume**, one of the Relay's Docker volumes, or **New**. A volume another
  app or database mounts shares its data;
- a **Path on the node**, a folder on the Relay's machine. A new path needs
  permission to edit the node's files;
- a **File** Hearth keeps with the app, such as a config file.

Set where it's **Mounted at**, whether it's **Read-only**, and for Compose, the
**Service**. Choose **Save and deploy**.

> [!NOTE]
> Published ports and read-write mounts make each deployment stop the old
> container first. See [Deployments](/apps#deployments).

## Image updates

For an app whose source is **Image**, Kiln checks every hour whether its tag
names a newer image. The **Updates** row on the **Deployment** card shows the
result, such as **Up to date**, **Update available**, or **Check failed**
(hover for why). Choose it to open **Image updates**:

- **Notify**, the default, tells everyone who can deploy the app, once per new
  image.
- **Automatic** also deploys the new image once Kiln has seen it for the
  **Wait**, three days by default. If the tag moves again, the wait starts
  over.
- **Off** stops checking.

When an update is available, **Update now** deploys it at once, and **Skip**
passes over that image. An image pinned to a digest, such as
`nginx@sha256:…`, never updates. To roll back, choose **Redeploy** on the older
deployment in **History**; automatic updates won't redeploy the image you left.

## Logs, files, and terminal

- **Logs** follows output live. Choose **Deployment** or **Containers** under
  **Log source**.
- **Files** is the app's folder on the Relay: a Dockerfile's build context and
  a Compose file's project folder. Containers don't mount it; use
  [volumes](#volumes).
- **Terminal** opens `sh` in a running container. Images without a shell, such
  as distroless, can't open one.

The **Container** section of the **Info** page shows each container's image,
address, ports, uptime, and limits. **Rename**, **Transfer** on the owner card,
and **Delete app** are on the **Info** page too.
