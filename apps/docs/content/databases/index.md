---
title: Databases
description: Run MySQL, MariaDB, PostgreSQL, Redis, or Valkey on a Relay, reachable only by the game servers and apps you connect.
---

A database runs in its own container on one Relay, with a private network, a
volume for its data, and generated credentials. It publishes no port: only
game servers and apps on its Relay that you connect can reach it.

| Engine | Version | Port |
| --- | --- | --- |
| MySQL | 8.4 LTS | 3306 |
| MariaDB | 11.8 LTS | 3306 |
| Postgres | 17 | 5432 |
| Redis | 8 | 6379 |
| Valkey | 8 | 6379 |

Redis and Valkey have no named database, **Viewer**, or SQL import and export.

## Create a database

1. Open **Databases** and choose **Add Database**.
2. Enter a **Name** and choose the **Engine**.
3. Choose the **Relay**: the one that runs the game servers and apps that use
   it.
4. Choose **Create database**.

## Connect a game server or app

The **Credentials** section of the database's **Info** page shows the
**Hostname**, **Database**, **Username**, and **Password**. **Connection URL**
copies a full URL, password included.

To connect game servers, open the database's **Network** page, choose
**Connect servers**, and pick them. Put the credentials in the game server's
config, such as a plugin's database settings.

### Connect an app

On the app's **Network** page, under **Databases**, choose the database and
**Connect**. If it says **applies on next deploy**, deploy the app. Pass the
**Connection URL** as an
[environment variable](/apps/settings#environment-variables), such as
`DATABASE_URL`.

**Rotate Password** sets a new password at once. Update everything that uses
the old one.

## Browse and query

The database must be running.

- **Viewer** (MySQL, MariaDB, PostgreSQL) pages through tables, edits cells
  with **Save**, and runs SQL from **Query**. Queries are read-only unless you
  turn on **Allow writes**.
- **Terminal** opens the engine's client, signed in: `mysql`, `psql`,
  `redis-cli`, and so on.

Tools on your own computer can't connect directly, since no port is published.

## Import and export

In the **Data** section of the **Info** page:

- **Export SQL** downloads a dump.
- Drop a `.sql` or `.dmp` file, then choose **Import**. It runs on top of
  existing data. PostgreSQL also takes `pg_dump -Fc` dumps.
- **Restore Backup** opens the database's [backups](/backups).

## Limits, wipe, and delete

**Resource limits** sets memory, CPU, and disk. Over its disk limit, the
database keeps running and everyone with access is warned.

At the bottom of the **Info** page, **Wipe database** deletes every table and
row but keeps credentials and connections. **Delete database** removes it with
its data. Neither can be undone; **Export SQL** first.
