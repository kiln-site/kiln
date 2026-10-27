---
title: Files
description: Browse, search, edit, upload, and download a game server's files, including Minecraft NBT files and SQLite databases.
---

The **Files** tab shows the game server's data folder: its worlds, configs,
plugins or mods, and logs. Your browser reads and writes them on the Relay.

## Find a file

The file tree on the left shows every folder. Select a file to open it.

To find a file by name, type in **Search files…** at the top of the tree. It
matches any part of a file's path, so `paper-global` finds
`config/paper-global.yml`.

To keep a file close at hand, open its actions menu and select **Pin**. Pinned
files show on the **Files Home** view. Select **Unpin** to remove it.

## Edit a file

Text files open in an editor with syntax highlighting.

- Press <kbd>Ctrl</kbd> <kbd>S</kbd> (<kbd>⌘</kbd> <kbd>S</kbd> on a Mac), or
  select **Save**, to save your changes.
- Press <kbd>Ctrl</kbd> <kbd>F</kbd> (<kbd>⌘</kbd> <kbd>F</kbd>) to find text in
  the file.
- Turn on **Wrap long lines** from the editor's menu.

Files up to 2 MiB open in the editor. Minecraft's archived logs, such as
`logs/2026-10-01-1.log.gz`, open as text too, read-only.

> [!TIP]
> Many games read their config files only at startup. Restart the server after
> you edit one.

## Edit NBT files

Minecraft keeps much of a world's data in binary NBT files, such as
`level.dat`, the files in `playerdata/`, and other `.dat`, `.dat_old`, and
`.nbt` files. Kiln opens them as SNBT, Minecraft's text form of NBT, so you can
read and edit them like any other file.

When you save, Kiln checks your SNBT and writes it back as binary NBT, gzipped
if the original was. If the SNBT has a mistake, the editor points to it.

> [!WARNING]
> Stop the server before you edit `level.dat` or a player's file. A running
> Minecraft server keeps these in memory and writes over your changes when it
> saves.

If you need to save SNBT that doesn't check out, select **Force save** from the
editor's menu. If Kiln can't encode it as NBT, it replaces the binary file with
your text, and Minecraft may not load it until you fix it.

## Edit SQLite databases

Files ending in `.db`, `.sqlite`, `.sqlite3`, `.db3`, `.s3db`, or `.sl3` open in
a table viewer, so you can read plugins' SQLite databases without downloading
them.

- Pick a table from **Tables** to page through its rows.
- Edit a cell in place. Your edits stay staged until you select **Save**, or
  press <kbd>Ctrl</kbd> <kbd>S</kbd> (<kbd>⌘</kbd> <kbd>S</kbd>).
- Select **Run a SQL query** to open the query editor, write SQL, and select
  **Run**, or press <kbd>Ctrl</kbd> <kbd>Enter</kbd> (<kbd>⌘</kbd>
  <kbd>Enter</kbd>). Results are limited to 1,000 rows.
- Queries can only read until you turn on **Allow writes**.

> [!WARNING]
> Plugins may cache or overwrite rows while the server runs. Stop the server
> before you edit a plugin's database.

## Upload files

Drag files or folders from your computer onto the file list, or select
**Upload**, then **Upload files** or **Upload folder**. Uploads go into the
folder you have open.

## Download files

Open a file's actions menu and select **Download**. In the dialog:

1. Change the name under **Save as** if you like.
2. Turn on **Compress download** to download it as a **ZIP** or **Gzip**
   archive. Hearth says whether the file should compress well.
3. Select **Download**.

Check **Don't show this again** to skip the dialog next time.

## Manage files

Each file and folder has an actions menu with:

| Action        | What it does                                                    |
| ------------- | --------------------------------------------------------------- |
| **Open**      | Opens the file in the editor, or the folder in the list.        |
| **Rename**    | Renames it in place.                                            |
| **Move**      | Moves it to another folder.                                     |
| **Download**  | Downloads it to your computer.                                  |
| **Archive**   | Packs it into a `.zip` archive beside it, under a name you pick. |
| **Unarchive** | Unpacks a `.zip`, `.tar.gz`, or `.tgz` file into a new folder.  |
| **Duplicate** | Makes a copy beside it.                                         |
| **Delete**    | Deletes it.                                                     |
| **Pin**       | Keeps it on **Files Home**.                                     |

Select several files with their checkboxes to act on them together.

## Share a file on mclo.gs

When a file is open, select **Share** in the editor's toolbar to upload it to
[mclo.gs](https://mclo.gs), a public log-sharing site for Minecraft. Kiln hides
IP addresses in the upload and copies the link to your clipboard. Select the
button again to open the log.

> [!CAUTION]
> Anyone with the link can read what you share. Check the file for player
> names and secrets first.
