# Backups

This document describes how Kiln backs up game servers, databases, Apps,
volumes, and Kiln itself. Manual and scheduled backups use the same durable
task model.

## Goals

- Back up game servers, managed databases, and the Kiln installation.
- Store backups on the Relay or in an S3-compatible bucket.
- Allow a platform S3 destination or a user-owned S3 destination to be chosen
  for each backup. Every backup names its destinations: there is no default to
  fall back on, and a schedule's backup step names its own.
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
5. Hearth consumes events while connected and reconciles its catalog with the
   Relay's task list whenever the Relay reconnects.

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

An Effect `Queue` wakes the worker, which drains queued tasks one at a time;
the stopped backups of one batch run together inside their shared stopped
window (see [Formats and live consistency](#formats-and-live-consistency)).
The SQLite task journal supplies durability across disconnects and
restarts.

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
- An App's folder follows the App's files: seeing its backups takes `app.read`; making or downloading one
  `instance.files.read`, as reading its files does; restoring or deleting
  one `instance.files.write`, as replacing them does. The Relay's `backup.*`
  grants don't reach them. App owners hold neither file permission, since
  an App's files reach the node through its Compose file, so, as with its
  configuration, only people with file permissions on the Relay back an App
  up. Restoring needs no `app.manage`: the Relay requires the App stopped
  and replaces only files `instance.files.write` could already change, and
  the Compose file isn't among them (Hearth sends it with each deployment).
- A Kiln volume, shared by design, takes `backup.*` on the Relay.
- A run of several things takes what backing each up alone takes, on every
  one of them, or none is made. Each volume's backup is the volume's:
  making, seeing, downloading, restoring or deleting it takes `backup.*` on
  the Relay, so someone with an App's permissions only is shown which
  volumes it uses, not their backups. A personal destination takes
  `backup.download` on every member.
- A stopped backup also takes `instance.power.stop` on every App it stops
  and starts again, as stopping them does.
- Restoring a volume also takes `instance.files.write` on every App that uses
  it, as the Relay reports them; while the Relay can't tell which Apps use
  it yet, the restore is refused.
- Kiln's own backups are an administrator's alone.

Reasons are `manual`, `pre_restore`, `final_delete`, and `scheduled`.
Artifact kinds are `archive`, `database_dump`, `platform_bundle`,
`restic_snapshot`, and `tar_archive`.
A backup's `full`/`incremental` mode is recorded separately from its artifact
kind; incremental game-server backups are `restic_snapshot`s.

Each resource can set exclude patterns and its retention (see
[Retention](#retention)): the most backups it keeps, the most logical space
they take together, and the longest it keeps them. Platform admins can set a ceiling on each; the lower non-null value applies, and
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

A full backup can go to several destinations at once: its task writes the
primary and copies it to each replica, and the catalog keeps every copy. An
incremental backup goes to exactly one.

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
configuration. `storageId === null` is also the persisted discriminator for Relay-local
storage. A third configured kind therefore needs a persistence discriminator
and updates to the shared selectors that translate stored artifacts into the
registry kind. The registries centralize destination behavior, but they are not
dynamic plugin loading.

S3 credentials never go to a game container and are not returned to the
browser. Full archives still use Hearth-signed, narrowly scoped object
requests. Incremental restic repositories cannot be driven with presigned
URLs, so Relay receives the destination's static keys inside the durable task
input (see [Incremental snapshots](#incremental-snapshots)). A full archive is
staged locally, its size and digest validated, then uploaded in a single
request, so it has a 5 GiB ceiling; the single queue plus a free-space
preflight keeps staging bounded. Restic S3 pack writes aren't subject to that
ceiling.

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
Neither form is a permanent public URL. Both last five minutes.

## Formats and live consistency

Game-server backups are portable compressed archives of the data directory.
The walker rejects path traversal and special files, understands gitignore
patterns, ignores known ephemeral lock files by default, and records files that
vanish or change size/mtime while read. A changed file is retried once; a
second change becomes a visible warning instead of being silently presented as
an application-consistent snapshot.

Running game servers don't need to stop for a backup. A live backup is a
crash-consistent best effort, not a transactional snapshot: Kiln doesn't run
Brick consistency hooks such as Minecraft's `save-off`.

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
the volumes of one run on a Relay are) share one
stopped window: the Relay claims the batch's queued backups together, waiting
a few moments for any still arriving, holds all their locks at once, stops
every App that uses any of them once (journaled under the first backup, as a
single stopped backup's are, so a Relay that stops midway starts them again
and the backups rerun), takes every archive, and only then starts again those
that ran, so the copies agree. A backup of the batch that arrives later runs
in a window of its own, and one whose volume is gone by the batch's turn
fails alone, the rest still taken. A scheduled batch is queued whole, on
the Relay, so one that is short of a member is failed rather than taken in
pieces. Live batches are independent backups. A final backup is always
stopped, and nothing starts again. Game servers and Kiln are
always backed up live. A database isn't stopped either, but one that is
part of a stopped batch (`consistency: "stopped"` with `batch`, which only a
database or a tar archive may carry) is dumped within the batch's window:
it waits until the Apps that use the batch's volumes are stopped, and they
start again only once it has left. Like each archive, its dump taken, it
waits for every other of the batch before it is finished, so a Relay that
stops midway runs the whole batch again. Such a batch must reach the Relay
whole, and run whole: what arrives of one with a database in it, short of
the rest, is failed rather than dumped with nothing stopped, and so is
what is left of one whose dump was already finished, rather than archived
in a stopped window of its own.

A volume an App's Compose project made without an ID, as a file that
changed the volume's Docker name leaves behind, isn't backed up: the App
doesn't use it any more, and it goes when the App is deleted.

A platform bundle contains a logical Hearth database dump plus a versioned
manifest describing the installation. Relay gzip-compresses the dump and
encrypts it with AES-256-GCM using a key derived from the separately recoverable
`KILN_PLATFORM_BACKUP_KEY`; using only a live Hearth secret would make disaster
recovery circular. It backs up the colocated Compose MySQL database identified
by installation-scoped Docker labels; a Hearth database outside the Relay's
Docker isn't backed up, so no connection credentials pass through the Relay's
task journal.

The bundle is a backup of Kiln's Hearth catalog, not its deployment
configuration. Operators must retain the Compose environment, TLS material,
and platform recovery key separately; rotating or losing application encryption
secrets can make restored secret-bearing catalog values unusable.
A Relay in platform mode keeps that configuration itself and exports it as a
recovery kit (`kiln-relay platform export-kit`); see
[Self-hosting](self-hosting.md#recovery).

Game-server archives, tar archives, and platform bundles each carry a
versioned manifest of their own shape; database dumps are bare compressed
streams. Sizes, SHA-256 digests, and consistency warnings are kept in the
catalog with each backup's task result.

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

A step that backs up an App backs up its folder and each volume its Compose
project owns that has a Kiln ID, as a manual App backup does, each admitted on its own. It's taken live,
or stopped once for all of them as a batch; saving a stopped one takes
`instance.power.stop` on the App and every App using those volumes, and while their
Relay can't say which those are, only a stopped step the schedule already had
is kept.

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

## Deleting backups

Any backup can be deleted, whatever state it's in
(`reserveBackupDeleteEffect`); only a restore from it, or a copy of it,
holds it until that ends.

- One still being made is marked deleting at once, and its delete task waits
  on its create (`depends_on_task_id`): Hearth asks the Relay to cancel the
  create, and sends the delete only once the create has ended, cancelled or
  not, so the delete never runs before what it deletes is written. Each
  reconciliation cancels any create its Relay still holds for a backup being
  deleted, and cancels in Hearth one its Relay never received. A Relay
  records a create that arrives after its backup's delete as cancelled and
  never runs it, so one Hearth sent just before the delete can't write what
  the delete removed.
- One whose create finishes before the cancel reaches it still records what
  it made, its artifacts, sizes, checksums and snapshot, while the backup
  stays deleting, so a delete that then fails leaves a whole backup.
- One already being deleted keeps its delete task, which is sent again;
  a Relay takes a task ID once.
- An incremental one whose repository Hearth no longer has, as releases that
  purged a deleted server's repositories left behind, can't be read or
  forgotten by anyone, so only its record goes.

A delete that doesn't finish leaves each artifact as valid as it was: one
being deleted is available again, a failed one stays failed, and the backup
follows its artifacts.

Every queued task is sent to its Relay on its own, so one Hearth can't send
never holds up the rest. A task whose catalog record can't be made into a
Relay task, as when its destination is gone or its repository's row is, is
settled rather than tried on every pass: a delete whose repository is gone ends with
the record removed, and anything else fails with why, its backup going back
to the state it had.

## Telemetry

Each Relay task is a `Backups.<kind>` span, with steps beneath it:
`Backups.archive`, `Backups.store` and `Backups.upload` for a full archive,
`Backups.database.dump` and `Backups.database.import`, `Backups.restore.fetch`
and `Backups.restore.files`, and a `Restic.command` span for every restic
process. An incremental create records what restic said of its snapshot
(`restic.bytes.added`, `restic.files.new`/`changed`/`unmodified`), and
`relay.restic.snapshot.bytes` counts what each snapshot covered and what it
newly stored, by storage kind. Progress writes are untraced. In Hearth, each
reconciliation of a Relay's backups is a `Backups.reconcileRelay` span, and
each task it sends a `Backups.dispatch`.

## Restore and deletion safety

A backup restores into the resource it was taken of, or into another of the
same kind on its Relay: a game server, a database, an App's folder, or a
volume. That's how a backup of a resource since deleted is restored, and the
restore dialog and `kiln backup restore --to` offer it. Restoring into
another resource copies the backup's data there, so it takes `backup.download`
on the backup, as linking it to a copy does, and permission to restore the
resource it goes into; a safety backup is of that resource and takes
`backup.create` there. Both are read from the catalog, so they don't need the
backup's own resource to exist. The restore task records where it goes
(`backup_task.target_kind`/`target_id`, null for the backup's own), its
operation holds that resource, and restores into one resource queue behind
each other whichever backup each restores. The Relay task's `target` is
where it goes and `archive` the backup and resource it was made as, which the
archive's manifest is checked against; a restore of an App's folder or a
volume journals and fences the resource it goes into. A database dump's first
bytes name the engine whose tool wrote it (`-- MySQL dump`, `-- MariaDB dump`,
`-- PostgreSQL database dump`), and one of the other family is refused before
anything is imported.

Game-server restore requires the instance to be stopped. Hearth can enqueue a
full safety backup first, kept on the Relay; restore is submitted only after
that task succeeds.
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
reservation's transaction, and follows that backup to its end. An App's
deletion takes the App and its folder, and never a volume: the volumes it
used are no App's, stay with their data, and are deleted from Volumes by
whoever decides to. Its final backup is of its folder alone, and says so.
The deletion's journal still has a place for volumes a deletion names; no
deletion fills it. A final backup never starts what it stopped, so the
Relay refuses one, stopping nothing, that finds an App other than the one
being deleted using what it backs up, as one deployed since. Deleting an App on its Relay is safe to send again, and
says it's done only once the App's folder is gone, so a deletion the Relay
stopped partway, after the App's containers went, is sent again rather than
taken as done. Before any resource's Relay is asked to delete it, the
deletion records that it's asking: from then on it can't be kept, since its
data may be gone, and trying again finishes it with no new final backup. A failed, cancelled, or missing backup, of
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
after the resource is gone, and retention never removes them, nor does
deleting the resource remove its other backups. Its grants go with it, so
its backups are then seen and acted on by those with `backup.*` on the Relay
and by platform administrators. Relay-local
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

The picker also scopes to an App, showing the backups of what it keeps: its
folder, and the volumes its configuration mounts, its Compose file declares
or its containers use. A row of an App's folder
or a volume says whether it was taken live or stopped, and its restore
dialog says what must be stopped (the App, or every container that mounts
the volume, listing those running and the Apps that use it).

An App's Info rail opens Backups scoped to the App. Each named volume in
its Volumes table also opens Backups scoped to that volume, with a clearable
volume filter; the picker still shows the App. Backup settings retain the
App's Folder and Volume sections.

What is backed up of an App is its volumes. An App is not a backup target
itself: it is a group of what it keeps, so backing up an App backs up every
volume it uses, each a backup of its own, started together. There is no
backup of "the App", and none of its folder on its Relay, which holds
nothing the App keeps: what it is built from, or the paths beside a Compose
file written in Hearth. Those paths, like any path on the node, are not
backed up, and the App's Volumes say so; data to back up belongs in a
volume. An App that uses no volume has nothing to back up.

New Backup in Hearth takes one thing or several (`createBackupRun`,
`apps/web/src/server/backup-runs.server.ts`; the CLI makes its backups one
at a time, by its own path): each chosen is a backup of its
own, as if made alone, and those of one run share its name and its ID
(`batch_id`). They are reserved together or not at all, so a run never
comes up short of something chosen without saying; up to 64 at once, on any
Relays. Live or Stopped is the volumes' choice: stopped, the volumes of a
run on one Relay share one stopped window, so every App that uses any of
them stops once, and the run's databases on that Relay are dumped within
it, while those Apps are stopped. That is all it promises: nothing else
that writes to the database is stopped, nothing is coordinated between
Relays, and each backup is still restored on its own. Game
servers and Kiln are taken as they run, as is a database with no volume
beside it. Incremental is a game server's choice, offered when only game servers
are chosen; chosen with anything else, each is a full archive.

It offers each Kiln volume alongside game servers, databases and
Kiln: every row that is chosen is one thing a backup keeps. An App, and a
group of instances, are listed too, as rows that stand for others and are
never targets themselves: an App for each volume it uses, a group for what
each of its members keeps (an App's volumes, a database, a game server). A
group is only offered whole: one with a member that can't be backed up
here, or that this person can't see, can't be chosen as a group, since
ticking part of it would pass for backing all of it up. Nor can an App, or
a group with one, while its Relay doesn't yet know which volumes every App
names: the volumes listed for it may not be all it uses
(`apps/web/src/lib/backup-target-groups.ts`). Each volume can still be
chosen on its own. The page asks such a Relay again every few moments, so
the rows come back when it is settled. With the page scoped to an App, its
volumes are chosen as the dialog opens only when its row could be chosen:
all of them, or none.

A row is only a quick way to tick: nothing remembers that it was used, and
what is backed up is the targets ticked when the backup is made. An App
that takes up another volume after its row was ticked is backed up without
it, as it would be had its volumes been ticked one by one.
Choosing one ticks what it stands for, which can then be unticked one by
one; the row says what that is, and shows as part-ticked when only some of
it is chosen. A row whose choice would leave out something it keeps can't
be chosen and says why: an App with a volume missing on its Relay, or one
with no volumes at all. With the page scoped to an App, its volumes
come first and each is chosen as the dialog opens. Volumes and groups are
types to filter by, each volume says which Apps use it, and searching an
App's name or ID finds the volumes it uses. Someone who can't list the
Relay's volumes is offered those of the App the page is scoped to. A
schedule still names an App, as the group of whatever volumes it uses when
it runs. An App's volumes are each Kiln
volume its configuration mounts, its Compose file declares or its
containers use, one another App uses too. A Kiln volume its configuration
mounts or its Compose file declares that its Relay doesn't have refuses the
backup, manual or scheduled, since it would leave that data out: the Relay
lists each volume an App names that it doesn't have (`missing`), and counts
it among what the App's backup must take. A schedule is sent again when an App
takes up or lets go of a volume.

A scheduled step works out what it backs up before it runs, each thing
once: for its Apps, each volume once however many of them use it. Apps that share a volume are backed up together, as one batch
(`scheduledAppBackupGroup`): each of them asks its Relay for the same
batch, by the same IDs, so the first makes it and the others wait for it,
and a stopped step stops them all once. What refuses one of them refuses
each, and a batch is at most 64 backups. The volumes are those Hearth last
sent. It sends the schedule again as soon as a deployment of the App ends,
and if that send fails, at its next sweep, every ten minutes, or when
someone opens the Schedules page. A run that falls before that takes the
volumes it was sent all the same: a volume the App has taken up since is
backed up once the schedule has been sent again, and one
that is gone fails alone ("The volume no longer exists on this Relay"),
failing the step of each App that used it, while every other volume is
still backed up and the schedule carries on. An App with no volumes is
sent nothing, and its step is skipped and says so ("Nothing to back up:
this App uses no volume"): a run that backed nothing up never reads as a
backup made. Whether the schedule's
author may stop each App a stopped step stops is checked when the schedule
is saved; an App that takes up one of those volumes afterwards is stopped
with them. A volume's backup is taken Live or Stopped, Stopped subject to
permission to stop every App that uses it.

The Settings page configures an App's folder and each volume it uses
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

The CLI uses the same authorization and task APIs: `kiln backups list`,
`targets`, `create`, `download`, `restore` and `delete`. See
[the CLI's README](../apps/cli/README.md) and
[its agent skill](../.agents/skills/kiln-cli/SKILL.md#backups) for usage.

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
`task:<createTaskId>`. A missing snapshot, or a repository that's gone, is
treated as a successful forget, and the latter queues no prune.
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

A create opens its repository with the lookup it needs anyway, the snapshots
an interrupted attempt of the same task saved: a repository that doesn't
exist yet (restic exit 10) is made then, and a wrong password (exit 12)
fails the task. A command refused because the repository is locked (exit 11) runs `restic unlock`, which removes only stale locks, such as one a
restarted Relay left, and is tried once more; a live lock still fails it.

restic writes a lock file before every command, reads included. When storage
refuses that write, such as a bucket at its provider's storage cap or a
read-only key, commands that only read the repository (snapshot lookups,
sizes, restores, and export downloads) run again with `--no-lock`, so backups
stay restorable. That's safe because the Relay's single backup worker is the
only writer to its repositories. Creates, forgets, and prunes still need the
lock, so they fail until the storage accepts writes again.

Pre-restore safety backups and final-deletion backups stay full zip archives
so recovery does not depend on a mutable repository. Deleting a game server
keeps its incremental backups and their repositories, Hearth's row with its
password and the Relay's directory or S3 prefix alike, so each snapshot can
still be restored into another server or downloaded until it's deleted as
any backup is. A repository stays once its last snapshot is deleted and
pruned; an empty one costs a few KiB. Releases before this kept nothing:
they purged a deleted server's repositories and marked its incremental
backups deleted.

A restore or export reads the snapshot under the path it was taken from,
the server's directory below the Relay's server root. Restoring into the
server it was taken of uses that server's directory; restoring into another,
or exporting one whose server is gone, reads the path from the snapshot
itself (`restic snapshots`), and the repository from the server it was
taken of, which the task's `archive` names.

Destination deletion is two-phase: the row is marked `deleting` so new backups
cannot select it, S3 repository prefixes are purged, then foreign keys on
deleted catalog rows are cleared and the destination is removed. A purge failure leaves the destination
listed as `deleting` with `last_error` so the operator can retry instead of
silently orphaning data.

Development stacks have no S3 of their own. They share one RustFS endpoint on
the maintainers' tailnet; see
[Tailnet S3](development.md#tailnet-s3) for it, and for running your own.

Ceph RGW works through the S3-compatible destination.
