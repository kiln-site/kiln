# Moving and duplicating game servers

A game server's Info page has **Move or duplicate**, above the Danger zone.
Both make a new game server with its own ID from the old one:

- **Duplicate** copies it to any Relay the person may create game servers
  on, including its own, and keeps the old server as it was.
- **Move** copies it to another Relay, stops the old server and leaves it
  stopped, and hands its place to the copy. Once the move finishes, its
  notification offers to delete the old server, with the usual confirmation
  and its optional final backup.

The dialog asks for neither a backup first nor deleting the old server.
The start request still takes both (`backup`, and `deleteSource` for a
move: a final full backup, then deletion, as deleting a server with a final
backup does, needing `instance.delete` and `backup.create`).

Copying needs the old server's `instance.files.read` and
`instance.configuration.read`, and `instance.create` on the Relay the copy
goes to. Each option needs its own permission on the old server, checked
when the copy starts.

The dialog brings everything besides files, settings, and limits along as
one choice, **Copy metadata**: people with access, backups, activity
history, and for a move, domains and web routes. Its info card says which
parts come and why any can't.

## What comes along

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

A duplicate can stop the old server while its files copy, then start it
again; a move always stops it. Stopping needs `instance.power.stop`, and a
duplicate that stops it also `instance.power.start`, whether or not it runs
when the copy starts. A copy whose owner isn't the person moving
it passes to the old server's owner when the move finishes.

## Room

A copy has to fit before anything changes. The dialog, the start of the
copy, and its first step each check, from what the Relays report
(`lib/server-migration-room.ts`):

- **Limits**: the copy's memory and disk limits must fit what the new
  server's Relay can still assign past every instance's limits, and its CPU
  limit that Relay's cores. A disk limit given to the copy must also hold
  the old server's files.
- **Disk**: the old server's Relay packs its folder into an archive, beside
  a backup first kept on that Relay; the new server's Relay fetches the
  archive and unpacks it, holding both until the files are in. The archive
  is counted at the folder's full size, since a world barely compresses. A
  copy on the same Relay needs all of it there.

Relays measure the folder and report their free disk through
`transfer.space` (`transfer-space-v1`). An older Relay is taken to keep
everything on the disk its snapshot reports, and a stopped server's size on
it is taken to be its disk limit. Disk is checked once more just before the
old server stops.

## How it runs

A copy is a durable operation, `server.migration`
([Hearth operations](hearth-operations.md#durable-operations),
`apps/web/src/lib/server-migrations.server.ts`), started once the start
request's checks pass. Its row in `server_migration` keeps how far it got
and how it ended, for the person and for activity history. It holds, until
it ends:

- **Move**: the old server whole, so nothing else changes it until its
  place is handed over.
- **Duplicate**: the old server shared, so it keeps running and can be
  changed meanwhile (a change made during the copy may be missed), and its
  `#migration`, so one copy of a server runs at a time; one that stops the
  old server also holds its `#power` and `#dns`.
- Either: the copy whole, both Relays shared, and each backup destination a
  backup first goes to, settled when the copy starts.

Its steps:

1. **create**: checks the copy fits, then provisions the new server,
   stopped, from the old one's Brick snapshot, variables, and limits
   (`lib/server-provisioning.server.ts`), under a provisioning key chosen
   before it starts. Its limits are reserved from here.
2. **provision**: waits up to 30 minutes for the new server to be created.
   The old server keeps running meanwhile.
3. **backup**: optional full backup, under an ID recorded before it's
   reserved, waited on until it's available.
4. **stop**: checks the disk again, then stops the old server, noting
   whether it ran.
5. **copy**: copies the old server's folder into the new one's, Relay to
   Relay ([Relay transfers](relay-transfers.md#between-relays)), under a
   transfer ID recorded before it's asked. Once the new Relay has unpacked
   it, both archives are deleted.
6. **finish**: hands over ownership, access, domains, routes, and backups
   as chosen, each its own step, starts a duplicated server's original
   again, and last asks for a moved server's final backup and deletion if
   chosen, queued to run once the move ends.

Each step's result is stored as it finishes, and a step cut off, as when
Hearth restarts, runs again, so each is safe to repeat. Waits check every
two seconds and store a step every five minutes. Each step that changes
something reads the person's account again and checks they may still do
what they asked.

The person who started it sees a progress toast (`ServerMigrationToasts`)
they can close or cancel from. Cancelling is an operation of its own that
marks the copy cancelled; the copy sees it between steps and while it
waits. However it ends, they get a `server.migration` notification, so a
closed toast or tab misses nothing.

A copy that fails or is cancelled before its last step is deleted, by a
deletion queued behind it, and the old server started again if the copy
stopped it. One that fails while handing things over keeps the new server,
which may hold what moved. Either way, what either Relay fetched or packed
for it is deleted. Undoing a copy is Hearth's own work: it only takes back
what the copy did, so it goes on whatever the person may do by then, and
its Relay requests go as Hearth's. Removing the partial copy is a deletion
for the person, its owner; if their account can no longer act, that
deletion stops and says so on the copy's page.

A move that deletes its old server can't be cancelled once it's handing
things over: entering that step and accepting a cancel are each one
conditional write, so exactly one wins. One whose old server's final backup
was already asked for ends as finished, however it ended, with the old
server stopped for deletion.

Copies a Hearth from before copies were operations left running aren't
carried on: at startup each is undone as a failed one is, by a
`server.migration.rollback-legacy` operation holding both servers whole.
