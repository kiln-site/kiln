---
title: The kiln CLI
description: Install the kiln command to manage your Relays, game servers, backups, and files from a terminal.
---

The `kiln` command manages Kiln from your own computer. Use it to script
routine work or to reach a game server without opening Hearth:

- List your Relays and game servers, and read their details.
- Create, reconfigure, and delete game servers.
- Start, stop, restart, and kill game servers.
- Send console commands and read or follow logs.
- List, read, write, upload, and download game server files.
- Create, download, restore, and delete backups.
- Read the activity history.

It acts as your account, with the same permissions you have in Hearth. See
[Authentication](/cli/authentication).

## Install

On Linux or macOS, run:

```sh title="On your computer"
curl -fsSL https://kiln.site/install | sh -s -- --cli
```

The installer downloads the newest stable CLI, checks it against the
release's SHA-256 digest, and puts it in `/usr/local/bin` when run as root,
otherwise `~/.local/bin`. It doesn't need Docker. Add `--nightly` for the
newest nightly build.

On Windows, download `kiln.exe` from the
[GitHub releases](https://github.com/kiln-site/kiln/releases) and put it on
your `PATH`. Releases also have standalone archives for Linux and macOS, on
x64 and ARM64.

> [!NOTE]
> macOS builds aren't notarized. If you download one in a browser instead of
> with the installer, clear the quarantine flag before running it:
> `xattr -d com.apple.quarantine kiln`.

Check it's installed:

```sh
kiln --version
```

## Sign in

Sign in with your Kiln's address:

```sh
kiln login https://kiln.example.com
```

Your browser opens to approve the CLI. See
[Authentication](/cli/authentication) for profiles, read-only access, and
tokens.

## Update

```sh
kiln update
```

This replaces the CLI with the newest build on the same channel, stable or
nightly, after checking its digest, size, and version. It updates only the
CLI, not Hearth or your Relays, and doesn't need you to be signed in.

## Get help

`kiln help` lists every command and option. See
[CLI commands](/cli/commands) for each one in detail.
