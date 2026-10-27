---
title: Create a database
description: Choose an engine and the Relay to run it on, and Kiln sets up its container, network, volume, and credentials.
---

1. Open **Databases** and choose **Add Database**.
2. Enter a **Name**, such as `Production data`.
3. Under **Engine**, choose **MySQL**, **MariaDB**, **Postgres**, **Redis**, or
   **Valkey**.
4. Choose the **Relay** to run it on.
5. Choose **Create database**.

Hearth opens the database's **Info** page. While the Relay pulls the engine's
image and starts it, the page shows how far it got.

## Choose the Relay

A database is only reachable from its own Relay. Game servers and apps on
other Relays can't connect to it, so put it on the Relay that runs what uses
it. See [Connect to a database](/databases/connect).

You see only the Relays you're allowed to create databases on.

## What Kiln sets up

For each database, the Relay creates:

- a container running the engine's image, such as `postgres:17`;
- a private Docker network of its own;
- a persistent volume for its data;
- generated credentials, which you can see on its **Info** page.

No port is published on the machine.

## Rename or change the icon

On the database's **Info** page, choose **Rename** beside its name, or choose
its icon to change it.
