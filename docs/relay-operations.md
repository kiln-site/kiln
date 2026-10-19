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

| Key                                                | Taken by                                                                                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instance:<id>`                                    | Shared by every change to a game server; exclusive to replace it (restore, reinstall, delete)                                                        |
| `instance:<id>/lifecycle`                          | Exclusive to power actions, console input, crash recovery, the disk-quota stop, and container recreation for ports, routes, and database connections |
| `instance:<id>/files`                              | Exclusive to Hearth file writes                                                                                                                      |
| `instance:<id>/metadata`                           | Exclusive to renames                                                                                                                                 |
| `app:<id>`, `app:<id>/lifecycle`, `app:<id>/files` | The same shape for Apps; a deployment's build holds the lifecycle lock                                                                               |
| `database:<id>`                                    | Exclusive to database changes; shared by dumps and backups                                                                                           |
| `relay:routes`                                     | Shared by starts; exclusive to route, port, proxy, and networking writes                                                                             |
| `relay:tailscale`                                  | Exclusive to the Relay's Tailscale settings; shared by stack changes                                                                                 |
| `relay:host-files`                                 | The host file root                                                                                                                                   |

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
- **App deployments** hold the App's lifecycle lock for the whole build. An
  App delete stops a running deployment before it waits, so it doesn't wait
  for the build it's removing.

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
anything, and records how it went before releasing its locks. The journal
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
