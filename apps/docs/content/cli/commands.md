---
title: CLI commands
description: Every kiln command, grouped by what it works on, with its options and the permissions it needs.
---

Every command except `login`, `update`, and `help` needs you signed in, and
can only reach what your account can. Every command takes `--profile`,
`--url`, `--token`, and `--help`. See [The kiln CLI](/cli).

`<server>` below is a game server's full reference, `<relay-id>:<instance-id>`,
from the `ID` column of `kiln servers list`. Names aren't accepted.

## Account

| Command            | Does                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `kiln login [url]` | Sign in. Takes `--profile`, `--name`, `--no-open`.                                                                 |
| `kiln logout`      | Revoke the profile's credential and remove it.                                                                     |
| `kiln whoami`      | Show your account, the CLI's access, the profile, and the Hearth address.                                         |
| `kiln update`      | Update the CLI itself.                                                                                             |

## Relays and game servers

| Command                                                     | Does                                                                                     | Needs                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------- |
| `kiln relays list`                                          | List Relays with status, version, platform, game server count, and ID.                   |                       |
| `kiln relay info <relay-id>`                                | Show a Relay's details and its machine's CPU, memory, and storage use.                   | **View Relay**        |
| `kiln servers list`                                         | List game servers with state, Relay, and reference.                                      |                       |
| `kiln server info <server>`                                 | Show state, limits, and resource use, and a `Reason` line if it failed or stopped.       |                       |
| `kiln servers create <relay-id> <brick> --name <name>`      | Create a game server from a Brick ID, such as `paper`, or a custom Brick's HTTPS URL.    | **Create servers**    |
| `kiln server delete <server> --confirm <server>`            | Delete the game server and its data.                                                     | **Delete server**     |
| `kiln server power <server> start\|stop\|restart\|kill`     | Change power state. `kill` skips a clean shutdown; use it only when `stop` fails.         | That power permission |
| `kiln server console <server> [command]`                    | Send one console command, or read it from standard input.                                | **Send commands**     |
| `kiln server logs <server>`                                 | Print recent lines. `--limit` 1 to 10000 (default 2000); `-f`/`--follow` keeps printing. |                       |

## Startup settings

```sh
kiln servers create <relay-id> paper --name survival --memory 4GiB --disk 25GiB
kiln server startup <server> --memory 6GiB --game-version 1.21.11
kiln server brick <server> paper --memory 4GiB
```

`server startup` changes only what you pass. `server brick` starts the new
Brick from its defaults; old variables aren't kept. All three take:

| Option                     | Does                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `--name <name>`            | Name, up to 32 characters. Required for `create`.                                     |
| `--memory <size\|none>`    | Memory limit, at least `64MiB`. New game servers default to the Brick's recommendation. |
| `--cpu <cores\|none>`      | CPU limit, such as `1.5`, at least `0.1`. None by default.                            |
| `--disk <size\|none>`      | Disk limit, at least `0.1GiB`. Defaults to `5GiB`.                                    |
| `--game-version`, `--java-version` | Set the Brick's `version` or `java_version` variable.                         |
| `--variable <name=value>`  | Set any variable; repeat for more. Use `json:` for numbers and booleans: `slots=json:20`. |
| `--no-start`               | Leave it stopped.                                                                     |

Sizes take a unit, such as `512MiB`. `none` removes a limit.

Changing the Brick or variables needs **Manage configuration**; limits need
**Manage resource limits**. Afterwards the game server starts or restarts,
which needs **Start server** or **Restart server**.

## Files

Paths start at the game server's root: `plugins/example.jar`, not
`/plugins/...` or `/data/...`.

| Command                                         | Does                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| `kiln files list <server> [path]`               | List a folder.                                                         |
| `kiln files read <server> <remote>`             | Print a text file.                                                     |
| `kiln files write <server> <remote> [local\|-]` | Write a text file from a local file or standard input (up to 16 MiB).  |
| `kiln files download <server> <remote> [local]` | Download any file over SFTP.                                           |
| `kiln files upload <server> <local> [remote]`   | Upload one file over SFTP. The remote folder must exist.               |
| `kiln files upload <server> <url> [remote]`     | Have the Relay download an HTTPS URL, up to 20 GiB.                    |

`download` and `upload` use the Relay's SFTP port. URL uploads refuse private
or local addresses. Reading needs **View and download files**; writing needs
**Edit files**.

## Backups

| Command                                           | Does                                                              | Needs                |
| ------------------------------------------------- | ----------------------------------------------------------------- | -------------------- |
| `kiln backups targets`                            | List what you can back up, with each one's reference.             |                      |
| `kiln backups list`                               | List backups, with why any failed.                                |                      |
| `kiln backups create server\|database\|platform <ref>` | Create a backup.                                             | **Create backups**   |
| `kiln backup restore <backup-id>`                 | Restore, after a full safety backup unless `--no-safety-backup`.  | **Restore backups**  |
| `kiln backup download <backup-id> [local]`        | Download. Incremental snapshots are zipped first.                 | **Download backups** |
| `kiln backup delete <backup-id> --confirm <backup-id>` | Delete the backup.                                           | **Delete backups**   |

`create` takes `--name`, `--mode incremental|full` (game servers only;
`full` is a portable zip), and `--storage default|local|<destination-id>`.
Stop a game server before restoring it. When a Relay is offline, `create`,
`restore`, and `delete` run when it reconnects.

## Activity

`kiln activity list` shows the [activity](/access#activity-history) you can
see. `--limit` takes 1 to 10000 (default 2000).

## Errors

A failed command prints why and exits non-zero. <kbd>Ctrl</kbd> <kbd>C</kbd>
doesn't undo a change the Relay already accepted, so check the result before
retrying.
