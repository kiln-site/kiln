---
title: Roles and permissions
description: Choose what each person can do on a Relay, game server, or database, with presets or single permissions, and see every permission Kiln has.
---

Beyond their [platform role](/access#platform-roles), people get
permissions on a specific Relay, game server, or database. You choose them
when you invite someone, and change them later with **Edit permissions** on
the **Access** page.

## Where access applies

You grant permissions on one of three things:

| Granted on  | Applies to                                                                                |
| ----------- | ----------------------------------------------------------------------------------------- |
| A Relay     | The Relay and every current and future game server, database, and app on it.               |
| Game server | That game server only.                                                                    |
| Database    | That database only.                                                                       |

Some permissions exist only on a Relay: everything about the Relay itself,
creating game servers, databases, and apps, and every app permission. Apps
can't be shared one at a time; app permissions on a Relay cover all its apps.

Permissions from different places add together. Someone with **View
console** on a Relay and **Send commands** on one game server can send
commands on that game server and view the console on every other one. Nothing
takes a permission away.

## Presets

A preset is a saved set of permissions. Kiln comes with three, marked **Kiln
default** on the **Presets** tab:

| Preset            | What it includes                                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Observer**      | Inspect status, console, configuration, networks, backups, and schedules. Doesn't include downloading files, backups, or credentials.    |
| **Operator**      | Operate servers, files, networks, backups, and schedules, without managing people or deleting resources.                                 |
| **Administrator** | Every current and future permission on that resource. Doesn't transfer ownership or grant a platform role.                                |

To make your own, open **Access**, choose a resource, open the **Presets**
tab, and click **Create preset**. You can start from a copy of another preset
or choose permissions one by one. A preset belongs to the resource you create
it on.

When you assign a preset to someone, it stays linked. Editing the preset
later changes the access of everyone it's linked to. Permissions you add
beside a preset add to it.

## Add permissions

In the invitation or **Edit permissions** dialog, type a permission's name or
key, such as `instance.files`, in the field above the resource's permissions.
Pick a single permission, a preset, or an "All" group:

- **All** followed by an area, such as **All files**, selects every permission
  in that area, including ones Kiln adds later.
- **All permissions** selects everything that applies to the resource,
  now and later.

Some permissions include others. Selecting **Edit files** also grants **View
and download files**, and the dialog shows what each choice **Also grants**.
You can only grant permissions you hold yourself.

## Permission reference

Each table lists a permission as Hearth labels it, its key, and what it
allows. Every permission also lets the person see the resource it's on.

### Relay

Granted on a Relay only.

| Permission                   | Key                        | Allows                                                                                                    |
| ---------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------- |
| **View Relay**               | `relay.read`               | See the Relay's status and basic details.                                                                 |
| **Configure Relay**          | `relay.configure`          | Change the Relay's settings and connection details.                                                       |
| **Update Relay**             | `relay.update`             | Install a newer version of the Relay.                                                                     |
| **Pause or resume Relay**    | `relay.pause`              | Turn Hearth's connection to the Relay off or back on.                                                     |
| **Remove Relay**             | `relay.delete`             | Remove the Relay from Hearth.                                                                             |
| **View Relay connections**   | `relay.connections.read`   | See paired clients and pending pairing invitations.                                                       |
| **Manage Relay connections** | `relay.connections.manage` | Pair clients, change their access, and revoke connections. Includes viewing them.                         |
| **View Relay activity**      | `relay.audit.read`         | See all of the Relay's [activity](/access/activity), including its databases and apps.                    |
| **View Relay logs**          | `relay.logs.read`          | Watch the Relay container's live output.                                                                  |
| **Open host terminal**       | `relay.terminal`           | Run a root shell on the Relay's host.                                                                     |
| **View Relay database**      | `relay.database.read`      | Inspect the Relay's own state, including pairing records and sensitive configuration.                     |
| **View host files**          | `relay.files.read`         | Browse and download any file on the Relay's host, including system configuration and secrets.             |
| **Edit host files**          | `relay.files.write`        | Create, upload, edit, move, and delete any file on the host. Includes viewing them.                       |
| **Mount host files**         | `relay.files.mount`        | Restart the Relay with its host's filesystem mounted, so host files can be browsed.                       |
| **Create servers**           | `instance.create`          | Create game servers on the Relay.                                                                         |
| **Create databases**         | `database.create`          | Create databases on the Relay.                                                                            |
| **Create apps**              | `app.create`               | Add apps on the Relay.                                                                                    |

> [!CAUTION]
> **Open host terminal**, **View host files**, **Edit host files**, **Mount
> host files**, and **View Relay database** reach the Relay's machine outside
> Kiln's own resources. Hearth marks them **Host access**. Grant them only to
> people you'd trust with root on that machine.

### Game server

Granted on a Relay or a game server.

| Permission                   | Key                                  | Allows                                                                                       |
| ---------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------- |
| **View server**              | `instance.read`                      | See the server's status and basic details, and its activity.                                 |
| **Start server**             | `instance.power.start`               | Start a stopped server.                                                                      |
| **Stop server**              | `instance.power.stop`                | Shut the server down gracefully. Includes starting it.                                       |
| **Restart server**           | `instance.power.restart`             | Restart the server. Includes starting and stopping it.                                       |
| **Force stop server**        | `instance.power.kill`                | Stop the server immediately. Includes starting, stopping, and restarting it.                 |
| **View console**             | `instance.console.read`              | Read the live console.                                                                       |
| **Send commands**            | `instance.console.write`             | Run commands in the console. Includes viewing it.                                            |
| **View and download files**  | `instance.files.read`                | Browse the server's files and download them.                                                 |
| **Edit files**               | `instance.files.write`               | Create, upload, edit, copy, move, and rename files. Includes viewing them.                   |
| **Delete files**             | `instance.files.delete`              | Remove files and folders. Includes viewing them.                                             |
| **Change file permissions**  | `instance.files.chmod`               | Change which users can read, write, or run files. Includes viewing them.                     |
| **Connect using SFTP**       | `instance.sftp.connect`              | Browse files with an SFTP client. Changing files still needs the matching file permissions.  |
| **View configuration**       | `instance.configuration.read`        | See the server's startup settings and Brick configuration.                                   |
| **Manage configuration**     | `instance.configuration.write`       | Change startup settings, switch Bricks, and reinstall the server. Includes viewing them.     |
| **Manage resource limits**   | `instance.limits.write`              | Change the server's memory and disk limits. Includes viewing the configuration.              |
| **View saved logs**          | `instance.logs.read`                 | Read the server's saved log files.                                                           |
| **Share logs**               | `instance.logs.share`                | Publish server logs through a shareable link. Includes viewing them.                         |
| **View server network**      | `instance.network.read`              | See the server's addresses, ports, and routes.                                               |
| **Manage server network**    | `instance.network.write`             | Change the server's network settings and routes. Includes viewing them.                      |
| **Assign public ports**      | `instance.network.public-port.write` | Assign ports that make the server reachable from outside. Includes managing the network.     |
| **Delete server**            | `instance.delete`                    | Permanently remove the server and its data.                                                  |

### Database

Granted on a Relay or a database.

| Permission                    | Key                           | Allows                                                                                                  |
| ----------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| **View database**             | `database.read`               | See the database's status and basic details. Doesn't reveal credentials.                                |
| **Control database power**    | `database.power`              | Start, stop, or restart the database.                                                                   |
| **View database credentials** | `database.credentials.read`   | Reveal the username and password used to connect.                                                       |
| **Reset database password**   | `database.credentials.rotate` | Generate a new password. Includes viewing credentials.                                                  |
| **View database network**     | `database.network.read`       | See which game servers can connect to the database.                                                     |
| **Manage database network**   | `database.network.write`      | Connect or disconnect game servers. Also needs network access on each game server. Includes viewing it. |
| **Export database data**      | `database.dump.export`        | Download a database dump. Only for engines that support dumps.                                          |
| **Import database data**      | `database.dump.import`        | Load a dump into the database. Only for engines that support dumps.                                     |
| **Browse database tables**    | `database.data.read`          | View tables, columns, and rows in the **Viewer**.                                                       |
| **Edit database tables**      | `database.data.write`         | Edit rows and run SQL in the **Viewer**. Includes browsing.                                             |
| **Use database terminal**     | `database.terminal`           | Open the database's command-line client, signed in.                                                     |
| **View database logs**        | `database.logs.read`          | Watch the database container's live output.                                                             |
| **Manage resource limits**    | `database.limits.write`       | Change the database's memory, CPU, and disk limits.                                                     |
| **Delete database**           | `database.delete`             | Permanently remove the database and its data.                                                           |

### Apps

Granted on a Relay, for every app on it.

| Permission                    | Key               | Allows                                                                                  |
| ----------------------------- | ----------------- | --------------------------------------------------------------------------------------- |
| **View apps**                 | `app.read`        | See apps, their containers, and how they're configured. The environment isn't shown.    |
| **Configure and deploy apps** | `app.manage`      | Change an app's source, environment, and networking, deploy it, and start or stop it.   |
| **View app logs**             | `app.logs.read`   | Read deployment logs and container output.                                              |
| **Open app shells**           | `app.terminal`    | Run a shell inside an app's containers.                                                 |
| **View app files**            | `app.files.read`  | Browse and download an app's data directory.                                            |
| **Edit app files**            | `app.files.write` | Create, upload, edit, move, and delete an app's files. Includes viewing them.           |
| **Delete apps**               | `app.delete`      | Remove apps, their containers, and their data.                                          |

> [!CAUTION]
> An app can run any container, with the access that gives on the Relay's
> host. Hearth marks **Configure and deploy apps** and **Open app shells** as
> **Host access** too.

### People, presets, backups, and schedules

Granted on a Relay, game server, or database. On a Relay, backup and schedule
permissions cover its game servers and databases too.

| Permission                 | Key                | Allows                                                                                     |
| -------------------------- | ------------------ | ------------------------------------------------------------------------------------------ |
| **View users**             | `access.read`      | See who has access and what permissions they hold.                                         |
| **Invite users**           | `access.invite`    | Invite people. Includes viewing users and creating presets.                                |
| **Manage access**          | `access.manage`    | Change permissions and revoke access. Includes inviting.                                   |
| **View presets**           | `preset.read`      | See saved presets.                                                                         |
| **Create or copy presets** | `preset.create`    | Save new presets on this resource. Includes viewing them.                                  |
| **Manage presets**         | `preset.manage`    | Edit or delete presets. Changes apply to everyone linked to them. Includes creating them.  |
| **View backups**           | `backup.read`      | See backups and their status.                                                              |
| **Create backups**         | `backup.create`    | Make a new backup. Includes viewing backups.                                               |
| **Download backups**       | `backup.download`  | Download backup files. Includes viewing backups.                                           |
| **Restore backups**        | `backup.restore`   | Replace current data with a backup. Includes viewing backups.                              |
| **Delete backups**         | `backup.delete`    | Remove backups. Includes viewing them.                                                     |
| **View schedules**         | `schedule.read`    | See scheduled tasks and their run history.                                                 |
| **Create schedules**       | `schedule.create`  | Set up tasks to run automatically. Includes viewing them.                                  |
| **Edit schedules**         | `schedule.update`  | Change tasks and when they run. Includes viewing them.                                     |
| **Run schedules**          | `schedule.execute` | Run a task now. Includes viewing them.                                                     |
| **Delete schedules**       | `schedule.delete`  | Remove tasks. Includes viewing them.                                                       |

Some actions need more than one permission. Creating, editing, or running a
schedule also needs permission for its action on each target it runs on.

## The CLI and SFTP

The [CLI](/cli) and SFTP use the same permissions as Hearth. A CLI linked with
[read-only access](/cli/authentication#read-only-access) can't change anything,
whatever its account's permissions allow.
