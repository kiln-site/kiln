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
   Relay's task journal, a page at a time, whenever the Relay reconnects.

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

Hearth reads a Relay's task journal a page at a time, never all of it at
once: the Relay keeps a week of tasks, so the whole journal can outgrow
one control message (1 MiB). Each pass asks for the tasks changed
after where Hearth last read (`backup_tasks_read_at` on the Relay's row, by
the Relay's clock), less a minute, since a change can be stamped a moment
before another that is written first. Each page holds the tasks changed
next, in the order they changed, up to half a megabyte, and on every page
the Relay also sends each task still queued or running and each Hearth asks
after by ID: Hearth asks after its own unfinished tasks, so it knows what
the Relay holds under each before sending or stopping one. Hearth records
how far it has read once each page is applied, so a pass that fails part
way starts the next from there. A task Hearth queued after the pass asked
waits for the next pass. A task's warnings are cut to fifty on a page, the
last saying how many more there were, so no one task fills a page. The
backup sweep reads each Relay with scheduled backups from the start, a page
at a time, so a report Hearth refused before gets another look, and a change
the faster passes missed, as when a Relay's clock stepped back, is found
within ten minutes.

Each time Hearth lists the journal, the Relay first removes finished
creates, deletes and prunes that ended more than a week ago, keeping the
twenty latest whatever their age. Hearth reads every few minutes, so a week
is long past anything it hasn't read. Restores stay, since they're rare and
one that failed partway can still be finished by hand. Exports keep their
own rule: only the latest for each backup stays.

What a Relay reports of a task reaches Hearth's records only as far as that
Relay's own work goes. Hearth sends a backup's tasks to its own Relay alone,
so it applies a report only to a task of a backup on the Relay that sent it,
as its connection says, and only as the kind of task Hearth has it as. A
create's result must be the kind its backup is: an archive for a full backup,
a snapshot for an incremental one, and it reaches only the copies the create
was sent to make, never one Hearth is making to another destination. Once
Hearth has applied its Relay's report that a full backup's create succeeded,
no later report of that task changes it, however new: every copy comes from
the one archive that report described, so a second report can't change its
size, checksum or copies, nor turn it into a failure. A failure or cancel
Hearth recorded itself, as when it couldn't send the create, never says
succeeded, and still gives way to the Relay's success. Every
report must name the resource Hearth sent its task for: a restore's
destination, otherwise the backup's own target. A failure with no result is
the exception, since the Relay could report it under the right one anyway; a
task whose journal row the Relay couldn't read is reported that way, naming
no resource it knows. An answer to an enqueue
or a cancel must be about the task Hearth asked about; one about another is
logged and the pass goes on. A task the Relay lists under the ID of one Hearth
has queued, but for another backup, kind or resource, means Hearth's never
arrived: it is failed, saying so, rather than counted as sent. Cancelling a
create names the backup and resource Hearth sent it for, and the Relay
cancels only a create it holds as that; a delete waiting on a create the
Relay holds as something else ends that create in Hearth, as one that never
arrived, and goes ahead. The delete removes what the Relay keeps under that
backup's ID, which is the backup the person asked to delete: no Relay holds a
different task under one of Hearth's IDs except by making one up or by a
journal that no longer matches what Hearth sent it. A delete of an incremental backup with no snapshot
recorded forgets only snapshots tagged with both its create's task and its
backup. A task Hearth already has running that its Relay then lists as
another task stays as Hearth last heard of it; only a Relay whose journal no
longer matches what Hearth sent it can bring that about. A schedule's backup a Relay made on its own
is cataloged from its report all at once or not at all: if any of its backup,
copy or task IDs is already another backup's, none of it is kept, and it is
reported again each pass. Nor is one cataloged of a game server Hearth's
instance directory binds to another Relay, or of a database Hearth has on
another one. A game server or database Hearth hasn't recorded yet, a volume
and the platform are taken as the Relay says: whatever it catalogs is under
its own Relay.

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
- An App is no backup target. Seeing which volumes it uses, and the latest
  backup of each, takes `app.read`; a schedule that backs one up takes
  `instance.files.read` on it, as reading its files does.
- A Kiln volume, shared by design, takes `backup.*` on the Relay, by hand
  or as a schedule's target.
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
A destination's ID is 12 hexadecimal characters from the
[instance directory](instance-ids.md), so it is never an instance's, and it
says what kind of storage it is (`kind`; `s3` is the only kind so far).
An owner ID of `null` makes a destination platform-wide; otherwise only that
user can select it (`backupDestinationUse` is the one rule for who may send
a backup where). Destination removal is blocked while cataloged artifacts
still depend on it.

A full backup can go to several destinations at once: its task writes the
primary and copies it to each replica, and the catalog keeps every copy. An
incremental backup goes to exactly one.

A full backup's copy in a bucket counts once Hearth has seen it there
(`checkBucketCopiesEffect`, apps/web/src/lib/bucket-copy-checks.server.ts),
not on its Relay's word. The promise: Hearth marks a newly uploaded full
backup's bucket copy available only if a HEAD Hearth made, after it accepted
the Relay's report that the create succeeded and before any delete of the
backup was asked for, saw an object of exactly the reported size, within the
backup's reservation, at the key Hearth chose.

- **What it covers.** A Relay that lies about an upload, its size, its
  timing or its outcome, or reports it again differently (an accepted
  success is final; see the ownership model above); a bucket that is slow,
  can't be reached, refuses (403) or doesn't have the object; Hearth
  restarting; deletes, copy-worker takeovers and cancels happening at the
  same time.
- **What it doesn't.** The bucket is trusted to answer honestly, and a
  passing look is a point-in-time observation: the object can still be
  replaced while the signed upload is valid (#989, create-only uploads), or
  disappear later. An upload of the right size with the wrong content passes;
  checksums aren't compared, and restore checks the archive's. A copy on the
  Relay's own disk counts on the Relay's word, as before. Incremental copies
  aren't checked.

When the Relay reports a bucket copy uploaded it waits, still running and
shown as "Checking bucket". Hearth looks in the background, woken when a
pass over the Relay's backups or a cancel's reply sees a create succeed, and
on each backup sweep. The copy becomes available at the size Hearth saw if
that is the reported size and within the reservation; a different size, an
oversize object or no object fails it, saying why. A copy the create was
sent to make that its success report leaves out fails, rather than stay
queued. A success report that lists no copies at all applies to every copy the
create was sent to make, so each bucket copy waits to be seen. The catalog marks each copy waiting to be seen as checking, which
is what the list shows; a copy Hearth's copy worker is making isn't one. A
backup is available
while any copy is, so one with a copy on the Relay's disk is available while
its bucket copy waits; running while only bucket copies wait; failed
otherwise.

Each wake makes one bounded look: at most a hundred copies, ten of any one
destination, the oldest first, four at once, each waiting at most fifteen
seconds for the bucket. One look runs at a time, and a look that left copies
another could reach asks for the next a second later, so a backlog is seen a
look at a time. An answer that says nothing of a copy leaves it for a while
after the look ends: a bucket that can't be reached, or whose keys can't be
read, rests whole, thirty seconds and longer each time up to ten minutes,
kept in memory since it only paces Hearth; a refusal (403), which can be of
one object, rests that copy for two minutes (`check_after`, migration 95). A
403 says the copy may be missing or Hearth's key not allowed to read it. An
hour after a copy first waited, by Hearth's clock (`seen_by`), it becomes
eligible for one last look, which a backlog or a resting bucket can delay;
it fails with what that look heard unless the look settles it, so a copy
readable by then still counts.

Settling takes the backup's row first and settles only a copy that still
waits, as it was looked for, and that is still its Relay's upload, not one
Hearth's copy worker took over. Asking to delete a backup takes the same row
and ends every copy of it still waiting, as failed: the delete may remove the
object, even if its Relay then reports the delete failed, so nothing a look
saw before or after counts. A create that succeeds after a delete of its
backup was asked for leaves its bucket copies failed the same way. Either
way the copy stays listed, so a delete still removes its object. A settled
copy stays as it settled. Nothing is deleted from the bucket here.

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
browser. Full archives use Hearth-signed, narrowly scoped object requests,
by hand or on a schedule: a Relay is never given a bucket's keys for one
(see [Scheduled backups](#scheduled-backups)). An incremental backup's
repository is reached the same way, one signed request at a time (see
[Incremental snapshots](#incremental-snapshots)). A Relay reports its tasks
to Hearth without repository passwords or the signed links it
was given (`uploadUrl`, `downloadUrl`, `deleteUrl`): Hearth issued the links
and never reads them back. A full archive is
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

A volume is archived through Docker as a `tar_archive` artifact
(`.tar.gz`), never by the `docker` CLI. A short-lived helper container
mounts the volume at `/volume`,
and the Relay reads it with `GET /containers/{id}/archive` while the helper
is only created, so nothing runs in it. Docker's archive keeps each file's
owner, mode, and extended attributes, and symlinks stay links, which a
database's files need. The Relay validates every path Docker sends,
leaves out the exclusions, and writes `.kiln-backup/manifest.json` (target,
consistency, and the volume's Docker name) followed by the files under
`data/`. Devices and pipes are left out with a warning.

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
encrypts it with AES-256-GCM using a key derived from Kiln's platform backup
key, which its [recovery code](self-hosting.md#recovery) holds; using only a
live Hearth secret would make disaster recovery circular. However Kiln was
installed, the Relay beside it generates that key, once Hearth proves it runs
on the same machine, and saves it under Kiln's installation ID. A Relay moved to
another Kiln gets that Kiln's own key, and still has the first one's.
`KILN_PLATFORM_BACKUP_KEY` only sets the first one: once a key is saved, that
variable does nothing, so every backup stays readable with the same code. It backs up the colocated Compose MySQL database identified
by installation-scoped Docker labels; a Hearth database outside the Relay's
Docker isn't backed up, so no connection credentials pass through the Relay's
task journal.

A Relay in platform mode writes format 2, which also carries, inside the same
encryption, what restoring on a new machine needs beyond the dump: Kiln's
installation record with its ID and every secret, and the platform Relay's
identity, its TLS authority, and the Hearths it trusts, so the restored Hearth
reconnects to the same Relay. Format 1, which a Hearth run by hand still writes,
holds only the dump: restoring it on a new machine also needs that Hearth's
environment, or a recovery kit. Every Kiln restores the dump of both.

Neither format restores the settings passed to the Relay's own container, such
as email or signup settings: they come from where Kiln is installed. A Relay in
platform mode also exports its record by itself as a recovery kit
(`kiln-relay platform export-kit`); see
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

Restoring Kiln stays offline (see below). Its Restore shows the command for the
Relay's host and, where the Relay installed Kiln, opens that Relay's terminal
with it typed for the operator to send.

## Scheduled backups

A Relay runs its schedules on its own, so scheduled backups it can make
alone, to its own disk, go on while Hearth is away. Hearth decides whether
each one may run as it decides a manual backup's reservation, and puts the answer in the schedule it sends
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

A full backup to a bucket is Hearth's to take, since only Hearth holds the
bucket's keys. The schedule tells the Relay that the step goes to a bucket
and nothing of the bucket itself. When a run reaches the step, the Relay
asks the Hearths connected to it (`schedule.backup.take`) to take what it
backs up, naming the schedule, the step, the run, and each thing. Hearth
reads the rest from its own schedule (`takeScheduledBucketBackups`): the
step must be one it has for that Relay, each thing one the step backs up
there, and admitted as it would be if the schedule were sent now. It then
catalogs each backup, at the object key it chooses, and sends their tasks
together, as it sends a manual run's, each with a signed upload. From there
it is a manual backup in all but its reason: it is refreshed after a
restart, restored and deleted the same way, and leaves out what the
resource's exclude patterns say. Hearth answers with the IDs it gave each
backup, and the Relay waits for those tasks. The IDs are keyed with
Hearth's secret over the Relay, the run and what it backs up: the same on
every ask of one run, so asking twice, as each target of a batch does,
takes them once, and none a Relay can work out ahead of Hearth to take
first. A batch's name is Hearth's too, from the same run and its members.
(Rotating Hearth's secret mid-run gives a retry new IDs, so one run's
backup can be taken twice then.)

What this promises, for full backups, is that the bucket's secret key
never reaches a Relay, and that a Relay can reach no object in a bucket
that Hearth didn't choose for one of its own backups. Its access key ID
does, inside every signed URL, as for a manual backup or a download link;
it can sign nothing on its own. Backups cataloged before this release from a
Relay's own report keep the object it named; a run's retry matches one
only at the object Hearth would choose itself. Nor
is it yet a defence against a Relay that lies to Hearth about its own
work, which Hearth trusts elsewhere too
([#1011](https://github.com/kiln-site/kiln/issues/1011)).

The step waits for its task to arrive and finish. What that leaves:

- With no Hearth connected, or none that takes it, the step fails and says
  why; the Relay makes nothing in its place. The schedule's other steps
  follow its `continueOnFailure`.
- A run is planned whole when it starts, so the Relay names the schedule
  revision it started with. If the schedule has been saved since, Hearth
  refuses, checking again once it holds the schedule's lane: a run never
  takes a backup by settings it wasn't planned under, and the next run
  takes the saved ones. What isn't the schedule's, a target's limits or
  which volumes an App uses, is read as Hearth is asked, as a Relay reads
  them from the schedule it last had. While what it backs up is being
  deleted or replaced, or the destination or schedule saved, Hearth refuses
  (`onlyIfFree`), saying what, as it refuses a person. An App's deployment
  isn't among those: as for a manual backup, the Relay holds a stopped
  backup and the deployment's build apart in its own lanes, by the App's
  lifecycle lock, and a live backup runs beside it.
- Hearth takes all of what one ask names or none: a volume an App has let
  go of since the schedule was sent refuses the rest with it, until the
  schedule is sent again.
- Hearth works on four of one Relay's asks at once, and lets twelve more
  wait for a turn. Each holds its turn from before Hearth reads anything
  for it until the tasks it made are first sent; a later pass over the
  Relay's backups runs outside it. One that waits twenty seconds for a
  turn, or arrives with twelve already waiting, is refused, saying Hearth
  is busy, and the schedule's next run is taken as usual. One the Relay
  gives up on stops waiting; one that has its turn is taken and sent
  whether or not the Relay still hears. Asked again for a run it already
  took, Hearth sends nothing new, and a run asked again as part of another
  batch than it was taken in is refused. Hearth goes over one Relay's
  backups one pass at a time: asked for while a pass runs, one more
  follows it.
- The owning Relay still says which run is due and what of it: a run time
  and the members of a batch are its word, as its own schedule is. What
  keyed IDs stop is another Relay's report, or this one's, claiming the IDs
  of a take before Hearth makes it.
- A step waits 30 seconds for Hearth's answer and three minutes for its
  task. Hearth goes on with one it started, so a backup can be taken and
  turn up after its step failed; a step with no answer says Hearth may
  still take it.
- A stopped batch's tasks are sent together, sixteen at a time, by the
  ask that took them (another of the batch's asks sends nothing), and the
  Relay waits five seconds for a scheduled batch to be whole (see
  [Formats and live consistency](#formats-and-live-consistency)). Any not
  sent then go on Hearth's next pass, a task after another; a batch still
  short after the wait is failed whole, with nothing stopped.
- Updating from a release that sent keys: migration 51 drops them from
  every stored schedule, and fails a scheduled bucket backup still waiting
  to be made with them, removing its keys too, since Hearth wouldn't record
  a file it never chose. One that already finished but that Hearth hadn't
  read before it updated stays in the bucket unrecorded. Let schedules that
  back up to a bucket finish and be read before updating, then rotate the
  bucket's keys.

A step that backs up an App backs up each volume it uses, each admitted on its own. It's taken live,
or stopped once for all of them as a batch; saving a stopped one takes
`instance.power.stop` on the App and every App using those volumes, and while their
Relay can't say which those are, only a stopped step the schedule already had
is kept. A volume can be a schedule's target too, as it can be a manual
backup's: admitted as a manual backup of it is, and, stopped, it stops
every App that uses it, which saving it takes `instance.power.stop` on.

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
Hearth catalogs what the Relay ran on its own as before: a full one on the
Relay's disk, whatever the Relay says of a bucket, and an incremental one
in the repository its schedule named; one whose repository is gone by then
is cataloged as failed, since it can't be restored. A full one the Relay
says is in a bucket isn't recorded at all: Hearth would sign restores and
deletes of whatever object it named.

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
same kind on its Relay: a game server, a database, or a volume. That's how a backup of a resource since deleted is restored, and the
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
archive's manifest is checked against; a restore of a volume journals and
fences the volume it goes into. A database dump's first
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

Restoring a volume requires every container that mounts it to be stopped;
the Relay checks. The Relay checks the archive's manifest and every entry, so
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
A Relay in platform mode does it in one command, on the machine that has Kiln
or on a new one (see [Self-hosting](self-hosting.md#recovery)):

```text
kiln-relay platform restore /data/backups/<backup-id>.zip
```

It authenticates the whole bundle before changing anything, holds Hearth
stopped, saves the database that's there as another platform backup, which
restoring undoes it, and replaces it. It records no progress: one that fails or
is stopped is run again from the start, and Hearth stays stopped until one
finishes. Where the Relay didn't install Kiln, stop Hearth, keep its MySQL and
Relay containers running, and use:

```text
kiln-relay platform-backup inspect /data/backups/<backup-id>.zip
kiln-relay platform-backup restore /data/backups/<backup-id>.zip \
  --confirm <installation-id>
```

`inspect` prints the installation ID the bundle belongs to. Either refuses a
backup of another installation, and the second refuses to run while a labeled
Hearth application container is running. A backup made with another key, as on
a machine since lost, asks `restore` for its recovery code (run it with
`docker exec -it`), and the Relay keeps that key from then on. Start Hearth
afterward; normal Relay
reconciliation repairs the restored catalog's queued snapshot of the backup
task, and sends a Relay that lost its schedules them again.

Deleting a game server, database, App, or Kiln volume is the durable
operation `resource.delete` (`apps/web/src/lib/resource-deletion.server.ts`),
one row per resource in `resource_deletion`. It checks the person who asked
may still delete it, freezes it on its Relay, takes a `final_delete` full
backup if one was asked for, recording the backup's ID on the deletion in the
reservation's transaction, and follows that backup to its end. An App's
deletion takes the App and its folder, and never a volume: the volumes it
used are no App's, stay with their data, and are deleted from Volumes by
whoever decides to. An App has no final backup: what it keeps is on those
volumes. Whoever deletes an App may tick "Delete its volumes too", which
names the volumes only it uses on its deletion (`volume_ids`): once the App
is gone from its Relay, each is deleted as deleting it from Volumes does, a
deletion of its own that takes `relay.configure`, so one something else
came to use meanwhile stays, and says so on its Relay's Volumes. Each is
asked for on its own, and again if that fails; if one still can't be, the
App's deletion stops and says which are left, rather than end as if they
went. A volume is asked for once: it is taken off the App's deletion as its
own is recorded, so trying the App's again asks only for the rest, and
never starts again a volume's deletion that failed or was kept since. A final backup never starts what it stopped,
so the Relay refuses one, stopping nothing, that finds an App using the
volume it backs up, as one deployed since. Deleting an App on its Relay is safe to send again, and
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
([Moving and duplicating](resource-migrations.md)) can take the
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
manifest against the original server. Downloads Hearth signs for a linked backup, and copies
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

The picker also scopes to an App, showing the backups of what it keeps: the
volumes its configuration mounts, its Compose file declares or its
containers use. A row of a volume says whether it was taken live or
stopped, and its restore dialog says what must be stopped (every container
that mounts the volume, listing those running and the Apps that use it).

An App's Info rail opens Backups scoped to the App. Each named volume in
its Volumes table also opens Backups scoped to that volume, with a clearable
volume filter; the picker still shows the App. The Volumes section's
header says whether what the App keeps is backed up, by each volume's
newest backup that finished: "Backed up" with the age of the oldest of
them, how many of them are, or "Not backed up". An App that also keeps
something outside its volumes, as a row there warns of, reads "Volumes
backed up" instead: only its volumes are. It says nothing of an App with no
volumes, or to someone who can't see its volumes' backups.

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
(`apps/web/src/lib/target-picker-groups.ts`). Each volume can still be
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
Relay's volumes is offered those of the App the page is scoped to. The
schedule editor draws the same picker
(`apps/web/src/components/target-picker.tsx`), but a schedule names an App
itself, as the group of whatever volumes it uses when it runs, and can name
a volume of its own. An App's volumes are each Kiln
volume its configuration mounts, its Compose file declares or its
containers use, one another App uses too. A Kiln volume its configuration
mounts or its Compose file declares that its Relay doesn't have refuses the
backup, manual or scheduled, since it would leave that data out: the Relay
lists each volume an App names that it doesn't have (`missing`), and counts
it among what the App's backup must take. A schedule is sent again when an App
takes up or lets go of a volume.

A scheduled step works out what it backs up before it runs, each thing
once: each volume once however many of its Apps use it, and whether or not
the step also names it as a target. Apps that share a volume are backed up together, as one batch
(`scheduledAppBackupGroup`): each of them asks its Relay for the same
batch, by the same IDs, so the first makes it and the others wait for it,
and a stopped step stops them all once. A volume the step names that one of
its Apps uses is one execution with them, naming those Apps, and asks for
their batch too, waiting on its own backup; one none of them uses is backed
up alone, its stopped window its own. A stopped step that backs up
databases beside Apps or volumes takes all of them on a Relay as one batch
(`stoppedTogether`, `apps/relay/src/schedules.ts`): every volume its Apps
use, each volume it names, and each of those databases, so a database is dumped while the Apps are
stopped, as a manual stopped run dumps it. The batch is settled once for
the step, of the targets it still runs on in that occurrence and that
Hearth admitted: one skipped or refused is left out and backed up by no
other target's run, so a database is dumped while the Apps that are backed
up are stopped. Every App of the batch stays stopped for as long as all of
it takes; separate steps keep Apps that needn't wait on each other apart. The editor offers Stopped for a
step of Apps and volumes, with or without databases beside them. What refuses one of
them refuses each, and a batch is at most 64 backups. The volumes are those Hearth last
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

The Settings page configures each volume an App uses (choosing the App)
and each Kiln volume on a Relay ("Kiln volumes on …"), with the same
permissions as backing them up: retention, the platform ceiling, the
destination, and exclusions, which apply to a volume as to a game server's
folder, relative to its root.

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
installation keyring. A task or schedule carries that password and, for a
repository in a bucket, the repository's ID: no key, and nothing of where in
which bucket it is. Relay persists a task's input in its SQLite journal (mode 0600) before acknowledging; task reports leave the password out, terminal
journal rows scrub it even when the stored JSON is corrupt, and restic stderr
is redacted before it becomes a Relay error.

While restic runs on such a repository, the Relay runs a bridge for it on
`127.0.0.1`: a server of restic's REST protocol at a random port and a secret
path, gone when restic exits (`restic-bridge.ts`). For each file restic touches
the bridge asks Hearth (`backup.repository.access`) for one signed request,
good for ten minutes, and sends it to the bucket itself, so no backup data
passes through Hearth. A folder's listing Hearth reads from the bucket and
answers a page at a time. A file restic reads in many ranges is asked for once
in five minutes, which a download needs: it reads each file in the backup on
its own.

Hearth's rule is one (`backup-repository-access.server.ts`): a Relay reaches
only its own repositories. Hearth finds the repository by its ID and the Relay
whose connection asks, and works out the object from the repository's stored
prefix, under which files are where restic's own S3 backend keeps them. The
Relay names only a file restic could have there. Hearth refuses a destination
being deleted. It doesn't check what a Relay does to its own server's
repositories: that Relay takes the backups, and could as well back up
something else.

The bridge only goes to a public address over HTTPS unless the destination
allows private networks, as any backup request does. restic reports the status
line of a failed request and nothing else, so that is where the bridge puts the
bucket's reason, and a 403 ends the command at once where a 500 is tried again.
An incremental backup to a bucket needs Hearth: one that restarts is waited
for, and one away for two minutes ends the task (`hearth_unreachable`), so it
doesn't hold up the backups behind it. A scheduled backup then leaves its
changes to the next run.

A bucket that requires a checksum with every write, as one with Object Lock
retention by default does, refuses these uploads, since Hearth signs a request
before there is a body.

Updating from a release that sent keys: Relay migration 52 replaces the
repository in stored schedules and tasks with its ID, so waiting tasks still
run. The keys were out until then; rotate them once every Relay has updated. A
bucket behind a private CA now needs it in the Relay's `NODE_EXTRA_CA_CERTS`, as
full backups do; restic's own `RESTIC_CACERT` no longer comes into it.

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
S3), creating a download link reserves an `export` task. Relay stages the zip
locally and serves it with the existing Relay download token. From a bucket it
restores the snapshot to a folder beside the zip and zips that: a restore reads
in bulk, where `restic dump` reads each small file from the bucket on its own,
which is slow and counts against a provider's request limits. That needs room
for the files as well as the zip. Without it, for a repository on the Relay's
own disk, and for a snapshot with something Relay's zip can't hold as it is,
such as a name with a backslash, Relay runs `restic dump -a zip`. Either way the
zip holds the same files, folders and links. Export files expire after five
minutes and are swept on Relay startup, as is a folder a stopped Relay left.

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
