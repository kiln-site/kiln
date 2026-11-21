# Moving and duplicating

An instance's Info page has **Move or duplicate**, above the Danger zone.
Both make a new instance of the same kind, with its own ID, from the old
one:

- **Duplicate** copies it to any Relay the person may create one on,
  including its own, and keeps the old one as it was.
- **Move** copies it to another Relay, stops the old one and leaves it
  stopped, and hands its place to the copy. Once a game server's move
  finishes, its notification offers to delete the old one, with the usual
  confirmation and its optional final backup.

Every kind moves through one operation, one dialog, one toast and one
notification. What differs between kinds is listed under
[Kinds](#kinds); the rest of this page holds for all of them.

The dialog asks for neither a backup first nor deleting the old one. The
start request still takes both (`backup`, and `deleteSource` for a move: a
final full backup, then deletion, as deleting one with a final backup
does, needing its kind's delete permission and `backup.create`).

The dialog brings everything besides the data, settings and limits along
as one choice, **Copy metadata**, of what the kind has: people with access,
backups, activity history, and for a move, domains and web routes. Its
info card says which parts come and why any can't. Under it, the dialog
lists what someone should know before copying this one, which each kind
words for itself (a copy that starts empty, what stays behind, what stops
reaching it).

## Kinds

A kind is a `MigratedKind` (`apps/web/src/lib/resource-migration-kinds/`):
what its copy is made from and how, where its data is, what it is called,
the permissions that name what copying it takes, and which of the things a
copy can be handed it has at all. One it lacks is never offered.

### Game servers

The copy is provisioned, stopped, from the old one's Brick snapshot,
variables and limits (`lib/server-provisioning.server.ts`), and filled
with its folder. Copying needs the old one's `instance.files.read` and
`instance.configuration.read`, and `instance.create` on the Relay the copy
goes to.

| Option             | Duplicate | Move     | Notes                                                                                                                                                                                                                                                                                             |
| ------------------ | --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files and settings | Always    | Always   | Its whole folder, the exact Brick it was built from, and startup settings. Ports are allocated afresh on the new Relay.                                                                                                                                                                           |
| Limits             | Always    | Always   | Memory, CPU, and disk limits start as the old server's and can be changed for the copy in the dialog, which offers the nearest that fit.                                                                                                                                                          |
| People with access | Optional  | Optional | The same grants, permissions, and presets (presets are copied to the new server). Pending invitations aren't. Needs `access.read`.                                                                                                                                                                |
| Activity history   | Optional  | Optional | The new server's activity includes the old server's history up to when the copy finished: shown as the old server's, and listed under the new one too, to whoever can see both; as the new server's own to whoever can see only it. It stays on the old Relay, so removing that Relay removes it. |
| Managed domains    | —         | Optional | With Cloudflare connected, domains move to the new server and their records point at the new Relay. Without it, Kiln manages no DNS and the dialog says to repoint any domain of your own.                                                                                                        |
| Web routes         | Stay      | Optional | Routes move to the new server; their hostnames must then point at the new Relay before HTTPS works.                                                                                                                                                                                               |
| Backups            | Optional  | Optional | Links the old server's full backups to the new one, sharing their archives ([Linked backups](backups.md#linked-backups)). Backups in S3 link anywhere; backups kept on the Relay only to a copy on the same Relay. Needs `backup.download`.                                                       |
| Backup first       | Optional  | Optional | A full backup to a chosen destination, finished before the source is stopped or copied. Needs `backup.create`. Not offered by the dialog.                                                                                                                                                         |

### Databases

The copy is made from the old one's Brick, engine version, database name
and username, with a password and hostname of its own, and the old one's
limits or those given in the dialog, applied once it's made. It is filled
with the old one's dump ([Relay transfers](relay-transfers.md#between-relays)),
so it has to run to be copied: it's never stopped first, and a move stops
the old one once the copy is in. What's written after the dump starts
isn't carried, which the dialog says, along with what connects to it on
the old Relay and stays there. An engine Kiln can't dump (Redis, Valkey)
is copied empty, as the dialog says too.

Copying one needs its `database.read`, and `backup.create` and
`backup.download`, since its Relay dumps it as a backup does, and
`database.create` on the Relay the copy goes to. It has owner and access
to hand over; its connections stay with the old one.

### Volumes

A Kiln volume has its move or duplicate in its row on the Relay's Volumes
page, since volumes have no page of their own. The copy is a new volume
its Relay makes, filled with the archive a backup of the old one is. A
volume has no power, owner or access of its own, and Hearth keeps no
record of one, so nothing is stopped and nothing is handed over: a move
leaves the old volume, and what uses it, where they are. The dialog warns
when something runs on it, since what that writes while it's copied may
be carried half-written, and says nothing mounts the copy until someone
chooses it in an App's settings.

Copying one takes what backing it up and restoring it do, on the Relay:
`relay.read`, `backup.create` and `backup.download` where it is, and
`relay.configure` and `backup.restore` where the copy goes.

## Power

A kind that runs can be stopped while it's copied. A duplicate can stop
the old one while its data copies, then start it again; a move always
stops it. Stopping needs `instance.power.stop`, and a duplicate that stops
it also `instance.power.start`, whether or not it runs when the copy
starts. A kind that has to run to be copied (`copiedRunning`) is never
stopped first: a move stops it once its copy is in. A copy whose owner
isn't the person moving it passes to the old one's owner when the move
finishes.

## Room

A copy has to fit before anything changes. The dialog, the start of the
copy, and its first step each check, from what the Relays report
(`lib/resource-migration-room.ts`):

- **Limits**: for a kind with limits, the copy's memory and disk limits
  must fit what the new Relay can still assign past every instance's
  limits, and its CPU limit that Relay's cores. A disk limit given to the
  copy must also hold the old one's data.
- **Disk**: the old one's Relay packs each of its roots into an archive,
  beside a backup first kept on that Relay; the new Relay fetches the
  archive and unpacks it, holding both until the data is in. The archive
  is counted at the data's full size. A copy on the same Relay needs all
  of it there.

Relays measure each root and report their free disk through
`transfer.space`. One a Relay can't measure is taken to be its disk limit,
and one with neither is counted as nothing and shown without a size. Disk
is checked once more just before the old one stops.

## How it runs

A copy is a durable operation, `resource.migration`
([Hearth operations](hearth-operations.md#durable-operations),
`apps/web/src/lib/resource-migrations.server.ts`), started once the start
request's checks pass. Its row in `resource_migration` keeps its kind, how
far it got and how it ended, for the person and for activity history.

The operation holds, until it ends:

- **Move**: the old one whole, so nothing else changes it until its place
  is handed over.
- **Duplicate**: the old one shared, so it keeps running and can be changed
  meanwhile (a change made during the copy may be missed), and its
  `#migration`, so one copy of it runs at a time; one that stops the old
  one also holds its `#power` and `#dns`.
- Either: the copy whole, both Relays shared, and each backup destination a
  backup first goes to, settled when the copy starts.

Its steps:

1. **create**: reads what the copy is made from, checks the copy fits, then
   makes it, under a key chosen before it starts. Its limits are reserved
   from here.
2. **provision**: waits up to 30 minutes for the copy to be made. The old
   one keeps running meanwhile. A kind may then settle what making it
   couldn't give it, such as a database's limits.
3. **backup**: optional full backup, under an ID named after the copy,
   waited on until it's available.
4. **stop**: checks the disk again, then stops the old one, noting whether
   it ran.
5. **copy**: copies each of the old one's roots into the copy's, one at a
   time, Relay to Relay ([Relay transfers](relay-transfers.md#between-relays)),
   under transfer IDs named after the copy. Once the new Relay has unpacked
   a part, both archives are deleted. The toast says which part it's on.
6. **finish**: hands over ownership, access, domains, routes, and backups
   as chosen, each its own step, starts a duplicated original again, and
   last asks for a moved one's final backup and deletion if chosen, queued
   to run once the move ends.

Each step's result is stored as it finishes, and a step cut off, as when
Hearth restarts, runs again, so each is safe to repeat. Waits check every
two seconds and store a step every five minutes. Each step that changes
something reads the person's account again and checks they may still do
what they asked.

The person who started it sees a progress toast (`ResourceMigrationToasts`)
they can close or cancel from. Cancelling is an operation of its own that
marks the copy cancelled; the copy sees it before each step and while it
waits, and finishes only if no cancel came first. However it ends, they
get a `resource.migration` notification, so a closed toast or tab misses
nothing.

A copy that fails or is cancelled before its last step is deleted, by a
deletion queued behind it, and the old one started again if the copy
stopped it. One that fails or is cancelled while handing things over keeps
the copy, which may hold what moved. Either way, what either Relay fetched
or packed for it is deleted. Undoing a copy is Hearth's own work: it only
takes back what the copy did, so it goes on whatever the person may do by
then, and its Relay requests go as Hearth's. Removing the partial copy is
a deletion for the person, its owner; if their account can no longer act,
that deletion stops and says so on the copy's page.

A move that deletes its old one can't be cancelled once it's handing
things over: entering that step and accepting a cancel are each one
conditional write, so exactly one wins. One whose final backup was already
asked for ends as finished, however it ended, with the old one stopped for
deletion.

Copies a Hearth was running when it was updated past
`0093_resource_migrations` aren't carried on; finish or cancel them first.
