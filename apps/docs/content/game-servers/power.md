---
title: Power and crash recovery
description: Start, stop, restart, or kill a game server, and how its Relay restarts it after a crash.
---

## Power controls

A game server's power controls sit at the top right of its pages. The main
button reads **Start** when the server is stopped and **Stop** when it's
running. The menu beside it, **Power Options**, has all four actions:

| Action      | What it does                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| **Start**   | Starts the container.                                                                                           |
| **Stop**    | Asks the server to shut down cleanly. If it's still running after 60 seconds, the container is stopped by force. |
| **Restart** | Stops the server cleanly, then starts it again. Only available while it's running.                              |
| **Kill**    | Ends the container at once, after you confirm with **Kill now**.                                                 |

> [!WARNING]
> **Kill** doesn't let the server save. Anything it hadn't written to disk,
> such as recent changes to a Minecraft world, is lost. Use it only when
> **Stop** doesn't work.

The power controls need the game server's Relay to be connected, and each
action needs its own permission. See [Permissions](/access/permissions).

## Starting up

After **Start**, a game server shows as starting until it's ready for players.
For Bricks that name a startup line, such as Minecraft's `Done (…)! For help,
type "help"`, the Relay waits for that line in the console. If the line hasn't
appeared after two minutes, Kiln shows the server as running anyway.

## Crash recovery

The Relay remembers whether you want each game server running or stopped. When
a server you left running exits without you stopping it, the Relay starts it
again, and the console shows why it stopped and which attempt this is, such as
**Server ran out of memory. Automatic restart scheduled — attempt 1 of 2.**

The Relay restarts a server when:

- Its process exits with an error.
- The container runs out of memory.
- The server stops itself, such as through a plugin or an in-game `/stop`.
  The console says **Server stopped internally.**

The Relay doesn't restart a server that you stopped with **Stop** or **Kill**,
or by typing its stop command, such as `stop`, in Hearth's console.

Crash recovery runs on the Relay, so it keeps working while Hearth is down.

### Recovery attempts

By default, the Relay tries twice. It waits 5 seconds before the first
attempt, then three times as long before each next one, up to a minute. Once a
server has stayed up for 5 minutes, the count starts over.

### When recovery stops

If the server keeps crashing after every attempt, the Relay leaves it stopped
and the console says so, for example: **The server failed repeatedly.
Automatic recovery stopped after 2 attempts.**

To find the cause:

1. Read the console from just before the crash. The error is usually there.
2. If it ran out of memory, raise its **Memory** limit on the
   [Startup](/game-servers/startup) tab.
3. If a plugin or mod fails to load, remove or update it in
   [Files](/game-servers/files).
4. Start the server again. Starting it by hand resets the attempt count.

### Change the recovery settings

These settings belong to the Relay and apply to all of its game servers. Set
them in the Relay's environment:

| Variable                             | Default | Range     | What it does                                              |
| ------------------------------------ | ------- | --------- | --------------------------------------------------------- |
| `KILN_RELAY_CRASH_RETRY_LIMIT`       | `2`     | 0 to 10   | How many times to restart a crashed server. `0` turns recovery off. |
| `KILN_RELAY_CRASH_RETRY_DELAY_SECONDS` | `5`   | 0 to 300  | How long to wait before the first restart.                |
| `KILN_RELAY_CRASH_STABILITY_SECONDS` | `300`   | 15 to 3600 | How long a server must stay up before the count resets.  |

## Disk limit

When a running game server's files grow past its **Disk** limit, the Relay
stops it, and won't start or restart it until its files fit again. This
counts as a stop you asked for, so crash recovery doesn't start it. Raise the
limit on the [Startup](/game-servers/startup) tab, or delete files, then start
it.
