# Relay operations

Every change to a game server, App, or database on a Relay waits its turn in
one place: the Relay's operation lanes (`apps/relay/src/operation-lanes.ts`,
built on the lane rules in `packages/operations` that Hearth shares).
Hearth's requests, the browser's direct console and uploads, SFTP, schedules,
crash recovery, and the Relay's own workers all go through them, so a feature
gets ordering and exclusion by naming the resources it touches instead of
adding a lock of its own. Port reservations are the one exception: they take
a reservation lock of their own rather than a lane.

## Lanes

An operation names lock keys, each **shared** or **exclusive**. It runs once
no running operation holds a conflicting lock and no operation admitted
before it is still waiting on a conflicting one. So:

- Operations that conflict run in the order they were admitted.
- Operations on different resources run at once.
- An operation gets all of its locks together, never some of them, so lanes
  can't deadlock.
- A shared operation can't overtake an exclusive one waiting ahead of it, so
  a steady stream of readers can't starve a writer.

A resource and its parts are separate keys. Work on a part takes the whole
resource shared and the part exclusive; work that replaces the resource takes
it exclusive, which waits for every part.

| Key                                                | Taken by                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instance:<id>`                                    | Shared by every change to a game server; exclusive to replace it (restore, reinstall, delete)                                                                                                                                                                                                            |
| `instance:<id>/lifecycle`                          | Exclusive to power actions, console input, crash recovery, the disk-quota stop, and container recreation for ports, routes, and database connections                                                                                                                                                     |
| `instance:<id>/files`                              | Exclusive to Hearth file writes                                                                                                                                                                                                                                                                          |
| `instance:<id>/metadata`                           | Exclusive to renames                                                                                                                                                                                                                                                                                     |
| `app:<id>`, `app:<id>/lifecycle`, `app:<id>/files` | The same shape for Apps; a deployment's build, connecting the App to a database, and a scheduled command hold the lifecycle lock                                                                                                                                                                         |
| `app:<id>/volumes`                                 | Exclusive to recording which Kiln volumes an App's configuration mounts, apart from its lifecycle so saving a configuration never waits behind a deployment                                                                                                                                              |
| `database:<id>`                                    | Exclusive to database changes, connecting a member to it, and connecting it to another; shared by power, commands, dumps, backups, and Hearth's handover of Apps' connections                                                                                                                            |
| `database:<id>/lifecycle`                          | Exclusive to power actions and scheduled commands; shared by dumps and backups, so neither stops or runs in a database mid-dump                                                                                                                                                                          |
| `relay:routes`                                     | Shared by starts; exclusive to route, port, proxy, and networking writes, and to rewriting bundled Traefik's routes when which certificates it asks for changes                                                                                                                                          |
| `relay:tailscale`                                  | Exclusive to the Relay's Tailscale settings; shared by stack changes                                                                                                                                                                                                                                     |
| `relay:allocations`                                | Exclusive to checking limits and reserving the node's memory and disk (CPU is shared, so each limit need only fit the node): limit changes, a deployment's container start, and a game server's check before it's created or replaced, whose reservation stands in for it until its new container exists |
| `relay:host-files`                                 | The host file root                                                                                                                                                                                                                                                                                       |
| `volume:<id>`                                      | Exclusive to creating, renaming, and deleting one of the Relay's named volumes; shared by deployments that mount it and by recording that configurations mount it, so a deletion sees both                                                                                                               |
| `relay:platform`                                   | Exclusive to each pass over Kiln's own services, to restarting or repairing them, and to replacing the installation; shared by writes to Kiln's own database and by its backups, when the Relay hosts them ([Self-hosting](self-hosting.md))                                                             |

A database connection (`database.network.write`) names its member by kind:
a game server, an App (every service of it), or another database. It locks
the database and the member as their other changes do, so it runs in order
with deleting either. The Relay keeps connections in SQLite whether or not
the network or the member's containers exist now, and applies them whenever
the member's containers are created, deployed, or recreated. On the
database's network a member answers to a stable name: `server-<id>` for a
game server and `database-<id>` for a database (the name a database has on
its own network too), by full ID, and each App service to its alias on the
App's own network (`app-<short id>`, or `<service>.app-<short id>`). Each
member is reported with the database (`members`): the names its containers
answer to there now, and those it gets when they next change: one that
joined before members had names takes its name when it next starts,
restarts, or deploys, when its connections drop anyway, rather than being
reconnected under people using it. Hearth shows a member
only to someone who may read it and the database's network. Deleting a
database forgets every connection to it and its own; deleting a game server
or an App forgets its own. A client needs the database's
`database.network.write` and the member's own permission
(`instance.network.write`, `app.manage`, or the member database's
`database.network.write`).

Hearth hands over the connections it used to keep in Apps' configs
(`database.network.import`, which needs `app.manage` too; see
[`app-database-connections.server.ts`](../apps/web/src/lib/app-database-connections.server.ts)).
The Relay adds only pairs it doesn't have, of Apps and databases it still
has, and never one someone connected or disconnected on it: every such
change leaves a record (`relay_database_connection_choices`), so a handover
repeated, or sent by another Hearth, overrules nobody.

A Tailscale network's members are named by kind: `instance:<id>` for a game
server, `app:<id>:<service>` for an App's service, and `database:<id>` for a
database, which keeps its address when its container is replaced. Every
member takes its addresses again as it starts, a game server's crash
recovery included, and all of them do when the Relay starts, so one its
container lost, as when the Relay stopped between replacing a container and
reattaching it, comes back. A start can attach a member at the same time as
an apply that keeps it, since that apply holds the member only shared; each
accepts the endpoint the other put there. Deleting any of them takes it
off its networks once the resource itself is deleted; Hearth has already
written their DNS without it. Applying a network (`relay.tailscale.stack.apply`) holds
the network's own stack exclusively and
takes the lifecycle lock of each game server or App it joins or takes off
(a database it holds whole), so it waits
for that member's power changes as they wait for it; a member it leaves as it
is is held shared, so it isn't deleted or replaced meanwhile. Removing a
network does the same for all its members. The locks are planned from the
members the network has when the change is admitted, and the change refuses
to run if they've changed by its turn. Taking a deleted resource's members
off its networks rereads each network's configuration inside the network's
own exclusive lane, so deletions at the same time can't overwrite each
other's bindings.

Hearth alone writes a network's DNS records (`relay.tailscale.stack.dns`),
each time from what the network's Relays hold then
(`relay.tailscale.stack.state`). It asks only those: the ones a save is
applying it to, or, for a deletion, the ones Hearth recorded when it last
saved it. Records are the enabled members of nodes not being removed,
leaving out members whose resource is frozen for its deletion. Each node keeps the records Hearth
last sent and serves them again whenever it recreates its DNS container;
it never makes up records of its own. In Hearth, saving a network,
connecting it to Tailscale, syncing it and rewriting its DNS all take its
`tailscale-network:<id>#settings`, so they go one after the other and the
last one read the latest state; creating or removing it takes it whole. A
resource's deletion rewrites its networks' DNS as its own durable operation
(`tailscale.network.dns`) right after freezing it, and waits for that to
succeed before backing it up or asking its Relay to delete it; keeping it
rewrites them again once it's let go. A member's DNS is gone from the
moment its resource is frozen: a database stays running for its final
backup, but its hostname no longer resolves. A failure leaves it frozen
and nothing deleted.
Relays rewrite bindings saved with a
game server's bare ID when they start, and Hearth its copies of them in a
migration.

`apps/relay/src/operation-plans.ts` maps each control operation to its keys.
Its switch is exhaustive, so a new operation can't compile until it declares
what it locks, or that it locks nothing.

Most reads take no locks: they never wait, and they may see a resource
mid-change. Reads that must see it whole, such as a database dump or completing
a console command, take its locks shared.

### Arrival order

The control socket admits a request as its frame arrives, before checking
the client's grant or looking anything up, so requests keep the order Hearth
sent them. A request names its game server by full ID, which needs no lookup.
One that names a server by short ID or name is looked up first, and nothing
admitted after it is granted until the lookup settles.

Browser console input is admitted the same way when its frame arrives.

### Disconnects and timeouts

A request still waiting when its Hearth disconnects, cancels, or times out
is withdrawn and never runs, so a command can't run long after the person
who sent it gave up. A request already running finishes and keeps its locks
until it does: its Docker work can't be undone halfway, and releasing the
locks early would let conflicting work run against a half-changed resource.

### Work that runs in the background

Requests that hand work to a background worker, such as queueing a backup,
provisioning or a transfer, take no locks themselves; the worker locks the
work when it runs it. A deployment is checked and recorded under the App's
lifecycle lock, which its build takes again when it runs:

- **Backups** run alongside other work on their target (shared lock). A
  **restore** runs alone (exclusive), so it waits for file writes and power
  changes and nothing starts the server mid-restore.
  An App's folder or a volume backed up **stopped** also holds the
  lifecycle of each App it stops (for a volume, its owner and every App
  that uses it), so nothing starts them meanwhile, and holds a volume
  exclusively, so no App that begins using it deploys or starts either. A volume's restore holds
  the volume exclusively with every such App's lifecycle; an App folder's
  restore replaces the App. A restore whose swap didn't finish keeps its
  target fenced: the lanes refuse every operation that locks it, and those
  that start, deploy, or replace an App using the volume, until its
  recovery (`backup.restore.recover`) finishes or abandons it. Starting
  or deleting an App holds every managed volume it mounts shared, and a
  deployment holds every one its Compose file declares too, by Docker name, in a
  nested step before it makes containers, checked against the same fences.
- **Provisioning** holds the new server exclusively while it's created.
  Jobs for different instances run at once, up to half the host's cores
  (two to four), so a slow image download or install doesn't hold up the
  creates queued behind it. Past the first job, another starts only while
  the host's load average is under one per core, so provisioning doesn't
  slow running game servers; while it isn't, the worker checks again every
  five seconds or when a job finishes. Jobs start in the order they were
  queued, except that game servers are created one at a time, since creating
  one changes what they all share (the game network, the Relay's DNS records,
  and private hostnames); databases and Apps queued after a waiting game
  server go ahead of it.
- **App deployments** hold the App's lifecycle lock for the whole build. An
  App delete stops a running deployment before it waits, so it doesn't wait
  for the build it's removing.
- **Transfers between Relays** pack their source beside other work, as a
  backup reads it (`transferPackLocks`), and install alone, as a restore
  does (`transferInstallLocks`), so no upload or SFTP write changes the
  folder while it's written. Serving and fetching the artifact take no
  lock. See [Relay transfers](relay-transfers.md#between-relays).

Exports, prunes, and backup deletes touch only stored artifacts and take no
lock.

### Crash recovery and the quota stop

Crash recovery and the disk-quota stop are Relay-initiated changes in the
server's lifecycle lane. Recovery waits behind someone's power change or
console input, and checks again once its turn comes: if that change set the
server to stopped, it doesn't start it. The snapshot loop only notes recovery
candidates; it never waits for a lane, so a power change that samples the
server can't deadlock against recovery.

### Power

Game servers, Apps, and databases change power through one path
(`apps/relay/src/resource-power.ts`). Each starts, stops, restarts, and
kills its containers with the same Docker calls, and keeps what's its own
around them: a game server's stop command and container recreation, a
database's wait until its engine answers, and an App's every container (a
kill reaches those still running). A power action takes the resource shared
and its lifecycle exclusive, and a game server's start or restart the routes
shared too
(`resourcePowerLocks`).

### Schedules

A schedule's steps are ordinary operations. A schedule notes each target's
power intent when an occurrence begins: how many power changes someone else
has asked for (a power action, or a stop typed into a game server's
console), and how many times the target has been replaced: every operation
that took it whole and exclusively, and for an App every deployment that
began replacing its containers. A later power step runs only
if neither has moved, checked at the moment the step's turn comes. So a
person who stops a game server, App, or database during a schedule's Wait
isn't overruled by the schedule's Start, and the step is recorded as not
run. A schedule's own steps don't move the intent. A power step takes the
locks the same request from Hearth would, an App's start the volumes it
mounts too, and moves the App's power revision as a person's change does,
so a stopped backup's restart gives way to it. A step on a resource being
deleted is refused as every change to it is, and recorded as not run.

A Command step sends a game server's command to its console. For a
database, it runs `sh -c <command>` as a Docker exec in its current
container, and for an App in the current container of the service the step
names for it (`services`, by target key), in the resource's lifecycle lane
(`apps/relay/src/container-commands.ts`). Hearth checks the service against
the App's when the schedule is saved, and the step fails if a deployment
has since renamed or removed it. Commands and kills reach a database or App
only when the step's `targetKeys` names it and it carries
`authorizedTargets`, which Hearth sets on the steps it saves once it has
checked them for every target they reach. A step stored before was saved,
and authorized, when it skipped them, even one that named a database, so it
still does.

A Backup step on an App backs up its folder and every volume only it uses,
as a manual App backup does: Hearth sends one admitted execution per member
(`targetKind` `app` or `volume`, with `appId`), from the volumes the Relay
reported when the schedule was sent, and the Relay enqueues them all before
waiting on any. A member Hearth refused skips the whole step, recorded as not
run. A stopped one is a batch, so the App and every App using its volumes
stop once for all of them. A volume the App starts using after the schedule
was sent is backed up from the next time Hearth sends it.

- It has 10 minutes to exit. The step records its exit code and the last
  4 KiB of what it printed, stdout and stderr together; a non-zero code
  fails the step.
- A container that's missing, stopped, replaced before Docker started the
  command, or without `sh` fails the step, and the command didn't run.
- Once Docker may have started it, a command Kiln loses track of is
  recorded as unknown, never failed or retried: one that outlives its
  timeout (Docker can't stop an exec, so it may still be running), one whose
  stream breaks, and one whose exit Docker doesn't report. An unknown step
  stops its target's later steps, as a failure does.
- The step is written to the run as unknown before it's sent, so a Relay
  restart mid-command leaves it unknown in the interrupted run, which is
  never run again. A command whose record can't be written, after a few
  tries, fails without being sent.

### Files over SFTP and uploads

SFTP changes and browser uploads run alongside other file work on their
server, and wait for anything replacing it. An SFTP file handle notes how many
times its server had been replaced when it opened; once a restore, reinstall,
or delete has replaced it since, further writes through that handle fail and
the client must reopen the file. Nothing holds a lock between SFTP calls, so
an idle SFTP session never blocks a restore.

## Operation IDs

Hearth gives every change it sends an `operationId`, separate from the
request's frame `id`. `relayControlOperationChanges` in the contracts says
which operations are changes; reads and terminal traffic aren't.
A change Hearth sends as a step of one of its own operations also names it
in `parent` (`operationId` and `step`). The Relay puts it on the request's
span (`kiln.operation.id`, `kiln.operation.step`) and in the change's audit
details (`hearthOperationId`, `hearthOperationStep`); it grants nothing.

The Relay claims a change as soon as it's authorized, so a repeat from any
of the same Hearth's sessions waits for it. It records the change in its
SQLite journal (`relay_operations`) as accepted before the change does
anything. How it went is kept in memory as soon as it finishes, which is
where lookups look first, and written to the journal without holding up the
reply; a Relay that's shutting down waits for those writes. The journal
keeps outcomes, never replies, which can carry secrets such as pairing
tokens; a finished change's reply stays in memory for 20 minutes, for the
Hearth that sent it. Records are kept per paired Hearth for a week.
`operation.get` answers with what the Relay knows of an ID:

| Answer        | Meaning                                                              |
| ------------- | -------------------------------------------------------------------- |
| `unknown`     | The Relay never started a change by that ID, so it didn't run.       |
| `running`     | It's running or waiting its turn.                                    |
| `succeeded`   | It ran; the answer carries its reply while the Relay still has it.   |
| `failed`      | It failed, or was withdrawn before it ran (`operation_withdrawn`).   |
| `interrupted` | The Relay restarted while it ran, so it may or may not have applied. |

When a connection drops with changes still waiting for their replies, Hearth
keeps waiting for each one until its deadline. Once the Relay is back, it asks
`operation.get` how each went, and answers its caller with the result. It
never sends a change again: a change the Relay didn't receive fails as not
run, so the caller decides whether to try again.

A change that outlives its deadline, or that a restart interrupted, fails
with `RelayUnavailableError` and `outcome: "unknown"`. It may have applied,
so it shouldn't simply be retried; check the resource first.

The Relay never runs one ID twice. A repeated request with the same ID and
payload gets the first one's answer; one with a different payload fails with
`operation_conflict`. A Hearth can only look up its own changes.

`unknown` only means "never ran" for the journal that would have recorded
it. A rebuilt Relay state starts a new journal, and a Relay paired again
journals Hearth's changes under the new client, so both forget earlier
changes while the Relay keeps its identity. The Relay names its journal in
`auth.ready` (`journalId`, kept in `relay_metadata`). A request can carry the
journal it was first sent to: the Relay refuses one for another journal with
`journal_changed`, and Hearth refuses to send one first sent under another
pairing. Hearth's durable steps send every change and lookup this way
([`relay-command.ts`](../apps/web/src/operations/relay-command.ts)), so a
change whose journal is gone stops for someone to check rather than running
twice.

A cancelled change answers too: `request_cancelled` if it was withdrawn
before it ran, or its real outcome if it was already running.

## Hearth's audit

Hearth records every change a person or CLI credential sends a Relay in
`kiln_audit_event`: who asked (a user, or a CLI credential acting for one),
the operation, the resource it acts on, the Relay, and the operation ID.
`relayRpc` writes the row as pending before sending the change and gives it
its outcome after: `succeeded`, `failed` (with the error's code), `not_run`
when the change never reached the Relay, or `unknown`. Only short fields that
say what a change was, such as a power action, are kept from its payload;
file contents and credentials never are. Error messages aren't kept either,
since some repeat what was sent, such as a password a database refused.

An audit write never holds up the change it records. A change waits up to
two seconds for its pending row, then goes ahead; the row and its outcome
still land in order once the database answers.

A row a Hearth restart left pending is settled when Hearth next connects to
the Relay, by asking `operation.get`. Rows younger than the longest change
deadline are left alone, since a request may still be waiting for them; a
second pass runs once that deadline has passed, and a few more while some are
still running. A Relay forgets a finished change after a week
(`relayOperationRetentionMs`), so one it doesn't know that's older than that
stays `unknown` rather than `not_run`.

Console commands and file transfers go from the browser straight to the
Relay, so Hearth never sees them; the Relay records them in its own audit,
which Hearth's activity reads with `relay.audit.list`. Changes Hearth makes
on its own, such as backup reconciliation, aren't audited here; the Relay's
journal and audit still record them. `listAuditEvents` reads the audit,
newest first, optionally for one resource.

## Paused Relays

Pausing a Relay freezes it. Its game servers keep running, but nothing on it
changes until it's resumed, whoever asks: Hearth, the CLI, the browser's
console and uploads, SFTP, schedules, crash recovery, the disk-quota stop,
and the backup, provisioning, and deployment workers.

Each paired Hearth holds the pause for itself (`relay.pause.write`), and the
Relay is paused while any Hearth holds it, so one Hearth resuming can't undo
another's pause. Hearth sends its hold when someone pauses or resumes the
Relay, on every connect, and every 30 seconds while the Relay reports
otherwise, so a pause or resume it missed still arrives. Hearth keeps a
connection to paused Relays from startup for this, so the pause still
arrives if Hearth restarted while the Relay was away. What Hearth shows comes
from the Relay's own `relay.paused`: a Relay paused in Hearth reads as
Pausing until it has the pause, and one another Hearth paused reads as
Paused. The Relay keeps
holds in SQLite and reads them before any worker starts, so it stays paused
across restarts. Revoking a Hearth clears its hold, and a pause that raced
the revocation leaves none behind.

While paused:

- New changes and terminal input are refused with `relay_paused`, and
  changes waiting their turn, or let through but not yet started, are
  withdrawn. Work already running finishes.
- Schedule actions are recorded as not run, including one withdrawn while it
  waited its turn.
- Queued backups and provisioning jobs wait, and start once it's resumed. One
  already taken from the queue but withdrawn before it started goes back in
  line, without using an attempt.
- Crash recovery waits without spending its attempts, and starts a crashed
  server once it's resumed.
- A deployment waiting its turn is finished as failed.

`relayControlOperationRefusedWhilePaused` says what a paused Relay refuses.
It still takes pausing and resuming, and access revocations, which must reach
it whatever its state, and terminal heartbeats and detaching. Reads, the
snapshot loop, and network upkeep such as Tailscale forwarding rules carry
on.

Hearth also sends a paused Relay no changes: `relayRpc` refuses them with the
same `relay_paused` error, and `activeRelay` in `lib/relay-registry.ts` is
the one way server functions find the Relay for a person's change, failing
the same way for a paused one and as not found for a missing one.

## Resources being deleted

Deleting a game server, App, database, or Kiln volume first freezes it on
its Relay with `resource.freeze`, naming the deletion and the resource's full
ID. The
freeze takes the resource whole, as replacing it does, so it waits for
everything running on it. It records the freeze in SQLite, then quiets the
resource so nothing Kiln starts writes to it but its final backup:

- A game server is stopped.
- An App is stopped, and its containers' restart policies are set to `no`
  so Docker doesn't start them again.
- A Kiln volume has nothing to quiet: it's frozen only while no container
  mounts it and no App's configuration names it, the checks its deletion
  makes, and from then on an App that would start with it is refused.
- A database keeps running, since its final backup is a live dump of it.
  Everyone's terminal sessions on it end, its terminal clients are hung up,
  and new sessions and input are refused; attaching takes the database's
  lane, so one under way finishes before the freeze. Work a client already
  sent may still finish, and game servers and Apps connected to it can
  still write to it until it's deleted, so what's written during or after
  its dump may not be in its final backup.

What quieting changes is recorded with the freeze before it's made. From then on the lanes
refuse any operation that touches the resource when its turn comes,
whoever asks, including one already waiting: power, console input, files,
uploads, SFTP, restores, deploys, schedules, and crash recovery. They answer
`operation_refused`, as an unfinished restore's fence does. Only its final
backup (`backup.create`), its deletion, and `resource.freeze` /
`resource.unfreeze` still run. Nested work inside an
operation already granted isn't checked, and Tailscale changes leave a
frozen member's network as it was. Applying a network doesn't hold a frozen
member it leaves as it is, so a deletion that stops partway never keeps the
rest of the network from changing; joining or removing a frozen member, or
removing the whole network, is refused, naming the member. Terminals need a
running container, so a stopped resource has none.

A freeze belongs to the deletion that made it: another deletion of the same
resource is refused, and only its own deletion can let it go. Letting it go
puts back what quieting changed (an App's restart policies) and leaves the
resource stopped; one that can't be put back keeps the freeze, for letting
it go again. The Relay reads its
freezes before admitting anything after a restart and quiets each again,
in case Docker started one or the Relay stopped before quieting it, and
drops a freeze once it has deleted the resource. `ResourceFreezes`
(`apps/relay/src/resource-freezes.ts`) holds them for the lanes.

## Tracing a change

A change is one trace from Hearth to the Relay, sampled once at its start:

- `hearth.relay.request` on Hearth, with `relay.audit.wait` before it sends
  and `relay.audit.start` and `relay.audit.finish` for the audit row.
- `relay.control.request` on the Relay covers the whole request: the client
  check, the journal (`relay.state.get_operation`,
  `relay.state.start_operation`, `relay.state.finish_operation`), the turn in
  the lanes, and the reply.
- `relay.control.execute` is the work itself.

Every span that runs work in a lane notes how long it waited for its turn
as `relay.lanes.wait_ms`, whether it's a request's or a worker's.

Requests from the browser socket, SFTP, and the Relay's own workers start
their own traces, except provisioning, which continues the trace of the
request that claimed it:

| Span                               | What it times                                                                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relay.provisioning.job`           | One instance's create, from its wait for the instance's lanes to its last phase. Under the claim's `relay.control.request`; `relay.provisioning.kind`, `.attempt`, `.outcome`, `.failed_phase`, and `.running`, how many jobs ran once it started |
| `relay.provisioning.phase`         | Each phase: `preparing`, `pulling_image`, `creating_container`, `finalizing`                                                                                                                                                                      |
| `relay.apps.deployment`            | An App deployment, with `.pull`, `.build`, `.composeConfig`, `.composeUp`, and `.replace` for its steps                                                                                                                                           |
| `relay.apps.reserve`               | Checking an App's limits against the node and applying them, holding the allocations lane                                                                                                                                                         |
| `relay.apps.diskLimit.check`       | Measuring one App's data, and stopping it if it's past its limit (`relay.disk.stopped`)                                                                                                                                                           |
| `relay.databases.replaceContainer` | Recreating a database's container to remove a limit                                                                                                                                                                                               |
| `relay.databases.diskUsage`        | Docker measuring every volume, for databases' disk use                                                                                                                                                                                            |

## Transfers through Hearth

When Hearth carries a transfer for a Relay browsers or other Relays can't
reach, its tickets, slots and limits are in
[Relay transfers](relay-transfers.md#through-hearth).

## Limits

- **No preemption.** A kill waits behind a running start or stop like any
  other power change. A Docker start returns once the container is running,
  not when the game is ready, so this wait is short.
- **External effects.** Shell commands, SQL, the game itself, and changes
  made to Docker outside Kiln can change a resource without an operation.
  Lanes order Kiln's own changes; they can't see those.
- **Deletes wait.** A delete waits for a running backup of the same server
  and for provisioning that is still creating it, up to its deadline.
- **One Relay process.** Lanes are in memory. A Relay restart abandons
  operations still running and records them as interrupted; durable workers
  (backups, provisioning, schedules) recover their own jobs as before.
- **Unknown outcomes remain possible.** Docker can apply a change and the
  Relay can stop before recording it, or a Relay can stay away past a
  change's deadline. Hearth reports those as unknown instead of guessing.
  The Relay's SQLite database commits without waiting for the disk
  (`synchronous = NORMAL`), so a host power loss, unlike a Relay crash, can
  also roll back its last moments of journal records.
