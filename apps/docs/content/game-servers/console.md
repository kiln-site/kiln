---
title: Console
description: Read a game server's output live, search and filter it, send commands, and share the log on mclo.gs.
---

The **Console** tab streams the game server's output as it happens and lets
you type commands into it, as if you were at the server's own terminal.

## Send a command

Type in the **Send a server command…** box and press <kbd>Enter</kbd>. Commands
go straight to the server, so type them as you would in the game server's own
console, such as `say Restarting in 5 minutes` or `whitelist add Steve`.

- <kbd>↑</kbd> and <kbd>↓</kbd> step through commands you sent earlier in this
  browser tab.
- On Paper and Folia, <kbd>Tab</kbd> asks the server for completions. Pick one
  with <kbd>↑</kbd> and <kbd>↓</kbd>, then press <kbd>Tab</kbd> or
  <kbd>Enter</kbd> to use it.
- While the server is stopped, the box says **Server is stopped** and sends
  nothing.
- If the Relay disconnects while you type, Hearth keeps your command as a
  draft so you can send it when the Relay is back.

If you can read the console but not send commands, Hearth shows
**Read-only console access** in place of the box.

> [!NOTE]
> Typing the server's own stop command, such as `stop` on a Minecraft server,
> stops it the same way **Stop** does: the Relay doesn't treat the exit as a
> crash and leaves it stopped. See
> [Power and crash recovery](/game-servers/power).

## Search and filter

- **Search Console** filters the console to lines that contain what you type.
- **Filter Log Level** shows only the levels you pick: `info`, `warn`,
  `error`, `debug`, and `trace`.

## Copy lines

Click a line to select it, and <kbd>Shift</kbd>-click another to select every
line between them. Then select **Copy Selected Lines** in the toolbar. Press
<kbd>Esc</kbd> to clear the selection.

## Change how the console looks

The toolbar has buttons to:

- **Censor IPs**: hide IP addresses in the console, such as when you share your
  screen. **Show IPs** brings them back.
- **Enable Line Wrap** or **Disable Line Wrap**.
- **Show Timestamps** or **Hide Timestamps**.

## Share the log on mclo.gs

Select **mclo.gs** in the toolbar to upload the console's log to
[mclo.gs](https://mclo.gs), a public log-sharing site for Minecraft. Hearth
copies the link to your clipboard. Select the button again to open the log.

If **Censor IPs** is on, IP addresses are hidden in the uploaded log too.

> [!CAUTION]
> A log on mclo.gs can be read by anyone with its link. Check it for player
> names, IP addresses, and secrets before you share it.

To share a log file from the server's files instead, see
[Share a file on mclo.gs](/game-servers/files#share-a-file-on-mclogs).

## Power controls

The Start or Stop button sits at the top right of every one of the game
server's tabs. The menu beside it has **Start**, **Stop**, **Restart**, and
**Kill**. See [Power and crash recovery](/game-servers/power).

When the server stops on its own, the console says why, and shows each
automatic restart the Relay attempts.
