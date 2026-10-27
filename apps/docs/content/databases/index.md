---
title: Databases
description: Run MySQL, MariaDB, PostgreSQL, Redis, or Valkey on a Relay, reachable only by the game servers and apps you connect.
---

A database in Kiln is a database server in its own container on one Relay,
with its own private network, a volume for its data, and credentials Kiln
generates. It publishes no port on the machine: only game servers and apps you
connect to it can reach it.

## Engines

| Engine | Version | Port |
| --- | --- | --- |
| MySQL | 8.4 LTS | 3306 |
| MariaDB | 11.8 LTS | 3306 |
| Postgres | 17 | 5432 |
| Redis | 8 | 6379 |
| Valkey | 8 | 6379 |

Redis and Valkey are key-value stores: they have no named database, no
**Viewer**, and no SQL import or export.

## A database's pages

- **Info**: credentials, data import and export, resource limits, and the
  database's internal address.
- **Terminal**: the engine's own client, such as `psql` or `redis-cli`, signed
  in to the database.
- **Network**: which game servers are connected.
- **Viewer**: browse and edit tables, and run SQL. MySQL, MariaDB, and
  PostgreSQL only.
- **Logs**: the database container's output.

You see the pages your permissions allow.

## Import and export

The **Data** section on the **Info** page of a MySQL, MariaDB, or PostgreSQL
database:

- **Export SQL** downloads a dump of the database.
- Drop a `.sql` or `.dmp` file on the section, or choose one, then choose
  **Import**. Kiln runs the dump against the database without clearing what's
  there first. MySQL and MariaDB take text dumps from `mysqldump` or
  `mariadb-dump`; PostgreSQL takes text dumps or custom-format dumps from
  `pg_dump -Fc`.
- **Restore Backup** opens the database's backups. See [Backups](/backups).

## Resource limits

**Resource limits** on the **Info** page sets the database's memory, CPU, and
disk. Changing memory or CPU applies at once; removing one restarts the
database. Over its disk limit, the database keeps running and everyone with
access is warned.

## Wipe or delete

At the bottom of the **Info** page:

- **Wipe database** deletes every table and row. The database, its
  credentials, and its connections stay. The database must be running.
- **Delete database** removes its container, network, data volume,
  credentials, and access grants.

Neither can be undone. Choose **Export SQL** first if you want a copy.

## Next steps

- [Create a database](/databases/create)
- [Connect to a database](/databases/connect)
