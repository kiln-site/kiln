---
title: The kiln CLI
description: Install the kiln command, sign it in to your Kiln, and manage Relays, game servers, backups, and files from a terminal.
---

The `kiln` command manages game servers, files, logs, backups, and activity
from your own computer, with your account's permissions. See
[CLI commands](/cli/commands).

## Install

```sh title="On Linux or macOS"
curl -fsSL https://kiln.site/install | sh -s -- --cli
```

The installer checks the CLI's SHA-256 digest and puts it in `/usr/local/bin`
as root, otherwise `~/.local/bin`. It doesn't need Docker. Add `--nightly` for
the nightly build. `kiln update` updates the CLI later.

On Windows, put `kiln.exe` from
[GitHub releases](https://github.com/kiln-site/kiln/releases) on your `PATH`.

> [!NOTE]
> macOS builds aren't notarized. If you download one in a browser, run
> `xattr -d com.apple.quarantine kiln` first.

## Sign in

```sh
kiln login https://kiln.example.com
```

1. The CLI opens your browser with a code. Check it matches.
2. Choose the CLI's access:
   - **Read-only access** lets it read and download, but change nothing.
   - **Access duration** is **1 hour**, **1 day**, **1 week**, or 30 days by
     default. A read-only CLI can also be **Indefinite**.
3. Click **Authorize CLI**.

Over SSH, add `--no-open` and open the printed URL on any device. Run
`kiln login` again when the credential expires, and `kiln whoami` to check
which account and Kiln you're using.

## Profiles

A profile is one saved sign-in. Add one per Kiln:

```sh
kiln login https://staging.example.com --profile staging
kiln servers list --profile staging
```

Signing in makes that profile active. Profiles are saved in
`~/.config/kiln/config.json`. The credential goes in the macOS Keychain or
Windows Credential Manager; on Linux it stays in the config file, readable
only by you.

`kiln logout` revokes the credential and removes the profile. You can also
**Unlink** a CLI in Hearth's **Settings → Account**.

## Scripts and CI

`KILN_URL`, `KILN_TOKEN`, and `KILN_CONFIG` override the saved profile's
address, credential, and config file. `--url` and `--token` do the same for
one command.

> [!CAUTION]
> A token acts as your account. Keep it out of logs, shell history, and
> committed files. Use a read-only CLI for anything that only reads.
