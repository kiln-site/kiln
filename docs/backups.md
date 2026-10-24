# Backups

This document defines Kiln's backup architecture and the delivery order for the
first implementation. Scheduling is intentionally outside the first release;
manual tasks use the same durable task model that schedules can enqueue later.

## Goals

- Back up game servers, managed databases, and the Kiln installation.
- Store backups on the Relay or in an S3-compatible bucket.
- Allow a platform S3 destination or a user-owned S3 destination to be chosen
  per resource.
- Let Relay finish work while Hearth is disconnected and reconcile the result
  after reconnecting.
- Serialize backup and restore work per Relay to bound disk, CPU, and network
  pressure.
- Enforce per-resource quantity and logical-size limits set by the resource
  owner, with optional stricter platform-admin caps.
- Restore with one clear action and optionally create a safety backup first.
- Produce short-lived download URLs for both local and S3 artifacts.
- Take a portable full backup before destructive resource deletion.
- Deduplicate live game-server backups with Relay-local restic snapshots.

## Ownership model

Hearth owns intent, policy, authorization, and the user-visible catalog. Relay
owns execution, temporary files, local artifacts, and the durable task journal.
The managed server or database process never owns the backup job.

1. Hearth authorizes a request, evaluates the effective limits, creates the
   catalog record, and submits an idempotent task ID.
2. Relay persists the complete task before acknowledging it.
3. One Relay worker claims the oldest queued task and runs it independently of
   the control socket.
4. Relay atomically persists progress and the terminal result. Events are an
   optimization, not the source of truth.
5. Hearth consumes events while connected and lists tasks changed since its
   last cursor whenever a Relay reconnects.

Submitting an existing task ID returns its current task rather than starting a
second operation. A Relay restart changes an interrupted `running` create or
idempotent delete task back to `queued`. Relay-local work is immediately
reclaimable and continues without Hearth. If a repeatable task contains an
expiring signed S3 request, Relay sets `inputRefreshRequired`, leaves the task
unclaimable, and exposes that flag when Hearth lists tasks after reconnecting.
Hearth then signs fresh input and re-enqueues the same task ID; Relay atomically
replaces the durable input, clears the flag, and wakes the worker. Orchestration
must use the flag rather than infer this handshake from an error message. A task
that reached a non-repeatable restore step is marked failed for explicit review
instead of guessed at.

Effect's `Queue` is the in-process wake-up mechanism and a one-permit
`Semaphore` protects the worker. The SQLite task journal supplies durability;
an in-memory Effect queue by itself cannot meet the disconnect or restart
requirements. Effect's experimental persisted/workflow queues are not used in
the first release because Relay already has a small, proven SQLite state layer
and adopting the experimental persistence stack would add a second storage
abstraction for one consumer.

Create tasks have a bounded runtime. Relay cancels and aborts a backup after
`KILN_BACKUP_TIMEOUT` minutes; the default is `60`. The timeout starts when the
worker claims the task, so time spent queued does not consume its runtime.

## Catalog and policy

A backup records its Relay, target kind and ID, artifact kind, reason, storage
destination, byte size, SHA-256 digest, warnings, and lifecycle timestamps.
Backup tasks separately record create, restore, and delete execution. This
keeps a successful artifact available while a later restore attempt is running
or has failed.

Targets are:

- `instance`: a game server data directory;
- `database`: a managed database logical dump;
- `platform`: Hearth's database and the recoverable Kiln configuration.

Reasons are `manual`, `pre_restore`, `final_delete`, and `scheduled`.
Artifact kinds start with `archive`, `database_dump`, and `platform_bundle`.
A `full`/`incremental` mode is recorded independently so a future Restic
artifact does not require a catalog migration.

Each resource can set a preferred destination, exclude patterns, quantity
limit, and total logical-size limit. Platform admins can set caps. The
effective numeric limit is the lower non-null value. `0` disables new backups;
`null` is unlimited. Queued/running creates reserve one quantity slot and their
configured maximum bytes so concurrent requests cannot race past a limit.
Failed artifacts do not consume retention. Final-deletion backups bypass a
user limit but not Relay free-space safety checks or a platform cap explicitly
configured to block backups.

When adding a normal backup would exceed a limit, creation fails without
silently deleting data. A later retention policy may offer opt-in oldest-first
pruning, with protected/final backups excluded.

## Storage destinations

Relay-local storage is implicit and scoped to that Relay. Files live below a
dedicated data directory using controlled UUID paths, never user-supplied
paths. Hearth stores S3-compatible destinations with encrypted credentials.
An owner ID of `null` makes a destination platform-wide; otherwise only that
user can select it. Destination removal is blocked while cataloged artifacts
still depend on it.

Destination implementations are isolated by kind:

```text
apps/web/src/backups/destinations/<kind>/
apps/relay/src/backups/destinations/<kind>/
```

The Hearth registry describes whether a destination implements the complete
full-backup and Restic standards. Full-backup support includes checking,
saving, reading, downloading, restoring, and deleting an archive. Restic
support includes repository checks, snapshots, exported downloads, restores,
snapshot deletion, and pruning. A destination must implement at least one
complete standard; it cannot advertise a partial format.

The Relay registry owns execution details such as local retention, artifact
size ceilings, archive writes/deletes, Restic repository locations, process
arguments, and credentials. Adding a destination means adding its directory
and registering its typed definition. Shared orchestration should not grow a
new destination-specific branch. Wire-contract and persistence migrations are
still required when a new kind introduces a new task shape or stored
configuration; Local and S3 retain their existing shapes in this refactor.
Today, `storageId === null` is also the persisted discriminator for Relay-local
storage. A third configured kind therefore needs a persistence discriminator
and updates to the shared selectors that translate stored artifacts into the
registry kind. The registries centralize destination behavior, but they are not
dynamic plugin loading.

S3 credentials never go to a game container and are not returned to the
browser. Full archives still use Hearth-signed, narrowly scoped object
requests. Incremental restic repositories cannot be driven with presigned
URLs, so Relay receives the destination's static keys inside the durable task
input (see Incremental snapshots). The first full-archive implementation
stages one artifact locally, validates its size and digest, then uploads it.
The single queue plus free-space preflight prevents the unbounded concurrent
staging failure seen in other panels. Multipart streaming can replace this
adapter later without changing task or catalog contracts. The initial
single-request full-archive adapter has a 5 GiB artifact ceiling; restic S3
pack writes are not subject to that ceiling.

User-owned endpoints must resolve exclusively to public network addresses on
every connection. Platform administrators may explicitly allow private
addresses for trusted MinIO or Ceph RGW deployments; ordinary users cannot turn
that SSRF boundary off.

Object keys are generated, not supplied by users:

```text
kiln/<installation>/<relay>/<target-kind>/<target-id>/<backup-id>/<filename>
```

`<installation>` is the installation ID: `KILN_INSTALLATION_ID` when set,
otherwise the one Hearth generates on its first start and saves. Installations
from before saved IDs used `kiln`. Each backup and restic repository records
its own key, so existing backups stay where they are and new ones use the
installation ID.

S3 downloads use a short-lived presigned GET. Local downloads use a
single-purpose Relay token bound to backup ID, user, expiry, and disposition.
Neither form is a permanent public URL. The default lifetime is five minutes
and can later be exposed as an admin maximum.

## Formats and live consistency

Game-server backups are portable compressed archives of the data directory.
The walker rejects path traversal and special files, understands gitignore
patterns, ignores known ephemeral lock files by default, and records files that
vanish or change size/mtime while read. A changed file is retried once; a
second change becomes a visible warning instead of being silently presented as
an application-consistent snapshot.

Running servers do not need to stop for backup. Brick-defined consistency hooks
can improve a live backup. Minecraft Bricks should run `save-off`, then
`save-all flush`, archive, and always run `save-on` in finalization. Without a
hook, Kiln promises a crash-consistent best effort, not transactional
consistency. Filesystem snapshot adapters (ZFS/Btrfs/LVM) can be added later.

Managed MySQL, MariaDB, and PostgreSQL databases stay running. Relay executes
the engine's logical dump tool into a `.dmp` stream and compresses it as
`.dmp.gz`; restore feeds the decompressed dump to the matching engine client.
Redis and Valkey backups are deferred until Kiln supports engine snapshots and
compression. Their deletion therefore proceeds without a final backup instead
of reserving a logical dump that Relay cannot create.

A platform bundle contains a logical Hearth database dump plus a versioned
manifest describing the installation. Relay gzip-compresses the dump and
encrypts it with AES-256-GCM using a key derived from the separately recoverable
`KILN_PLATFORM_BACKUP_KEY`; using only a live Hearth secret would make disaster
recovery circular. The first adapter targets the colocated Compose MySQL
database identified by installation-scoped Docker labels. External Hearth
databases will require an explicit platform-backup adapter rather than sending
connection credentials through Relay's task journal.

The bundle is a backup of Kiln's Hearth catalog, not its deployment
configuration. Operators must retain the Compose environment, TLS material,
and platform recovery key separately; rotating or losing application encryption
secrets can make restored secret-bearing catalog values unusable.
A Relay in platform mode keeps that configuration itself and exports it as a
recovery kit (`kiln-relay platform export-kit`); see
[Self-hosting](self-hosting.md#recovery).

Every artifact gets a manifest containing format version, target identity,
created time, engine/Brick metadata, exclusions, consistency warnings, logical
bytes, stored bytes, and SHA-256 digest.

## Kiln's own backups

Kiln is a backup target like any game server or database: pickers, schedules,
and the runs table show it as **Kiln**, backed up on the Relay beside it (the
one Kiln's pages use, preferring a Relay that reports this installation's
ID). Only platform administrators back Kiln up, by hand or on a schedule. Its backups are the encrypted platform bundles above.
Hearth stores a schedule target of kind `relay` for it, and the Relay turns it
into a `platform` backup of its installation.

A fresh installation backs Kiln up once a day, at 03:00 UTC, to the Relay,
keeping 30 days or 20 GiB. Migration 24 marks a database migrated before
anyone signed up; once an administrator and a Relay reporting this
installation exist, Hearth creates the **Kiln backups** schedule, owned by
the first administrator, and clears the mark, so deleting or editing it
sticks. The same sweep resends any schedule a Relay hasn't acknowledged, so
a first deploy that failed is retried.
Existing installations keep the schedules they chose.

Restoring Kiln stays offline (see below). Its Restore shows the commands for
the Relay's host and, where the Relay installed Kiln, opens that Relay's
terminal with `stop-hearth`, the restore, and `start-hearth` typed for the
operator to send.

## Retention

A schedule's backup action can keep its backups for a number of days, up to
a total size, or both (`retention`). Every ten minutes Hearth catalogs the
backups Relays made on their own, then deletes, oldest first, the scheduled
backups of each target at that destination that are past either limit. The
newest is always kept, so a target never loses its last scheduled backup to
retention. A backup doesn't record which schedule made it, so where two
schedules back up the same target to the same place, the more generous
retention applies to both, and one without retention keeps everything.
Deleting a backup deletes every copy of it, so one also copied to another
destination is never pruned; it still counts toward the size. Retention is
Hearth's: Relays never receive it, and setting it takes `backup.delete` on
each target as well as `backup.create`. Manual, pre-restore, and
final-deletion backups are never pruned.

## Restore and deletion safety

Game-server restore requires the instance to be stopped. Hearth can enqueue a
full safety backup first; restore is submitted only after that task succeeds.
Restore extracts into a sibling staging directory, validates every path and the
manifest, then swaps directories where the filesystem permits. If an atomic
swap is unavailable, Relay records the restore phase so recovery can complete
or roll back deterministically.

Database restore requires the database to be running. The logical import is a
tracked task and its output is bounded and redacted. A pre-restore dump is the
default recommendation.

Kiln platform restore is deliberately offline because importing Hearth's own
catalog while Hearth is serving requests cannot be made transactionally safe.
Stop Hearth, keep its MySQL and Relay containers running, and use:

```text
kiln-relay platform-backup inspect /data/backups/<backup-id>.zip
kiln-relay platform-backup restore /data/backups/<backup-id>.zip \
  --confirm <installation-id>
```

`inspect` prints the installation ID the bundle belongs to. The restore
verifies the authenticated manifest and ciphertext before replacing
the Hearth database. It refuses a mismatched installation and refuses to run
while a labeled Hearth application container is running. Start Hearth
afterward; normal Relay reconciliation repairs the restored catalog's queued
snapshot of the backup task.

Deleting a server or database becomes a durable compound operation: create a
`final_delete` full backup, verify it, then delete the resource. If backup
creation fails, deletion stops. A separately authorized force-delete escape
hatch can be added later; it must never be the default. S3 final backups remain
in the catalog after the resource row is gone. Relay-local final backups remain
tied to Relay availability.

## UI

Backups is the final item in the server navigation and a global page covering
servers, databases, and Kiln. Its main-sidebar button sits directly above
Activity. The page uses the shared server picker from Activity at the top and
the shared workspace table below it. Rows show name, target, destination,
reason, size, status/progress, and creation time. Actions are download,
restore, and delete. Transient outcomes use Sonner; queue state updates in
place without shifting the layout.

The create dialog selects a target and destination, shows effective quantity
and size headroom, and accepts exclusions. The restore dialog explains whether
the target must be stopped and defaults to "Take a safety backup first."
Storage configuration clearly separates platform destinations from "My S3"
destinations and never redisplays a saved secret.

## CLI

The CLI mirrors the same authorization and task APIs:

```text
kiln backups list [--server <ref>] [--database <ref>]
kiln backup create <resource> [--storage <id|local>] [--exclude <pattern>]
kiln backup status <backup-id>
kiln backup download <backup-id> [destination]
kiln backup restore <backup-id> [--safety-backup] [--confirm <resource>]
kiln backup delete <backup-id> --confirm <backup-id>
kiln backup storage list
```

`apps/cli/README.md` and `.agents/skills/kiln-cli/SKILL.md` must be updated in
the CLI layer of the stack.

## Incremental snapshots

Live game-server backups default to restic incremental snapshots. Each instance
has one restic repository per destination:

- Relay-local: `<data>/restic/instance/<id>/`
- S3-compatible: `s3:https://<endpoint>/<bucket>/<stored-prefix>` where the
  stored prefix is
  `<objectPrefix>/kiln/<installation>/<relay>/restic/instance/<targetId>/<repositoryId>`

Hearth generates a repository password on first use and encrypts it with the
installation keyring. For S3 repositories it also sends the destination's
static access key and secret inside the durable task input. These are the
destination keys as stored in Hearth, not scoped or temporary credentials —
Relay receives whatever those keys can do. Use least-privilege keys
(per-bucket or per-prefix policy) for destinations used with incremental mode.

Relay persists complete task input in its SQLite journal before acknowledging,
so secrets are durably stored while the task is live. Mitigations: mTLS control
socket, journal file mode 0600, task-list responses redact `repositoryPassword`,
`accessKeyId`, and `secretAccessKey`, terminal journal rows scrub those keys
even when the stored JSON is corrupt, and restic stderr is redacted before it
becomes a Relay error. A task that fails because credentials were rotated is
terminal; retry the operation so Hearth dispatches a new task with the current
keys. Queued tasks are not refreshed in place.

Restic cannot pin DNS itself. For S3 repositories the Relay starts a
per-invocation local HTTP CONNECT proxy on `127.0.0.1` and sets `HTTPS_PROXY`
only for that restic process. Every CONNECT resolves the requested host with the
same public-address policy as other backup downloads and connects to the vetted
IP. A derived host allowlist (endpoint, `bucket.endpoint`, and AWS regional /
dual-stack forms when the endpoint is on `amazonaws.com`) is a secondary
control that fails closed. TLS stays end-to-end inside the CONNECT tunnel.

A live server can have files restic can't read, such as one locked or
replaced mid-backup. restic still saves the snapshot and exits with code 3;
Kiln keeps it and lists the skipped files as the backup's warnings, shown
beside its size. A snapshot recovered after a Relay restart can't list them,
so it says so instead.

Quantity limits map to retained snapshot rows. Size limits use each snapshot's
logical restore size because physical repository bytes are shared. Database
dumps and platform bundles stay full archives. Incremental backups accept
exactly one destination. The 5 GiB single-PUT ceiling applies only to full
archive uploads, not to restic's own pack writes.

Downloading any backup yields the complete file. For restic snapshots (local or
S3), creating a download link reserves an `export` task. Relay runs
`restic dump -a zip`, fetching packs from the repository if needed, stages the
zip locally, and serves it with the existing Relay download token. Export files
expire after five minutes and are swept on Relay startup.

Delete runs `restic forget` for the cataloged snapshot, or — when a failed
create never recorded a snapshot ID — forgets snapshots tagged
`task:<createTaskId>`. A missing snapshot is treated as a successful forget.
The delete completes once the snapshot is forgotten, and in the same journal
transaction Relay queues an internal `prune` task that Hearth never lists,
unless one for that repository is already waiting. A prune waits while
deletes are queued, so deleting many backups of a server runs one prune after
the last delete; it doesn't wait behind later creates or restores, so space
is reclaimed even on a busy Relay. Prune on S3 rereads packs and rewrites
the repository, so it costs bandwidth. A failed or cancelled create also
queues a prune for data it uploaded without saving a snapshot, or for a
snapshot it forgot for exceeding the size limit, unless the storage or
repository refused the work, which a prune would hit too. Recovery never
prunes inside the create task itself.
Ordinary snapshot deletion never deletes the repository row; an empty repo is
the dedup base for later backups and costs a few KiB. A prune whose
repository was removed while it waited has nothing to do and succeeds.

restic writes a lock file before every command, reads included. When storage
refuses that write, such as a bucket at its provider's storage cap or a
read-only key, commands that only read the repository (snapshot lookups,
sizes, restores, and export downloads) run again with `--no-lock`, so backups
stay restorable. That's safe because the Relay's single backup worker is the
only writer to its repositories. Creates, forgets, and prunes still need the
lock, so they fail until the storage accepts writes again.

Pre-restore safety backups and final-deletion backups stay full zip archives
so recovery does not depend on a mutable repository. When an instance is
finally deleted, Hearth marks remaining incremental catalog rows deleted, nulls
`repository_id`, purges each S3 repository prefix (current object versions
only), and deletes the repository rows. Relay-side final deletion still
removes only the local repository directory. Versioned buckets retain old
object versions after DeleteObjects; configure a bucket lifecycle rule if that
storage must not remain billable.

Destination deletion is two-phase: the row is marked `deleting` so new backups
cannot select it, preferred destination policies that pointed at it are cleared,
S3 repository prefixes are purged, then foreign keys on deleted catalog rows are
cleared and the destination is removed. A purge failure leaves the destination
listed as `deleting` with `last_error` so the operator can retry instead of
silently orphaning data.

Development preview (`pnpm dev:docker`) starts a TLS MinIO at
`https://minio:9000`. Register it as a platform destination with path-style
access, private-network allowed, bucket `kiln-backups`, region `us-east-1`,
access key `kiln`, and secret `kilnminiodevpassword`. Hearth and the Relay's
full-archive uploads trust the generated certificate through
`NODE_EXTRA_CA_CERTS`; Relay restic uses `RESTIC_CACERT`.

Ceph RGW is already covered by the S3-compatible adapter. CephFS/RBD snapshots
are infrastructure-specific consistency sources, not a portable backup format,
and should be an optional Relay snapshot adapter rather than the default.

## Stacked delivery

1. `feat/backup-foundation`: this design, shared contracts, permissions,
   Hearth catalog/policy schema, and Relay durable task persistence.
2. `feat/backup-engine`: Relay's single worker, portable instance archives,
   local storage, task protocol, Hearth orchestration, reconciliation, and
   limit reservation.
3. `feat/backup-s3`: encrypted platform/user destinations, S3-compatible
   signing and validation, Backblaze integration, upload/delete, and signed
   downloads.
4. `feat/backup-restore`: safe instance restore, optional pre-restore backup,
   final-backup-before-delete, and local download tokens.
5. `feat/backup-databases`: compressed logical MySQL, MariaDB, and PostgreSQL
   dumps, database restore, and final-backup-before-delete.
6. `feat/backup-platform`: encrypted Kiln bundles and offline disaster-recovery
   restore tooling. Redis/Valkey snapshots follow once their consistency hook
   and ACL-safe snapshot path are defined.
7. `ui/backups`: Operations table, server Backups tab, filters, dialogs,
   progress/reconciliation, storage settings, accessibility, and responsive
   browser validation.
8. `feat/backup-cli`: list/create/status/download/restore/delete/storage CLI,
   help, README, and synchronized CLI skill documentation.
9. `feat/backup-restic`: incremental restic snapshots as the instance default,
   export-for-download, forget/prune split, and the full-archive escape hatch.
10. `feat/backup-restic-s3`: incremental restic repositories on S3-compatible
    destinations, Relay CONNECT proxy, and destination lifecycle purge.

Each layer receives targeted deterministic tests, full typecheck/lint, and a
T3 Preview end-to-end pass before its ready-for-review PR is opened. Runtime
layers additionally test Relay disconnect/reconnect, Relay restart recovery,
live-server creation, quantity and size rejection, restore, and final deletion.

## Reference decisions

Pterodactyl/Wings validates the value of separate Panel intent and Wings
execution, gitignore-style exclusions, portable archives, presigned S3 work,
and explicit restore status. Kiln avoids its fire-and-forget-only status model,
SHA-1 checksum, unrestricted parallel staging, and mandatory full local S3
staging as a permanent design constraint.

Coolify validates durable queued execution, execution logs, overlap guards,
per-destination retention, database-native dump tools, and treating local
success separately from S3 upload failure. Kiln uses one artifact destination
per task for an unambiguous success state, makes Relay reconciliation explicit,
and keeps schedule configuration out of the artifact/execution model.
