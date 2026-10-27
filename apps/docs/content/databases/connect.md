---
title: Connect to a database
description: Connect a game server or app on the same Relay, copy the connection details, and browse data in Hearth's Viewer.
---

A database has no public port. Game servers and apps on its Relay reach it
once you connect them to its private network. From outside the Relay, use
Hearth: the **Viewer**, the **Terminal**, or **Export SQL**.

## Connection details

The **Credentials** section of the database's **Info** page shows:

- **Hostname**: the database's name on its private network.
- **Database**: the database to use. Redis and Valkey have none.
- **Username** and **Password**. The password stays masked until you reveal
  it.

**Connection URL** copies a full URL, password included, without showing it:

```text title="PostgreSQL"
postgresql://user:password@database-…:5432/name
```

MySQL and MariaDB URLs start with `mysql://`, and Redis and Valkey URLs with
`redis://`. The **Connection** section shows the **Internal address**, the
hostname and port together.

These details work only from a game server or app connected to the database.

## Connect a game server

1. Open the database's **Network** page.
2. Under **Connected game servers**, choose **Connect servers**.
3. Choose the game servers to connect.

The game servers join the database's private network and reach it at its
**Internal address**. Put the credentials in the game server's config, such as
a plugin's database settings. Only game servers on the database's Relay are
listed.

To disconnect one, choose **Disconnect** on its row.

## Connect an app

1. Open the app's **Network** page.
2. Under **Databases**, choose the database, then **Connect**.

The app's running containers join the database's network at once, and every
deployment after joins it too. If the database's row says **applies on next
deploy**, deploy the app to finish connecting it. Only databases on the app's
Relay are listed.

Pass the details to the app as environment variables, such as the copied
**Connection URL** as `DATABASE_URL`. See
[Environment variables](/apps/settings#environment-variables).

## Rotate the password

In the **Credentials** section, choose **Rotate Password**. The database gets
a new password at once. Anything still using the old one, like a game server's
config or an app's environment, can't connect until you give it the new one.

## Browse data in the Viewer

The **Viewer** page browses and edits MySQL, MariaDB, and PostgreSQL databases
in Hearth. The database must be running.

- Choose a table to page through its rows, choose which columns show, and see
  its structure.
- Edit cells, then choose **Save**, or **Discard** to drop the changes. If
  someone changed the same rows meanwhile, Kiln shows both versions and asks
  whether to **Keep my edits**.
- Choose **Query** to write SQL, then **Run**, or press <kbd>Ctrl</kbd>
  <kbd>Enter</kbd>. Queries run read-only unless you turn on **Allow writes**.

Editing rows and running SQL need permission to write the database's data.

## Use the database's client

The **Terminal** page opens the engine's own client, already signed in:
`mysql`, `mariadb`, `psql`, `redis-cli`, or `valkey-cli`. The database must be
running.

## From outside the Relay

Kiln doesn't publish a database's port, so tools on your own computer can't
connect to it directly. Use the **Viewer** or **Terminal**, or **Export SQL**
on the **Info** page to download a dump.
