---
title: App settings
description: Set an app's environment variables, published ports, and volumes, and open its logs, files, and a shell in its containers.
---

An app's settings live on its pages: **Info**, **Network**, **Files**,
**Logs**, and **Terminal**. Most changes apply on the app's next deployment,
and the dialogs that make them offer **Save and deploy**.

## Environment variables

1. On the app's **Info** page, choose **Environment** in the side panel. It
   shows how many variables the app has.
2. Write one `KEY=VALUE` per line. Lines starting with `#` are comments.
3. Choose **Save and deploy**, or **Save** to apply them on the next
   deployment.

```ini title=".env"
DATABASE_URL=postgres://…
NODE_ENV=production
```

Kiln passes the variables to the app's containers. A Compose file can also use
them as `${KEY}`.

Only people who can manage the app see its environment. Everyone else sees
**Hidden**.

## Start command

For an image, Dockerfile, or GitHub Dockerfile app, **Start command** in the
**Brick** section's **Configure** dialog replaces the image's command. Leave it
empty to use the image's default. A Compose app sets each service's command in
its file.

## Published ports

By default an app is reachable only on its own network, and through its
[web routes](/apps/domains). To expose a port on the Relay's machine directly:

1. Open the app's **Network** page. Under **Published ports**, choose **Add
   port**.
2. Enter the **Host port** on the machine, the **Container port** the app
   listens on, and the protocol, **TCP** or **UDP**.
3. Choose **Save ports**, then deploy the app to publish them.

**Live** below the list shows what's published right now. A Compose app
publishes the ports its Compose file lists instead.

> [!NOTE]
> An app that publishes ports can't run two copies at once, so its
> deployments stop the old container first. For websites, use a web route
> instead. See [How a deployment runs](/apps#how-a-deployment-runs).

## Volumes

Containers keep nothing from one deployment to the next. Whatever an app needs
to keep, mount it from the **Volumes** section of its **Info** page:

1. Choose **Configure** in **Volumes**.
2. Add a **Volume**, a **Path on the node**, or a **File**:
   - **Volume** is one of the Relay's Docker volumes. Choose one, or **New** to
     make one. A volume another app or database already mounts shares its data.
   - **Path on the node** mounts a folder on the Relay's machine. Mounting a new
     path needs permission to edit the node's files.
   - **File** is a file Hearth keeps with the app, such as a config file. Write
     its contents from the **Volumes** section once it's saved.
3. Enter where it's **Mounted at** in the container, and whether it's
   **Read-only**. For a Compose app, choose the **Service** to mount it in, or
   **Every service**.
4. Choose **Save and deploy**.

The section also lists the volumes, configs, and secrets the app's Compose
file declares. Changes to those are made in the Compose file.

> [!WARNING]
> A volume or path mounted read-write means the old container stops before
> the new one starts on each deployment, since two copies would write to the
> same data.

## Containers

The **Container** section of the **Info** page shows one container at a time.
A Compose app has one per service; page through them with the arrows. Each
shows its service, image, address on the app's network, ports, and uptime, and
its CPU and memory limits beside the machine's disk use.

Choose **Labels** to see the container's Docker labels, or **Logs** to open its
output.

## Logs

The app's **Logs** page follows output live. Under **Log source**, choose
**Deployment** for the latest deployment's log, or **Containers** and a service
for that container's output.

## Files

The app's **Files** page is the app's folder on the Relay. It's a Dockerfile
app's build context and a pasted Compose file's project folder. The app's
containers don't mount it; use [Volumes](#volumes) to give them files.

## Terminal

The app's **Terminal** page opens a shell in one of its running containers.
For a Compose app, choose the **Service** first. The app must be deployed and
running.

The terminal runs `sh`. Minimal images, such as distroless or `scratch`
images, have no shell, and the terminal says it couldn't start one.

## Rename, icon, and owner

- Choose **Rename** beside the app's name on its **Info** page to rename it,
  or its icon to change the icon.
- **Transfer** on the owner card hands the app to someone else.
- **Delete app** at the bottom of the **Info** page deletes it.
