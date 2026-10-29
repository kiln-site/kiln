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
- Keep each resource's newest backups, by number, total logical size, and
  age, as its owner sets, within optional platform-admin ceilings.
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
- `platform`: Hearth's database and the recoverable Kiln configuration;
- `app`: an App's folder;
- `volume`: a volume Kiln manages, by its ID: a Kiln volume's, or
  `<App ID>/<key>` for one an App's Compose project declares (see
  [App deployments](app-deployments.md#volumes)).

Apps and volumes are archived as `tar_archive`, always full, and a backup
records whether it was taken live or with what uses it stopped, so a
dispatch after a restart asks the Relay for the same. Target IDs are up to
200 ASCII characters; an S3 object key encodes each as one path segment,
so an App's volume's slash never nests its backups under another target's
(keys for other targets are unchanged).

A backup's contents are its resource's data, so acting on a backup takes
the authority reading or writing that data does
(`lib/backup-target-permissions.ts`):

- Game servers and databases take `backup.*` on the Relay or on themselves.
- An App's folder, and a volume its Compose project owns, follow the App:
  seeing its backups takes `app.read`; making or downloading one
  `app.files.read`, as reading its files does; restoring or deleting one
  `app.files.write`, as replacing them does. The Relay's `backup.*`
  grants don't reach them. App owners hold neither file permission, since
  an App's files reach the node through its Compose file, so, as with its
  configuration, only people with App permissions on the Relay back an App
  up. Restoring needs no `app.manage`: the Relay requires the App stopped
  and replaces only files `app.files.write` could already change, and the
  Compose file isn't among them (Hearth sends it with each deployment).
- A Kiln volume, shared by design, takes `backup.*` on the Relay.
- A stopped backup also takes `app.manage` on every App it stops and
  starts again, as starting and stopping them does.
- Restoring a volume also takes `app.files.write` on every App that uses
  it, as the Relay reports them; while the Relay can't tell which Apps use
  it yet, the restore is refused.
- Kiln's own backups are an administrator's alone.

Reasons are `manual`, `pre_restore`, `final_delete`, and `scheduled`.
Artifact kinds are `archive`, `database_dump`, `platform_bundle`,
`restic_snapshot`, and `tar_archive`.
A `full`/`incremental` mode is recorded independently so a future Restic
artifact does not require a catalog migration.

Each resource can set a preferred destination, exclude patterns, and its
retention (see [Retention](#retention)): the most backups it keeps, the most
logical space they take together, and the longest it keeps them. Platform
admins can set a ceiling on each; the lower non-null value applies, and
`null` keeps without that limit. A ceiling of no backups at all turns
backups off for the resource, and is the only limit that refuses a new one.
A backup can be at most as large as all the space kept. Final-deletion
backups pass the owner's limits but not a ceiling, nor Relay free-space
safety checks.

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

An App's folder and a volume are archived through Docker as `tar_archive`
artifacts (`.tar.gz`), never by the `docker` CLI. A short-lived helper
container mounts the volume, or the App's folder as a bind, at `/volume`,
and the Relay reads it with `GET /containers/{id}/archive` while the helper
is only created, so nothing runs in it. Docker's archive keeps each file's
owner, mode, and extended attributes, and symlinks stay links, which a
database's files need. The Relay validates every path Docker sends,
leaves out the exclusions, and writes `.kiln-backup/manifest.json` (target,
consistency, and the volume's Docker name) followed by the files under
`data/`. Devices and pipes are left out with a warning. An App's folder
holds only its data: its configuration's files, its Dockerfile, and a
repository checkout live outside it, and its Compose file's relative binds
are inside it, so they're backed up with it.

The helper runs the Relay's own image, found through the Relay's container
(`KILN_RELAY_CONTAINER` or its hostname), which every Relay running in
Docker has without a pull. Apps and volumes can't be backed up by a Relay
that doesn't run in Docker. The image is distroless, so a restore's steps
run the Relay's own Node code (`tar-restore-helper`). Helpers have no
network, run as root so files keep their owners, and are removed after
each step, or at the Relay's next start.

A backup is **live** by default and records that it is: a crash-consistent
copy of a resource that kept running. It can instead be **stopped**: the
Relay stops each App that uses what it backs up (the App, or every App
whose containers mount the volume), backs up, and starts again those that
were running, before uploading. A stopped volume backup is refused while a
container that isn't an App's mounts it, since Kiln can't stop and start it
as its owner would. Apps it stopped are journaled first, so a Relay that
stops midway starts them again when it starts; one that won't start again
is a warning on the backup, which still succeeds, and stays journaled for
the Relay's next start. The journal records each App's power-intent
revision, which every start, stop, restart, deployment, or deletion a
person asks for advances; a start is owed only while it's unchanged, so a
later choice stands. If an App can't be stopped, the backup fails and
every App it stopped starts again, the one whose stop failed included,
since it may be partly stopped. The Apps a stopped backup or a restore of a
volume locks are looked up before it waits its turn and checked again once
it has it; if they changed meanwhile, or can't be looked up, the task fails
rather than run beside an App it doesn't hold. Stopped backups started together as a batch (`batch: {id, size}`, as
backing up an App starts its folder's and each owned volume's) share one
stopped window: the Relay claims the batch's queued backups together, waiting
a few moments for any still arriving, holds all their locks at once, stops
every App that uses any of them once (journaled under the first backup, as a
single stopped backup's are, so a Relay that stops midway starts them again
and the backups rerun), takes every archive, and only then starts again those
that ran, so the copies agree. A backup of the batch that arrives later runs
in a window of its own. Live batches are independent backups. A final backup is always
stopped, and nothing starts again. Game servers, databases, and Kiln are
backed up live only for now.

A volume an App's Compose project made without an ID, as a file that
changed the volume's Docker name leaves behind, isn't backed up: the App
doesn't use it any more, and it goes when the App is deleted.

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
and keeps 30 days of them, in at most 20 GiB. Migration 24 marks a database migrated before
anyone signed up; once an administrator and a Relay reporting this
installation exist, Hearth creates the **Kiln backups** schedule, owned by
the first administrator, with Kiln's retention, and clears the mark, so
deleting or editing either sticks. The same sweep resends any schedule a Relay hasn't acknowledged, so
a first deploy that failed is retried.
Existing installations keep the schedules they chose.

Restoring Kiln stays offline (see below). Its Restore shows the commands for
the Relay's host and, where the Relay installed Kiln, opens that Relay's
terminal with `stop-hearth`, the restore, and `start-hearth` typed for the
operator to send.

## Scheduled backups

A Relay runs its schedules on its own, so scheduled backups go on while
Hearth is away. Hearth decides whether each one may run as it decides a
manual backup's reservation, and puts the answer in the schedule it sends
the Relay, per backup step and target: not while the target is being
deleted, not where its backups are turned off (a quantity or size ceiling of
none), and only to a destination that's enabled, not being deleted, and
shared or the schedule owner's. Scheduled backups run as the schedule's
owner whoever last edited it, so saving a schedule refuses a personal
destination that isn't its owner's. An admitted step carries its size ceiling
and, for an incremental one, the repository it goes to; a refused one carries
why, and the Relay records it as not run instead of running it. A
destination Hearth can't use no longer fails the schedule's deploy, which
left the Relay running what it had before.

Hearth sends the schedule again when any of that changes: a target's backup
limits, a destination saved or marked for deletion, a deletion starting or
stopping. The change marks the schedule unsent in its own transaction, so
work after it that fails, like purging a deleted destination, can't lose the
resend; it's sent right after, or by the ten-minute sweep if its Relay is
away. Until it arrives, the Relay runs what it last had, so a change made
while a Relay is unreachable takes effect when it's back.

What Hearth sends a Relay for a schedule can change without the schedule's
revision changing, so each send also carries a generation, counted per
schedule and Relay and raised on every send and every change it depends on.
The Relay keeps the newest generation of the newest revision and ignores an
older one that arrives late, and Hearth counts the schedule delivered only
once the Relay acknowledges the newest generation Hearth issued.
Hearth catalogs what the Relay ran as before, an incremental one in the
repository its schedule named; one whose repository is gone by then is
cataloged as failed, since it can't be restored.

## Retention

A resource's backup policy is its retention. Hearth keeps its newest
backups, by hand or on a schedule, while they're within its number, younger
than its age, and fit in its space, newest first, and deletes the rest,
oldest first, with every copy of each. The newest is always kept, so
retention never leaves a resource without a backup, and final-deletion
backups are never deleted. Hearth applies it soon after a backup finishes or
a retention changes, and every ten minutes, when it also catalogs the
backups Relays made on their own. Setting a retention takes `backup.delete`
as well as `backup.create`.

## Restore and deletion safety

Game-server restore requires the instance to be stopped. Hearth can enqueue a
full safety backup first; restore is submitted only after that task succeeds.
Restore extracts into a sibling staging directory, validates every path and the
manifest, then swaps directories where the filesystem permits. If an atomic
swap is unavailable, Relay records the restore phase so recovery can complete
or roll back deterministically.

Restoring a volume requires every container that mounts it to be stopped,
and restoring an App's folder requires the App to be stopped; the Relay
checks both. The Relay checks the archive's manifest and every entry, so
nothing lands outside the target or through a symlink the archive made,
and nothing takes a name restores keep for their staging folders
(`.kiln-restore-*` at the target's root). A backup checks every entry it
writes by the same rules, so one that succeeds can be restored: a hard
link whose file an exclusion left out holds the file's contents instead.

A helper step makes the restore's staging folder inside the target, and
the restore stops, changing nothing, if anything already has its name.
Docker extracts the archive (`PUT /containers/{id}/archive`) into it,
keeping the old files until the copy is whole. Two more steps then clear
the old files and move the restored ones in, and Docker sets the root's
extended attributes, which the steps can't, by extracting its entry over
the mount. A journal records each phase: a restore that fails or stops
while staging leaves the target as it was.

One that fails or stops while clearing or moving leaves the target holding
neither copy, so its journal **fences** the target until the restore
finishes: the Relay's lanes refuse every other change to it, starting,
deploying, or replacing an App that uses the volume, and new backups and
restores of it, saying the restore must finish first. The Relay tries to
finish it when it next starts, under the restore's own locks, unless
something runs on the target, as when Docker's restart policy started an
App, since moving the restored files in would overwrite what it wrote.
Starting, deploying, or deleting an App holds every managed volume it
mounts shared: a start or deletion those its containers mount or its
configuration names, and a deployment also every volume its Compose file
declares, by the Docker name Compose gives it (external, named, or after
the project, since Compose reuses one already there), held from before
its containers are made. So a restore, which holds the volume alone, comes wholly before or
after, and an unfinished one refuses them.
`backup.restore.resolve` finishes it on request, stopping the Apps running
on it first (another container mounting a volume still refuses), or
abandons it, leaving the target as it is and dropping the staging folder.
A restore needs room for both copies in the target's filesystem.

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

Deleting a game server, database, App, or Kiln volume is the durable
operation `resource.delete` (`apps/web/src/lib/resource-deletion.server.ts`),
one row per resource in `resource_deletion`. It checks the person who asked
may still delete it, freezes it on its Relay, takes a `final_delete` full
backup if one was asked for, recording the backup's ID on the deletion in the
reservation's transaction, and follows that backup to its end. What an App's
deletion takes is decided once, after the freeze, and kept in its journal:
its folder, and each volume its Compose project made that nothing else uses.
Its final backup is those parts, one backup at a time as steps of the
deletion, each recorded on the deletion in place of the one before, and its
Relay deletes only the volumes on that list, so a volume something else
used then stays even if nothing does by the time it's deleted. A volume
another App or container also mounts isn't backed up: a final backup never
starts what it stopped, so the Relay refuses one, stopping nothing, that
finds an App other than the one being deleted using what it backs up, as
one deployed since. Deleting an App on its Relay is safe to send again, and
says it's done only once the App's folder is gone, so a deletion the Relay
stopped partway, after the App's containers went, is sent again rather than
taken as done. Before any resource's Relay is asked to delete it, the
deletion records that it's asking, with an App's volume list: from then on it
can't be kept, since its data may be gone, and trying again finishes it with
that list and no new final backup. A failed, cancelled, or missing backup, of
any part, stops
the deletion with nothing deleted and the resource still frozen; its page offers to try again, to delete it without a final backup, or
to keep it. A game server keeps a final backup that finished for its next
attempt, since it stayed stopped; a frozen database keeps serving what's
connected to it, so a retry takes a new one. Keeping it is an operation of
its own, `resource.delete.cancel`, in the deletion's lane: it's recorded,
and its final backup dropped from reuse, before the resource is let go, so
no retry starts meanwhile and none reuses a backup from before. Every
attempt is recorded before its operation is admitted, and a reconciler admits
any whose operation is missing, at startup and every half minute. Final backups stay in the catalog
after the resource is gone, and retention never removes them. Relay-local
final backups remain tied to Relay availability. No other backup, restore,
copy, or export of a resource can start while its deletion runs.

## Linked backups

A game server copied with **Move or duplicate**
([Moving and duplicating game servers](server-migrations.md)) can take the
original's backups along without copying their archives. Each becomes a
catalog row for the copy that names the backup it was made as in
`linked_from_backup_id` and `linked_from_target_id`; the archive stays where
it is. Linking needs `backup.download` on the original, since the copy's
owner can then download and restore them.

- Full archives in S3 can be linked to a copy on any Relay.
- Archives kept on the Relay can be linked only to a copy on the same Relay,
  so a backup never counts as local on a Relay that doesn't hold it.
- Incremental snapshots aren't linked; they belong to their own repository.

Restore and delete tasks for a linked backup carry `archive`, the identity
it was made as, so the Relay finds the archive by that name and checks its
manifest against the original server. A Relay advertises this with the
`linked-backups-v1` feature, and Hearth won't restore a linked backup on a
Relay without it. Downloads Hearth signs for a linked backup, and copies
to another destination, name the shared archive too.

Each stored copy of an archive, a Relay's own file or an S3 object, is
deleted with the last backup that still lists it; deleting any other only
marks its row and that copy deleted. Deletes of backups sharing an archive
lock the backup it was made as first, or, once that's been forgotten, the
first record still linked to it, so concurrent deletes see each other.

## UI

Backups is the final item in the server navigation and a global page covering
servers, databases, and Kiln. Its main-sidebar button sits directly above
Activity. The page uses the shared server picker from Activity at the top and
the shared workspace table below it. Rows show name, target, destination,
reason, size, status/progress, and creation time. Actions are download,
restore, and delete. Transient outcomes use Sonner; queue state updates in
place without shifting the layout.

The create dialog selects a target and destination, and accepts exclusions. The restore dialog explains whether
the target must be stopped and defaults to "Take a safety backup first."
Storage configuration clearly separates platform destinations from "My S3"
destinations and never redisplays a saved secret.

The picker also scopes to an App, showing the backups of what it owns or
uses: its folder, the volumes its Compose project owns, and the Kiln volumes
its configuration names or its containers mount. A row of an App's folder
or a volume says whether it was taken live or stopped, and its restore
dialog says what must be stopped (the App, or every container that mounts
the volume, listing those running and the Apps that use it).

An App's Info rail opens Backups scoped to the App. Each named volume in
its Volumes table also opens Backups scoped to that volume, with a clearable
volume filter; the picker still shows the App. Backup settings retain the
App's Folder and Volume sections.

New Backup offers Apps alongside game servers, databases and Kiln. An App
backup includes its folder and every volume it owns together. A volume scope
also offers that volume on its own. Both offer Live or Stopped, subject to
permission to manage the App (or, for a Kiln volume, Apps on the Relay).
Stopped App backups run as one batch, stopping the App once for all targets.

The Settings page configures an App's folder and each volume it owns
(choosing the App) and each Kiln volume on a Relay ("Kiln volumes on …"),
with the same permissions as backing them up: retention, the platform
ceiling, the destination, and exclusions, which apply to an App's folder
and a volume as to a game server's, relative to their roots.

A restore whose swap didn't finish shows on the Backups page as
"A restore didn't finish", with Finish and Abandon for those
who may restore its target (`backup.restore.unfinished` lists them; Hearth
calls `backup.restore.resolve`, checking authority over every App that uses
the target).

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

Retention counts each snapshot as a backup. Its space uses each snapshot's
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
