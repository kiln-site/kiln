---
title: CLI commands
description: Every kiln command, grouped by what it works on, with its options and the permissions it needs.
---

Every command needs you signed in, except `login`, `update`, and `help`. A
command can only reach what your account can, and a
[read-only CLI](/cli/authentication#read-only-access) can't change anything.

## Game server references

Commands that act on one game server take a full reference: the Relay's ID and
the game server's ID, joined by a colon.

```text
<relay-id>:<instance-id>
```

Copy it from the `ID` column of `kiln servers list`. A name, or the game
server's ID on its own, isn't accepted. On this page, `<server>` means this
reference.

## Options for every command

| Option             | Does                                                       |
| ------------------ | ---------------------------------------------------------- |
| `--profile <name>` | Use a saved [profile](/cli/authentication#profiles).       |
| `--url <url>`      | Use another Hearth address for this command.               |
| `--token <token>`  | Use a token for this command without saving it.            |
| `-h`, `--help`     | Show help.                                                 |
| `-v`, `--version`  | Show the CLI's version.                                    |

## Account

| Command              | Does                                                                         |
| -------------------- | ---------------------------------------------------------------------------- |
| `kiln login [url]`   | Sign in. Takes `--profile`, `--name`, and `--no-open`.                       |
| `kiln logout`        | Revoke the active profile's credential and remove the profile.              |
| `kiln whoami`        | Show your name, email, the CLI's access, the profile, and the Hearth address. |
| `kiln update`        | Update the CLI itself.                                                       |

See [Authentication](/cli/authentication).

## Relays

```sh
kiln relays list
```

Lists the Relays your account can see, with their status, version, platform,
number of game servers, and ID.

```sh
kiln relay info <relay-id>
```

Shows a Relay's details: status, version, platform, whether it can create
game servers, and its machine's CPU, memory, and storage use. It needs
**View Relay** on that Relay; access to one of its game servers isn't enough.

## Game servers

### List and inspect

```sh
kiln servers list
kiln server info <server>
```

`servers list` shows each game server's name, state, Relay, and full
reference. `server info` shows its state, limits, and current resource use.
When a game server failed or stopped unexpectedly, `server info` shows a
`Reason` line, such as an out-of-memory kill.

### Create

```sh
kiln servers create <relay-id> <brick> --name <name> [options]
```

`<brick>` is a Brick ID from your Kiln's catalogs, such as `paper`, or the
HTTPS URL of a custom Brick.

```sh
kiln servers create <relay-id> paper --name survival --memory 4GiB --disk 25GiB
kiln servers create <relay-id> https://example.com/custom-brick.yml \
  --name custom --variable version=1.0.0
```

| Option                     | Does                                                                         |
| -------------------------- | ---------------------------------------------------------------------------- |
| `--name <name>`            | The game server's name, up to 32 characters. Required.                       |
| `--memory <size\|none>`    | Memory limit, at least `64MiB`. Defaults to the Brick's recommended memory.  |
| `--cpu <cores\|none>`      | CPU limit in cores, such as `1.5`, at least `0.1`. No limit by default.      |
| `--disk <size\|none>`      | Disk limit, at least `0.1GiB`. Defaults to `5GiB`.                           |
| `--game-version <version>` | Set the Brick's `version` variable.                                          |
| `--java-version <version>` | Set the Brick's `java_version` variable.                                     |
| `--variable <name=value>`  | Set any Brick variable. Repeat for more than one.                            |
| `--no-start`               | Leave the new game server stopped.                                           |

Write sizes with a unit, such as `512MiB` or `4GiB`. `none` removes the limit.

For a number or true/false variable, prefix the value with `json:`:
`--variable slots=json:20` or `--variable online_mode=json:false`.

Needs **Create servers** on the Relay.

### Delete

```sh
kiln server delete <server> --confirm <server>
```

Permanently deletes the game server and its data. `--confirm` must repeat the
reference exactly. Needs **Delete server**.

## Power

```sh
kiln server power <server> start
kiln server power <server> stop
kiln server power <server> restart
kiln server power <server> kill
```

`kill` stops the process at once, without a clean shutdown. Use it only when
`stop` doesn't work. Each action needs its own power permission: **Start
server**, **Stop server**, **Restart server**, or **Force stop server**.

## Console

```sh
kiln server console <server> "say Restarting in 5 minutes"
```

Sends one command to the game server's console. Without a command, the CLI
reads it from standard input. Needs **Send commands**.

## Logs

```sh
kiln server logs <server> --limit 200
kiln server logs <server> --follow
```

Prints the game server's recent log lines. `--limit` sets how many, from 1 to
10000 (2000 by default). `--follow`, or `-f`, keeps printing new lines until
you press <kbd>Ctrl</kbd> <kbd>C</kbd>.

## Startup settings

### Change settings

```sh
kiln server startup <server> --memory 6GiB --cpu 2
kiln server startup <server> --disk none --java-version 25
kiln server startup <server> --game-version 1.21.11
kiln server startup <server> --variable java_args="-XX:+UseG1GC"
```

Changes only what you pass. Everything else, including limits you leave out,
stays as it is. Takes the same `--memory`, `--cpu`, `--disk`,
`--game-version`, `--java-version`, `--variable`, and `--no-start` options as
`servers create`.

### Change the Brick

```sh
kiln server brick <server> <brick> [options]
kiln server brick <server> paper --memory 4GiB --game-version 1.21.11
```

Switches the game server to another Brick. The new Brick starts from its own
defaults plus the variables you pass; variables from the old Brick aren't
carried over.

### Permissions

- Changing the Brick or its variables needs **Manage configuration**.
- Changing `--memory`, `--cpu`, or `--disk` needs **Manage resource limits**.
- After the change, the game server starts, restarting first if it was
  running. That needs **Start server** or **Restart server**. With
  `--no-start` it's left stopped instead, which needs **Stop server** if it
  was running and no power permission if it wasn't.

## Files

Remote paths are relative to the game server's root. Write `bukkit.yml` or
`plugins/example.jar`, without a leading `/` or `/data`.

| Command                                         | Does                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| `kiln files list <server> [path]`               | List a folder. Defaults to the root (`.`).                                           |
| `kiln files read <server> <remote>`             | Print a text file.                                                                   |
| `kiln files write <server> <remote> [local\|-]` | Write a text file from a local file, or from standard input with `-` or no argument. |
| `kiln files download <server> <remote> [local]` | Download a file over SFTP. Saves to the current folder by default.                   |
| `kiln files upload <server> <local> [remote]`   | Upload one file over SFTP. Saves to the root by default.                             |
| `kiln files upload <server> <url> [remote]`     | Have the Relay download a file from an HTTPS URL.                                    |

```sh
kiln files read <server> server.properties
kiln files write <server> whitelist.json ./whitelist.json
kiln files upload <server> ./example.jar plugins/example.jar
kiln files upload <server> https://example.com/plugin.jar plugins/plugin.jar
```

- `read` and `write` are for text. Use `download` for binary files.
- `write` takes at most 16 MiB from standard input.
- `upload` sends a single regular file, not a folder. The remote folder must
  already exist.
- `download` and `upload` connect to the Relay's SFTP port and check the
  Relay's host key.
- With a URL, the Relay downloads the file itself. Only HTTPS is allowed, up
  to five redirects and 20 GiB. URLs with credentials, and addresses on
  private or local networks, are refused.

Reading and downloading need **View and download files**. Writing and
uploading need **Edit files**.

## Backups

### List

```sh
kiln backups targets
kiln backups list --limit 200
```

`backups targets` lists everything you can back up, with the reference to
use for each. `backups list` lists backups you can see, with their status,
mode, target, destinations, size, and ID. A failed backup gets
a line below the table saying why.

### Create

```sh
kiln backups create server <server> --name "Before update"
kiln backups create database <relay-id>:<database-id> --name "Before migration"
kiln backups create platform <relay-id> --name "Before Hearth update"
```

| Option                            | Does                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `--name <name>`                   | Name the backup. Defaults to `CLI backup`.                                                     |
| `--mode <incremental\|full>`      | Game servers only. `incremental` (the default) saves a snapshot; `full` saves a portable zip.  |
| `--storage <default\|local\|id>`  | Where to store it: the default for that game server, the Relay itself, or a destination's ID.  |

Needs **Create backups**. Storing a backup in a destination you added
yourself also needs **Download backups**.

### Restore

```sh
kiln backup restore <backup-id>
kiln backup restore <backup-id> --no-safety-backup
```

Restores a game server or database backup. Kiln takes a full backup first,
unless you pass `--no-safety-backup`. Stop a game server before restoring it;
a database stays online. Needs **Restore backups**.

### Download

```sh
kiln backup download <backup-id> [local]
```

Saves the backup under its own filename unless you give a path. An
incremental snapshot is exported to a zip first, and the CLI waits for it.
Needs **Download backups**.

### Delete

```sh
kiln backup delete <backup-id> --confirm <backup-id>
```

Permanently deletes the backup. `--confirm` must repeat the ID exactly. Needs
**Delete backups**.

When a Relay is offline, `create`, `restore`, and `delete` are saved and run
when it reconnects; the CLI says so.

## Activity

```sh
kiln activity list --limit 200
```

Lists recent [activity](/access/activity) your account can see: when, who,
what, the game server, the Relay, and whether it came from Hearth or the CLI.
`--limit` takes 1 to 10000 entries (2000 by default).

## Exit and errors

When a command fails, the CLI prints what went wrong to standard error and
exits with a non-zero code. Stopping a command with <kbd>Ctrl</kbd> <kbd>C</kbd> doesn't
undo a change the Relay already accepted. Check the result, such as with
`kiln server info` or `kiln files list`, before trying again.
