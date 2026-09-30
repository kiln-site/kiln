# Kiln CLI

Command-line access to Kiln and self-hosted Hearth instances. The CLI uses
readable tables, plain log and file output, and concise status messages.

## Install

Run without a global install:

```sh
npx kiln-cli --version
npx kiln-cli login
```

Or install it globally. The npm package is named `kiln-cli`; both installation
methods expose the `kiln` command.

```sh
npm install --global kiln-cli
kiln login
```

Update an existing global CLI installation with:

```sh
kiln update
```

The updater reuses pnpm or Bun when it can identify that package manager as the
owner of the installed CLI. Otherwise, and whenever that update fails, it uses
`npm install --global <distribution-package>@latest` (`kiln-cli` for official builds). This updates only the local Kiln CLI,
not Hearth or any Relay.

## Install the agent skill

Install the Kiln skill globally so supported coding agents can discover and use
the CLI across projects:

```sh
npx skills@latest add kiln-site/kiln --skill kiln-cli --global
```

The installer detects supported agents and places the standard Agent Skill in
their user-level skill directories. Omit `--global` to install it only in the
current project.

## Build locally

```sh
pnpm --filter kiln-cli build
./apps/cli/dist/kiln --version
```

Bun compiles the app into `dist/kiln`; Bun does not need to be installed on
the machine running that executable. Local macOS builds are ad-hoc signed with
the JavaScript runtime entitlements required by Bun.

## Authenticate

```sh
kiln login
kiln login https://hearth.example.com --name workstation --no-open
```

Login honors `KILN_URL` and the selected saved profile before the build's default URL. Official builds default to `https://kiln.site`; fork builds can set their own default. The command opens a browser and
waits while you approve the sign-in. Self-hosted Hearth installations are
selected with the positional URL or `--url`. Named profiles are available
through `--profile`.

`KILN_URL` and `KILN_TOKEN` can bypass the saved profile in CI or scripts.
Interactive logins store credentials in macOS Keychain or Windows Credential
Manager. The profile URL and credential reference remain in the owner-only Kiln
config file. Existing plaintext profiles migrate automatically the next time the
CLI needs their saved credential. Explicit token overrides bypass migration,
and login or logout can replace or remove a legacy profile directly. If a
native manager temporarily cannot store a legacy credential, the CLI uses the
existing token for that command, leaves it pending, and retries on later use.

When a supported system credential manager is unavailable, such as on a
headless Linux host, the CLI falls back to storing the credential in the
owner-only config file and prints a warning during login. If a manager exists
but cannot store the credential, the warning identifies that failure instead.
`kiln logout` revokes the active credential, removes its profile, and deletes
its system credential.

## Discover and operate

```sh
kiln relays list
kiln relay info <relay-id>
kiln activity list --limit 200
kiln servers list
kiln servers create <relay-id> paper --name survival --memory 4GiB --disk 25GiB
kiln server info <relay-id>:<instance-id>
kiln server startup <relay-id>:<instance-id> --memory 6GiB --java-version 25
kiln server brick <relay-id>:<instance-id> fabric --game-version 1.21.11
kiln server power <relay-id>:<instance-id> restart
kiln server logs <relay-id>:<instance-id> --follow
kiln server console <relay-id>:<instance-id> "say deploy complete"
kiln files list <relay-id>:<instance-id> .
kiln files read <relay-id>:<instance-id> server.properties
kiln files write <relay-id>:<instance-id> server.properties ./server.properties
kiln files download <relay-id>:<instance-id> logs/latest.log ./latest.log
kiln files upload <relay-id>:<instance-id> ./plugins/example.jar plugins/example.jar
kiln files upload <relay-id>:<instance-id> https://example.com/example.jar plugins/example.jar
kiln backups list --limit 200
kiln backups create server <relay-id>:<instance-id> --name "Before update"
kiln backups create server <relay-id>:<instance-id> --storage <destination-uuid>
kiln backups create server <relay-id>:<instance-id> --mode full
kiln backup download <backup-id>
kiln server delete <relay-id>:<instance-id> --confirm <relay-id>:<instance-id>
```

Disk quotas must be at least `0.1GiB`, matching the Relay allocation minimum.
Server backups default to incremental restic snapshots and accept exactly one
Relay-local or S3-compatible destination. Full archives can use multiple
destinations.

Uploads and downloads use the Relay SFTP endpoint and verify its advertised
SSH host-key fingerprint. HTTPS upload sources are downloaded directly by the
Relay through the authenticated control channel and reject private or reserved
network destinations. Other file operations use the versioned CLI API.
Read-only credentials can discover authorized resources, follow logs, and read
files, but cannot create or delete servers, change startup settings, power
servers, send console commands, modify files, or upload.

Run `kiln help` for the complete command reference.

Fork maintainers: see [distribution publishing](../../docs/forking.md).
