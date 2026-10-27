---
title: Console and files
description: Read a game server's output live, send it commands, and browse, edit, upload, and download its files.
---

## Console

The **Console** tab streams the game server's output and takes commands. Type
in **Send a server command…** and press <kbd>Enter</kbd>, as you would at the
server's own console, such as `say Restarting in 5 minutes`.

- <kbd>↑</kbd> and <kbd>↓</kbd> step through commands you sent in this tab.
- On Paper and Folia, <kbd>Tab</kbd> completes commands.
- If the Relay disconnects while you type, your command stays as a draft.
- **Read-only console access** means you can read but not send.

Typing the stop command, such as `stop`, stops the server like **Stop** does,
so the Relay doesn't restart it. See
[Crash recovery](/game-servers#crash-recovery).

The toolbar has **Search Console**, **Filter Log Level**, **Censor IPs**, line
wrap, and timestamps. To copy lines, click one, <kbd>Shift</kbd>-click
another, and select **Copy Selected Lines**.

### Share the log

**mclo.gs** uploads the console's log to [mclo.gs](https://mclo.gs) and copies
the link. With **Censor IPs** on, IP addresses are hidden in the upload too.

> [!CAUTION]
> Anyone with the link can read the log. Check it for player names, IP
> addresses, and secrets first.

## Files

The **Files** tab shows the game server's data folder. Select a file in the
tree to open it, or type in **Search files…** to match any part of its path.
**Pin** keeps a file on **Files Home**.

Text files up to 2 MiB open in an editor. Save with <kbd>Ctrl</kbd>
<kbd>S</kbd> (<kbd>⌘</kbd> <kbd>S</kbd>). Archived `.log.gz` logs open
read-only. Many games read config only at startup, so restart after editing.

To upload, drag files or folders onto the list, or select **Upload**. Uploads
go into the open folder. **Download** lets you rename the file and compress it
as **ZIP** or **Gzip**.

Each file's actions menu has **Open**, **Rename**, **Move**, **Download**,
**Archive** (to `.zip`), **Unarchive** (`.zip`, `.tar.gz`, `.tgz`),
**Duplicate**, **Delete**, and **Pin**. Check several files to act on them
together.

### NBT files

Minecraft's `.dat`, `.dat_old`, and `.nbt` files, such as `level.dat` and
`playerdata/`, open as SNBT text. Saving checks it and writes binary NBT back,
gzipped if the original was. **Force save** writes text that doesn't check
out, and Minecraft may not load it.

> [!WARNING]
> Stop the server before editing `level.dat` or player files. A running server
> writes over your changes when it saves.

### SQLite databases

`.db`, `.sqlite`, `.sqlite3`, `.db3`, `.s3db`, and `.sl3` files open in a table
viewer. Pick a table from **Tables** and edit cells, then **Save**. **Run a SQL
query** returns up to 1,000 rows, and only reads until you turn on **Allow
writes**. Stop the server before editing a plugin's database.

### Share a file

With a file open, **Share** uploads it to mclo.gs with IP addresses hidden,
and copies the link.
