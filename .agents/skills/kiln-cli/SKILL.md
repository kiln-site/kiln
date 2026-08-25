---
name: kiln-cli
description: Use the Kiln CLI to authenticate, select profiles, inspect Relays, activity, backups, and server metadata, create or delete servers, create, restore, download, or delete backups, change Bricks and startup settings, inspect logs, send console or power commands, and manage server files including Relay-side HTTPS downloads. Use when a user asks to run, test, or troubleshoot `kiln` commands or mentions Kiln CLI Relay/server references, backups, startup settings, remote paths, or file transfers.
---

# Kiln CLI

Use the locally installed `kiln` command to operate Kiln and self-hosted Hearth
servers. Run requested commands when the binary and authentication are already
available; do not stop at providing command examples.

## Safety and credentials

- Treat server creation/deletion, Brick or startup changes, power actions,
  console commands, file writes, and uploads as remote mutations. Verify an
  ambiguous target or destination before running them. An explicit user
  request naming the Relay/server, action, and path is sufficient
  authorization. Server deletion additionally requires the exact server
  reference through `--confirm`.
- Never print, copy, or commit a Kiln token. Prefer saved profiles. Use
  `KILN_TOKEN` or `--token` only when the user deliberately provides an
  ephemeral credential, and keep it out of reported command output.
- Interactive login stores credentials in macOS Keychain or Windows Credential
  Manager. Existing plaintext profiles migrate when their saved credential is
  next used; explicit tokens bypass migration, and login or logout can replace
  or remove a legacy profile directly. A failed native migration leaves the
  plaintext credential pending so later use can retry. Headless or unsupported
  systems fall back to the owner-only config file and report that fallback
  during login.
- Do not inspect the saved config file unless authentication or profile
  resolution itself is being debugged. If inspection is necessary, redact the
  complete token value.
- Do not silently switch a command between production Kiln and a self-hosted
  Hearth URL. Confirm the active target with `kiln whoami`.
- Interrupting the CLI closes local HTTP and SFTP work, but it does not roll
  back a mutation that Hearth or a Relay already accepted. After interrupting
  a power, console, file-write, or other mutation, read the affected resource
  before deciding whether to retry.

## Preflight

Start with the smallest useful checks:

```sh
command -v kiln
kiln --version
kiln whoami
```

If the binary is missing, report that before suggesting installation. If
authentication is missing, use the appropriate login flow:

```sh
kiln login
kiln login https://hearth.example.com --profile staging --name workstation
```

`kiln login` targets `https://kiln.site` by default and normally opens a
browser. Add `--no-open` when the environment cannot launch one. Do not start a
new login when an authenticated profile already targets the requested Hearth.
`kiln logout` revokes the credential before removing both the saved profile and
its system credential. If native credential deletion fails, the CLI reports a
warning after removing the profile.

Use `--profile <name>` on any command to select a saved profile. `KILN_URL`,
`KILN_TOKEN`, and `KILN_CONFIG` support isolated automation, but prefer the
user's existing authenticated profile for interactive work.

## Update the CLI

Update the locally installed CLI with:

```sh
kiln update
```

This reinstalls `kiln-cli@latest` globally through pnpm or Bun when the CLI can
identify that installer, with npm as the default and fallback. It updates only
the CLI executable; it does not update Hearth, Relays, or managed servers, and
it does not require authentication.

## Resolve a server

Discover targets instead of guessing identifiers:

```sh
kiln servers list
```

Copy the entire value from the `ID` column. Every server command requires this
combined reference:

```text
<relay-id>:<instance-id>
```

The relay ID and instance ID are both required. Do not pass the instance ID by
itself, a short ID, or the display name.

## Relays and activity

List only the Relays available to the authenticated account:

```sh
kiln relays list
```

Copy the complete Relay ID from that output when another command requires it.
Inspect safe Relay/node metadata and resource capacity with:

```sh
kiln relay info <relay-id>
```

The account must have Relay-level read access. An instance-only grant does not
grant access to node metadata.

Read recent activity visible through the account's Relay and instance grants:

```sh
kiln activity list --limit 200
```

Activity is scoped server-side. Missing entries may belong to resources the
current account cannot access.

## Server metadata and lifecycle

Inspect safe server metadata, limits, state, and current resource usage:

```sh
kiln server info <server>
```

Lifecycle timestamps in the server response are represented as ordered
`{ state, time }` events. There are no separate `startedAt` or `readyAt`
fields.

The response omits Brick variables, container identifiers, and internal paths.
For custom Brick sources, credentials, query parameters, and fragments are
removed from the displayed URL.

Create a server on a provisioning-enabled Relay with a Brick ID from the
account's Hearth catalogs or a custom HTTPS recipe:

```sh
kiln servers create <relay-id> paper --name survival --memory 4GiB --disk 25GiB
kiln servers create <relay-id> https://example.com/custom-brick.yml \
  --name custom --variable version=1.0.0
```

Server creation requires a full-access CLI credential. Platform administrators
can create on any Relay; Bring Your Own Relays users can create only on Relays
they paired. Disk quotas must be at least `0.1GiB`, matching the Relay
allocation minimum. `--no-start` leaves the new server stopped.

Permanently delete a server and its data only after verifying the full target:

```sh
kiln server delete <server> --confirm <server>
```

The confirmation must exactly match `<relay-id>:<instance-id>`. Deletion
requires full CLI access and `instance.delete` permission.

## Backups

Discover every server, database, and platform target that the active account
can back up:

```sh
kiln backups targets
```

List visible backups and copy the complete UUID from the `ID` column:

```sh
kiln backups list --limit 200
```

The `DEST` column consolidates the logical backup's destinations, such as
`local+s3`; it does not repeat a backup once per destination. The `MODE`
column is `incremental` (restic snapshots, the server default) or `full`
(portable zip archives).

Create a manual backup with a reference from `backups targets`. Server backups
default to incremental restic snapshots stored on the Relay or an S3
destination. Pass `--mode full` for a portable zip, which can also use local or
S3 storage. Incremental mode accepts exactly one destination.

```sh
kiln backups create server <relay-id>:<instance-id> --name "Before update"
kiln backups create server <relay-id>:<instance-id> --storage <destination-uuid>
kiln backups create server <relay-id>:<instance-id> --mode full --storage local
kiln backups create database <relay-id>:<database-id> --name "Before migration"
kiln backups create platform <relay-id> --name "Before Hearth update"
```

The default destination follows the server backup policy and otherwise uses
Relay-local storage. Override it explicitly when needed:

```sh
kiln backups create server <server> --storage local
kiln backups create server <server> --storage <destination-uuid>
kiln backups create server <server> --mode full --storage local
kiln backups create server <server> --mode full --storage <destination-uuid>
```

Restore a complete server or database backup by UUID, including incremental
snapshots. A full safety backup is created first unless explicitly disabled.
Game servers must be stopped; managed databases remain online for their
logical import:

```sh
kiln backup restore <backup-id>
kiln backup restore <backup-id> --no-safety-backup
```

Download through a temporary signed URL without printing the URL itself. The
backup filename is used when the local path is omitted. Incremental snapshots
are exported to a zip first; the command waits until that export is ready:

```sh
kiln backup download <backup-id>
kiln backup download <backup-id> ./before-update.zip
```

Permanently remove a retained or failed backup only after confirming the exact
UUID:

```sh
kiln backup delete <backup-id> --confirm <backup-id>
```

Create, restore, and delete require a full-access CLI credential and the
matching backup permission. Relay owns the durable single-worker queue, so a
successful reservation can report that it will resume after Relay reconnects.
Platform restores remain an offline Hearth operation and are not exposed as a
CLI restore command.

## Bricks and startup settings

Change a server's Brick with an ID from the account's Hearth catalogs or a
custom HTTPS recipe:

```sh
kiln server brick <server> paper --memory 4GiB --game-version 1.21.11
kiln server brick <server> https://example.com/custom-brick.yml \
  --variable channel=stable
```

Changing Bricks starts from the new recipe's defaults plus variables supplied
on the command. It does not carry old Brick variables into the new recipe.

Patch settings on the current Brick while preserving variables that are not
mentioned:

```sh
kiln server startup <server> --memory 6GiB
kiln server startup <server> --disk 40GiB --java-version 25
kiln server startup <server> --game-version 1.21.11 \
  --variable online_mode=json:false
kiln server startup <server> \
  --variable java_args="-XX:+UseG1GC -XX:+AlwaysPreTouch"
```

Settings omitted from a startup patch, including the disk quota, are preserved.
Use `--disk` only when the quota should change.

Use `--variable name=value` for string variables. Prefix the value with
`json:` for numbers or booleans, such as `slots=json:20` or
`debug=json:true`. `--no-start` leaves the reconfigured server stopped.
Startup changes require full CLI access and `instance.settings` permission.

## Remote path rules

Treat all remote paths as relative to the selected server root.

- Use `bukkit.yml`, `logs/latest.log`, or `plugins/example.jar`.
- Do not prefix a path with `/`.
- Do not include the host/container prefix `/data`; the CLI already scopes the
  operation to the server root.
- Do not use `.` or `..` as a file path. `.` is valid only as the directory
  argument to `files list`.

For example, read the root-level Bukkit configuration with:

```sh
kiln files read <server> bukkit.yml
```

## Files

List a directory before acting when the requested path is uncertain:

```sh
kiln files list <server> .
kiln files list <server> plugins
```

Read text to stdout:

```sh
kiln files read <server> bukkit.yml
```

Use `files read` for text inspection. Use `files download` for binary files or
when preserving exact bytes matters.

Write text from a local file or standard input:

```sh
kiln files write <server> server.properties ./server.properties
kiln files write <server> whitelist.json -
```

Text writes use the CLI API and accept at most 16 MiB from standard input.

Download one remote file over SFTP:

```sh
kiln files download <server> plugins/example.jar ./example.jar
```

If the local destination is omitted, the CLI uses the remote basename in the
current directory.

Upload one regular local file over SFTP:

```sh
kiln files upload <server> ./example.jar plugins/example.jar
```

If the remote destination is omitted, the CLI uses the local basename in the
server root. The remote parent directory must already exist. Uploads and
downloads verify the Relay's advertised SSH host-key fingerprint.

Ask the Relay to download a file directly from an HTTPS URL:

```sh
kiln files upload <server> https://example.com/plugin.jar plugins/plugin.jar
```

If the destination is omitted, the CLI uses the URL path's decoded basename.
Supply a destination when the URL has no filename. Relay-side downloads accept
HTTPS only, follow at most five HTTPS redirects, reject credentials embedded in
URLs, block private/loopback/link-local/reserved destinations (including after
DNS resolution and redirects), enforce the 20 GiB transfer limit, and replace
the destination atomically. They require full CLI access,
`instance.files.write` in Hearth, and `instance.files.upload-url` in the Relay
client policy.

After a mutation, verify with the least expensive read operation, such as
`files list` or `files read`. Do not print binary content for verification.

## Logs, console, and power

Read recent logs or follow the stream:

```sh
kiln server logs <server> --limit 200
kiln server logs <server> --limit 200 --follow
```

Send a one-line console command:

```sh
kiln server console <server> "say deploy complete"
```

If the command argument is omitted, the CLI reads it from standard input.

Use only the supported power actions:

```sh
kiln server power <server> start
kiln server power <server> stop
kiln server power <server> restart
kiln server power <server> kill
```

Treat `kill` as destructive and reserve it for an explicit request or a server
that cannot stop normally.

## Diagnose failures

Preserve the exact failing command, CLI version, active Hearth URL, server
reference, error code, request ID when shown, cause details, and message. Never
include the token.

Use this sequence to isolate the layer:

1. Run `kiln whoami` to verify authentication, profile, access mode, and URL.
2. Run `kiln relays list` or `kiln servers list` to confirm the full target is
   still available.
3. Run `kiln files list <server> .` to test the normal CLI API and Relay.
4. For a text path, run `kiln files read <server> <path>` to test file reads.
5. Run the requested upload or download. Local transfers test SFTP bootstrap
   and transport; HTTPS sources test the authenticated Hearth-to-Relay control
   path and Relay egress policy.

Interpret the result narrowly:

- If `sftp_unavailable` says the Relay port is not published, Docker inspection
  proved that no host mapping exists. Publish the reported TCP port and retry.
- A loopback-only publication can work when the CLI runs on the Relay host. If
  the CLI runs elsewhere and the handshake times out, publish the port on a
  reachable host address; do not describe the loopback binding as universally
  unavailable or as proof of a firewall problem.
- If list and read work but upload and download fail, focus on the SFTP
  bootstrap response, Relay SFTP reachability, authentication, or host-key
  verification. General file reads do not use the same transfer path.
- If a local SFTP upload works but an HTTPS upload fails, inspect the URL,
  redirect chain, public DNS resolution, Relay egress, remote HTTP status, and
  the Relay client's `instance.files.upload-url` action.
- If all file operations fail, check the profile URL, credential access,
  server reference, Relay availability, and root-relative path first.
- If a root file is not found, retry the path without `/` or `/data/`.
- If an upload reports a local-file error, confirm the source exists and is one
  regular file. Directory uploads are not supported.
- If Hearth returns HTTP 500, treat it as a server-side defect. Correlate the
  request with application logs, Sentry, or traces when available; do not add
  proxy or routing workarounds without evidence that routing is the cause.
- If a console write reports `relay_operation_failed`, use its request ID to
  correlate Relay logs; no activity entry means the Relay did not accept the
  command. A bare `http_502` has no Kiln error details and may have been
  generated by the Hearth proxy before the request reached Hearth.
- If a requested power stop returns `failed (desired stopped)`, run
  `kiln server info <server>` and read its `Reason`. If it reports an
  out-of-memory kill, the process may not have shut down gracefully. Increase
  the memory limit before the next start or use the server's console stop
  command.

When reporting completion, state the operation, server, remote path, local path
when applicable, and observed result. Call out partial success and roadblocks
explicitly.
