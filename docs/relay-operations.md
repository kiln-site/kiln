# Relay operations

Every change to a game server, App, or database on a Relay waits its turn in
one place: the Relay's operation lanes (`apps/relay/src/operation-lanes.ts`).
Hearth's requests, the browser's direct console and uploads, SFTP, schedules,
crash recovery, and the Relay's own workers all go through them, so a feature
gets ordering and exclusion by naming the resources it touches instead of
adding a lock of its own.

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

| Key                                                | Taken by                                                                                                                                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `instance:<id>`                                    | Shared by every change to a game server; exclusive to replace it (restore, reinstall, delete)                                                                                                                                                    |
| `instance:<id>/lifecycle`                          | Exclusive to power actions, console input, crash recovery, the disk-quota stop, and container recreation for ports, routes, and database connections                                                                                             |
| `instance:<id>/files`                              | Exclusive to Hearth file writes                                                                                                                                                                                                                  |
| `instance:<id>/metadata`                           | Exclusive to renames                                                                                                                                                                                                                             |
| `app:<id>`, `app:<id>/lifecycle`, `app:<id>/files` | The same shape for Apps; a deployment's build holds the lifecycle lock                                                                                                                                                                           |
| `database:<id>`                                    | Exclusive to database changes; shared by dumps and backups                                                                                                                                                                                       |
| `relay:routes`                                     | Shared by starts; exclusive to route, port, proxy, and networking writes                                                                                                                                                                         |
| `relay:tailscale`                                  | Exclusive to the Relay's Tailscale settings; shared by stack changes                                                                                                                                                                             |
| `relay:allocations`                                | Exclusive to anything that reserves the node's memory, CPU, or disk: limit changes, a deployment's container start, and a game server's check before it's created or replaced, whose reservation stands in for it until its new container exists |
| `relay:host-files`                                 | The host file root                                                                                                                                                                                                                               |
| `volume:<id>`                                      | Exclusive to creating, renaming, and deleting one of the Relay's named volumes                                                                                                                                                                   |
| `relay:platform`                                   | Exclusive to each pass over Kiln's own services and to restarting or repairing them, when the Relay hosts them ([Self-hosting](self-hosting.md))                                                                                                 |

`apps/relay/src/operation-plans.ts` maps each control operation to its keys.
Its switch is exhaustive, so a new operation can't compile until it declares
what it locks, or that it locks nothing.

Reads take no locks. They never wait, and they may see a resource mid-change.

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

Requests that hand work to a background worker take no locks themselves; the
worker locks the work when it runs it:

- **Backups** run alongside other work on their target (shared lock). A
  **restore** runs alone (exclusive), so it waits for file writes and power
  changes and nothing starts the server mid-restore.
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

### Schedules

A schedule's steps are ordinary operations. A schedule notes each game
server's power intent when an occurrence begins: how many power changes
someone else has asked for (a power action, or a stop typed into the
console), and how many times the server has been replaced. A later power step
runs only if neither has moved, checked at the moment the step's turn comes.
So a person who stops a server during a schedule's Wait isn't overruled by
the schedule's Start, and the step is recorded as not run. A schedule's own
steps don't move the intent.

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
which Hearth's activity reads with `relay.audit.list`. An audit page would
show both. Changes Hearth makes on its own, such as backup reconciliation,
aren't audited here; the Relay's journal and audit still record them. There's
no page for the audit yet: `listAuditEvents` reads it, newest first,
optionally for one resource.

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

A Relay browsers can't reach, such as one that dials Hearth from behind a
home router, has its file transfers and backup downloads passed through
Hearth (`/api/relays/<id>/browser/...`), as are copies another Relay pulls
from it when it can't reach it (`/api/relays/<id>/peer/...`). Hearth
reaches the Relay through a tunnel when the Relay dialed it, and directly
otherwise.

- **Tickets.** Before it spends anything on a request, Hearth checks that
  the credential it carries is one Hearth signed for that Relay: a browser
  capability, in the `Authorization` header or a native download's form, a
  backup link's token, or a copy's grant. It must name this Relay and this
  file root, backup or copy, and not have expired. Anything else gets 401 before a tunnel is
  opened. The Relay still checks all it does for a direct request, such as
  the browser's proof, nonces, revocation and paths.
- **Slots.** Hearth carries at most 8 transfers to one Relay at once, and
  64 for all Relays together (`KILN_RELAY_PASSTHROUGH_MAX`). Past that, a
  request waits up to 5 seconds for a slot, then gets 503 with
  `Retry-After`. Control connections don't count against these.
- **Stalls.** A transfer through Hearth that moves no bytes either way for
  60 seconds is ended, freeing its slot.
- **Rate.** `KILN_RELAY_PASSTHROUGH_BYTES_PER_SECOND` caps all transfers
  through Hearth together, for a Hearth on a metered or small server. It's
  off unless set.
- **Meters.** Hearth counts what it carries for each Relay: transfers open,
  bytes each way, and those turned away. The Relay's page shows them, and
  they're recorded as `hearth.relay.passthrough.*` metrics.

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
