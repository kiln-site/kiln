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
info card says which parts come and why any can't. When the Relay can't say
which web routes it has, the dialog won't start a move that takes them, and
Hearth reads them again before anything is made or stopped. Under it, the dialog
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
| Web routes         | Stay      | Optional | Routes move to the new server, as below; their hostnames must then point at the new Relay before HTTPS works.                                                                                                                                                                                     |
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

### Apps

The copy is made with the old one's whole configuration, and the Brick it
follows if any. A duplicate is never deployed: someone deploys it once
they've checked its settings. A move deploys it ([below](#deploying-a-moved-app))
unless it's asked not to. It's filled from the old one's folder and from each
volume it keeps data on, each its own part of the copy:

- Each volume its settings mount is copied into a new volume of the
  copy's, which its settings mount in the old one's place. A volume other
  Apps share is copied too, and stays where it is for them; the copy stops
  seeing what they write, as the dialog says.
- Each volume the Relay keeps for a key of its Compose file is copied into
  the one the copy's Relay keeps for the same key, made before the copy
  first deploys (`app.volumes.keep`), so its first deployment finds it.
- A volume only its containers mount, named by neither, isn't copied, and
  the dialog names it.

Its database connections aren't carried: its environment still names
them, and connecting the copy is its owner's to do. A path on the node it
mounts is mounted as it is on the copy's node, and nothing there is
copied; a duplicate on the same Relay would also publish the same ports,
which the dialog says to change first. The repository it builds comes
with it, deploying only when asked; a move hands deploying on a push to
the copy and stops it for the old one. It has no final backup: what it
keeps is on its volumes, which deleting it leaves. A copy that's undone
takes the volumes made for it alone with it, for someone who may delete
volumes there; otherwise they stay.

Copying one needs its `app.manage`, since its settings carry its secrets,
and `instance.files.read`, and `app.create` on the Relay the copy goes to,
with what making an App with its settings takes there besides: the
Relay's `relay.files.write` for a path on the node, as saving one in its
settings takes, and its `app.manage` for published ports or a Compose
file or Dockerfile, as installing one from a Brick takes. It has an owner
and web routes to hand over. Handing its routes over takes
`instance.network.write` on the Relay the copy goes to as well as on the old
one, since owning an App doesn't carry it. Deploying the copy takes
`instance.deploy` there.

#### Deploying a moved App

A move of a running App deploys the copy once it's filled, and hands
nothing over until it's ready, as any deployment is
([App deployments](app-deployments.md#rolling-deployments)). It runs what the
old one ran: the commit it was last built from, or the digest its image is
run by. One whose source changed since, or that has no version of its own,
deploys as any deployment of it would.

Once it's ready its Relay is given its routes, and asked whether its own
Traefik serves them, before any name points there. A copy that doesn't start,
or none of whose routes Traefik reaches, ends the move: it's removed, the old one is
started again, and its domains, owner and deploying on a push never left it.
It's the same when the move is cancelled while the copy starts. A Relay whose
websites another proxy serves can't be asked, and isn't.

The old one stays stopped until then, so it's away for as long as its data
takes to copy and the copy takes to build and start. One that wasn't running
isn't deployed, nor is one whose move was asked not to, whose domains don't
answer until someone deploys it. The dialog starts with that for an App
connected to a database, which would start without it.

Bundled Traefik serves the domains it's handed at once. An external one reads
them from the copy's containers, so the copy is deployed once more after the
move, with the same version, to carry them.

It's steps of the move itself, not a deployment queued beside it, which
would wait behind the copy the move holds. It's recorded among the copy's
deployments.

A copy keeps the parts it settled on (`part_roots`), so undoing it
discards exactly the transfers it started, though an App's settings and
volumes may have changed since.

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

### Web routes

A copy's Relay has its routes before its names point there, and the old one's
are taken from it before they do. Until then bundled Traefik asks for no
certificate for them (`holdCertificates`): the names resolve, to the old Relay,
so Let's Encrypt would check there and fail, and Traefik doesn't ask again. Once
they point at the copy's Relay, it's told so (`relay.certificates.release`) and
asks ([Certificates](domains.md#certificates)); a name whose record can't change
yet is released when it does, by the DNS worker.

A kind with web routes hands them over whole: each keeps its hostname, path,
options and, for an App, the service it reaches, and is given an ID of its
own by the new Relay. A primary address that is one of them is the copy's;
one that is a name in a tunnel stays the old one's.

Every kind's routes are one schema (`relayInstanceWebRouteSchema`), so what
reads them never asks whose they are. They differ in one thing, checked
where they're saved (`relayWebRouteInputsSchemaFor`): an App's route names
the service it reaches, and a game server's never does.

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
6. **deploy**: for a moved App that ran, deploys the copy and waits until
   it's ready.
7. **finish**: hands over ownership, access, domains, routes, and backups
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
