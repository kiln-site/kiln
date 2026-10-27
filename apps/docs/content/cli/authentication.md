---
title: Authentication
description: Sign the kiln CLI in to your Kiln, keep several profiles, choose read-only access, and unlink a CLI you no longer use.
---

The CLI signs in through Hearth in your browser. It acts as your account and
keeps the permissions you already have there. It never gets more.

## Sign in

```sh
kiln login https://kiln.example.com
```

1. The CLI prints a URL and a code, and opens your browser.
2. Sign in to Hearth if you aren't already, and check the code matches.
3. Choose the access the CLI gets. See
   [Read-only access](#read-only-access) and
   [Access duration](#access-duration).
4. Click **Authorize CLI**.

The CLI finishes signing in and says where it saved the credential.

If the CLI can't open a browser, such as over SSH, add `--no-open` and open
the printed URL yourself, on any device. You can also go to `/cli/authorize`
on your Hearth and type the code.

Each linked CLI is named after the computer it runs on. Choose your own name
with `--name`:

```sh
kiln login https://kiln.example.com --name workstation
```

When you don't give an address, `kiln login` uses `KILN_URL`, then the
address the profile already has, then `https://kiln.site`.

### Read-only access

Turn on **Read-only access** to let the CLI look but not change anything. It
can list Relays and game servers, read logs, activity, and files, and
download files and backups. It can't use power or the console, write or
upload files, or create, restore, or delete anything, whatever your account's
permissions allow.

### Access duration

**Access duration** sets when the credential expires: **1 hour**, **1 day**,
**1 week**, or the default, 30 days unless your Kiln's operator changed it
with `KILN_CLI_DEFAULT_ACCESS_DAYS`. A read-only CLI can also be linked
**Indefinite**.

When a credential expires, run `kiln login` again.

## Check who you are

```sh
kiln whoami
```

This prints your name, email, the CLI's access (`full access` or
`read only`), the profile, and the Hearth address. Run it before any change
to be sure you're pointed at the right Kiln.

## Profiles

A profile is one saved sign-in: an address and its credential. The first one
is called `default`. Add a profile for each Kiln you use:

```sh
kiln login https://staging.example.com --profile staging
```

Signing in makes that profile the active one. Pass `--profile` to any command
to use another:

```sh
kiln servers list --profile staging
```

Profiles are saved in `~/.config/kiln/config.json`, or in
`$XDG_CONFIG_HOME/kiln/config.json` when that's set. The credential itself
goes in the macOS Keychain or Windows Credential Manager. On Linux, or when
the system's credential store isn't available, it's kept in the config file,
readable only by you, and `kiln login` tells you so.

## Sign out

```sh
kiln logout
```

This revokes the credential in Hearth and removes the profile. Add
`--profile` to sign out of another one.

You can also unlink a CLI from Hearth: open **Settings → Account**, find it
under **Linked CLIs**, and click **Unlink**. The list shows each CLI's access
and when it was last used.

## Tokens and automation

For scripts and CI, these environment variables override the saved profile:

| Variable      | Sets                                                    |
| ------------- | ------------------------------------------------------- |
| `KILN_URL`    | The Hearth address.                                     |
| `KILN_TOKEN`  | A token to use instead of the profile's credential.     |
| `KILN_CONFIG` | The path of the config file to read and write.          |

`--url` and `--token` do the same for a single command. A token passed this
way isn't saved.

> [!CAUTION]
> A token acts as your account. Keep it out of logs, shell history, and
> committed files. Prefer a read-only CLI for anything that only reads.

## When access changes

The CLI always uses your account's current permissions. If an administrator
changes your access, the CLI follows. If your account is disabled, the CLI
stops working until it's enabled again; it doesn't need to sign in again
unless its credential expired or was revoked.

An invitation grants nothing until you accept it in Hearth.
