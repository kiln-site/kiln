# Hearth operation lanes (plan)

Status: proposal. Nothing here is built yet. Estimates hold only once
phase 0 has measured the pieces they depend on.

## Summary

Every feature that changes things across Kiln has had to solve the same
problems on its own: remember what it was doing across a restart, retry
what failed, keep two changes to the same thing from interleaving, and
recover when a Relay or Cloudflare may or may not have applied a change.
Server moves, Relay joins, Tailscale cleanup, backup copies, final
deletion, post-provision jobs, and DNS each built their own version, and
each got some edge cases wrong in its own way.

The Relays already solved half of this: [operation lanes](relay-operations.md)
order every change a Relay makes by the resources it locks. Hearth needs
the same lanes, plus the half the Relay lanes don't cover: remembering
work across restarts.

**Recommendation: one lane model, two homes, plus Effect Workflow.**

1. Move the Relay's lane scheduler into a shared package,
   `packages/operations`, used by both the Relay and Hearth: one model for
   locks, shared and exclusive modes, arrival order, and taking every lock
   at once.
2. In Hearth, keep the lanes in MySQL, so accepted operations, their places
   in line, and the locks they hold survive a restart.
3. Run each operation's steps with Effect's durable Workflow
   (`effect/workflow`), storing its progress in Hearth's MySQL. A finished
   step isn't run again after a restart, waits and timers survive one, and
   Kiln doesn't build its own workflow engine.
4. Link Hearth's operations to the Relays' through the control protocol
   that exists: command IDs chosen by Hearth, the Relay's outcome journal
   (`operation.get`), and trace context. Later, Relay reservations let a
   long Hearth operation keep browser uploads, SFTP, and schedules off what
   it's changing.
5. Keep desired-state reconcilers (DNS, Tailscale) as their own pattern,
   run through the same lanes.

Lanes decide **what may run together**. Workflows remember **what must
happen next**. Neither replaces the other, and neither replaces a database
rule like DNS's one owner per hostname.

The goal is one operation contract, not one mechanism for everything: every
change states how it runs and how it recovers, in one of four modes, chosen
by what a crash mid-way would leave behind, not by how long it takes:

| Mode           | When                                                                                                                                        | A crash mid-way                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Plain**      | One MySQL transaction, nothing outside Kiln (favorites, preferences, read marks)                                                            | Rolls back; no operation is stored                                        |
| **Quick**      | In the request, under lane locks; only MySQL, or outside work a reconciler or the next attempt converges                                    | Its locks are freed once its Hearth's heartbeat stops; nothing resumes it |
| **Reconciler** | Desired state kept in MySQL; each attempt takes its locks, re-reads the latest intent, applies the difference, and lets go (DNS, Tailscale) | The next attempt converges; nothing is replayed                           |
| **Durable**    | Several steps whose results later steps need, or waits that must survive a restart (moves, final deletion, restores)                        | The workflow resumes, re-running only the cut-off step                    |

## Words used here

- **Operation**: one change someone or something asked for, like "move
  this server" or "rename this app", from the moment it's accepted until
  it's done.
- **Lock** and **lane**: an operation names the things it touches (a game
  server, a hostname) and whether it needs them alone (exclusive) or can
  share them (shared). Operations wanting the same thing wait their turn, in
  order: that line is a lane.
- **Admission**: accepting an operation and giving it its place in line.
- **Step**: one piece of an operation that does something, like "ask the
  new Relay to make the server".
- **Replay**: after a restart, an operation runs again from the top, but
  finished steps return their stored result instead of running again.
- **Outcome**: what actually happened to a command sent to a Relay or an
  outside service, which a lost reply leaves unknown until someone asks.
- **Reservation**: a lock held on a Relay on behalf of a Hearth operation,
  so the Relay's own actors (uploads, SFTP, schedules) wait too.
- **Reconciler**: a loop that makes outside state (DNS records, Tailscale)
  match what Kiln wants, instead of replaying each change.
- **Claim**: a stored rule that something belongs to one owner, like a
  hostname to one game server. It outlives any lock.

## What it guarantees, and when

The guarantees arrive in phases; until a feature has moved, it behaves as
it does today.

- **After phase 1**: operations that moved survive a Hearth restart, wait
  for each other in Hearth by what they touch, and never run a finished
  step twice.
- **After phase 4**: a long operation can hold a Relay reservation, so the
  Relay's own actors wait for it. Before then, a browser upload, SFTP
  write, or schedule can still slip in between two of its steps, as today.
- **Never covered**, by design: someone with the Relay host's shell or a
  terminal into a server; changes made directly in Cloudflare or
  Tailscale; importing an old Kiln database (see
  [Kiln's own database](#kilns-own-database)).

## Why not just reuse the Relay lanes as they are

The Relay lanes are an in-memory class
([`operation-lanes.ts`](../apps/relay/src/operation-lanes.ts)). They order
work running now, on one node. Hearth's work needs more:

| Hearth needs                                | Relay lanes today                                                                            |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| To survive a restart                        | Waiting work is dropped when its caller goes; the journal keeps outcomes, not the work       |
| To span MySQL, Relays, and outside services | One node, one process                                                                        |
| To know whether a lost call applied         | The journal answers for one change command (`operation.get`); something must remember to ask |
| To run for hours (a move)                   | An operation holds its locks only while it runs                                              |
| To fan out to many Relays                   | Not its concern                                                                              |
| Progress a person can see                   | Not its concern                                                                              |
| Cancellation with cleanup                   | Withdraws waiting work; running work finishes                                                |

What transfers directly: lock keys, the whole-shared/part-exclusive key
shape, shared and exclusive modes, conflicting work in admission order,
every lock granted at once, readers never starving a writer, and plans
that must name their keys exhaustively.

## One operation, end to end

Moving a game server from Relay A to Relay B, under this plan:

1. **Accepted.** The person clicks Move. Hearth checks their access,
   stores the operation with an ID, and returns the ID. The page shows its
   progress from then on, whether or not the tab stays open.
2. **Waits its turn.** The move's first phase needs the source server
   shared. A backup of that server holds it exclusively, so the move waits;
   the operator view says it's waiting on that backup.
3. **Runs.** The backup finishes; the move gets its locks. Its first step
   stores a command ID, then asks Relay B to prepare the copy.
4. **Loses a reply.** While Relay B copies the files, Hearth restarts. The
   copy step never stored a result.
5. **Recovers.** On start, Hearth restores the move's place and locks, and
   runs it again from the top. Finished steps return their stored results;
   the copy step asks Relay B about its stored command ID instead of
   copying again. Relay B says it finished.
6. **Hands over.** The move releases its first phase, waits for its
   handover locks (both servers, their hostnames), checks nothing changed
   while it waited, moves the domains, and points DNS at Relay B.
7. **Done.** It releases its locks. The trace shows both runs, linked by
   the operation ID, and stored timings say how long it waited, ran, and
   held each lock.

## The pieces

### `packages/operations`: the shared lane kernel

Extracted from `apps/relay/src/operation-lanes.ts`, with the Relay's
behaviour unchanged:

- lock types and conflict rules;
- grant selection in admission order, every lock at once;
- the behavioural tests, run against both homes.

New, built during the extraction: key normalization (shared and exclusive
on one key become exclusive; today the lanes take the list as given) and
diagnostics that say what holds a key and what each waiter waits on (today
they report counts).

Stays outside it: storage, RPC authorization, the Relay's pause and SFTP
rules, each feature's lock plans, and workflows. `runNested` stays a
Relay-only exception.

### Hearth's lanes

A MySQL-backed lane broker in Hearth:

- **Admission** happens when an operation is stored, after authentication
  and resolving the resources it names. Its place in line is a sequence
  allocated in that transaction, with the operation and a wake-up record,
  so a crash right after can't lose it.
- **Grants and releases** are decided in one short scheduler transaction
  that never covers a Relay call, a Cloudflare request, or a transfer. A
  grant and the work it starts are stored together.
- **Drivers carry a generation.** Only the current driver of an operation
  can mark it done and release its locks, so a stale one, from before a
  restart, can't release another's.
- **One engine.** Only one Hearth process runs the broker and workflows,
  dev reloads included; this is enforced, not assumed.
- **After a restart**, Hearth restores held locks and waiting operations
  before granting anything, then recovers unfinished work. Work on a Relay
  it can't reach waits without holding up unrelated work.
- An in-memory index makes grants fast, and is rebuilt from MySQL on start.

Three facts stay separate, because conflating them caused most of DNS's
race fixes: who **drives** an operation, what it **excludes** (its locks),
and what **actually happened** remotely (the outcome). A Hearth that stopped
doesn't release its locks: work it started may still be running on a Relay.

### Phases inside an operation

A long operation runs in phases, each with its own complete lock plan:

- A phase takes all its locks at once and never adds to them while holding
  them.
- Moving to a phase that needs more, such as a move's handover, means
  releasing and waiting again, at the back of the line. After the new grant
  it re-checks what it depends on before acting.
- A parent never holds locks while waiting for a child that needs them.

Keys name things exactly: a game server by its Relay and ID (a move's
copy is a different server), a hostname lowercased. Hearth keys follow the
Relay's shape: `instance:<relay>/<id>`, `app:<relay>/<id>`,
`database:<relay>/<id>`, `hostname:<name>`, `connection:<id>`,
`network:<id>`, `backup:<id>`, `relay:<id>/routes`. Hearth names what it
intends; the Relay still derives its own keys.

### Durable steps

Each operation kind is a workflow with schemas for its input and result.
Its steps are activities whose results are stored:

- **A step cut off mid-way runs again**, so every step must be safe to
  repeat. That includes Hearth's own MySQL writes: a write can commit
  before its step's result is stored. Either the write is idempotent, or it
  commits in the same transaction as the step's result.
- **Identity is explicit.** An operation's idempotency key is stored with a
  hash of its input, and a reused key with a different input is refused.
  Workflow names carry a version; old versions stay registered until their
  unfinished work drains. A step that repeats, such as polling, gets a new
  name each time, or it would replay its first answer forever.
- **Waits need someone to end them.** A durable wait keeps its place across
  a restart, but something must still notice that a transfer finished while
  Hearth was down: each kind of wait names how (polling the Relay's job, or
  an event Hearth stores when it arrives).

### Linking with the Relay lanes

What exists:

- `relayRpc(..., knownOperationId)` sends a change under an ID Hearth
  chose.
- The Relay journals **change commands** (not reads or terminal traffic):
  acceptance before it runs, the outcome after. Commands are identified by
  the paired Hearth client and the ID; a reused ID with a different payload
  is refused (`operation_conflict`), and `operation.get` answers for one.
- `traceparent` carries the trace into `relay.control.request` and its
  execution span.

What the step adapter adds: it stores the Relay, the paired client, the
command ID, the payload, and when it was first sent, **before** sending.
After a lost reply it asks instead of guessing:

| Relay says    | Hearth does                                                                             |
| ------------- | --------------------------------------------------------------------------------------- |
| `running`     | Waits; sends nothing new. This includes still waiting for its turn on the Relay         |
| `succeeded`   | The command finished; reads back what it needs, since the reply may be gone             |
| `failed`      | Decides from the error: it may have partly applied, or been withdrawn before it started |
| `interrupted` | Checks what's there now: the change may have applied before its outcome was written     |
| `unknown`     | Resends under the same ID only while the original is young enough to have been kept     |

Limits the adapter respects:

- **Outcomes** are kept a week from when the command **started**, pruned at
  start and every six hours. A recovery after that can't rely on `unknown`
  meaning "never ran".
- **Replies** are kept in memory for up to 20 minutes, at most 500 of them,
  and none over 64 KiB, and a Relay restart loses them all. A step must be
  able to rebuild its result some other way, or stop and ask for help.
- **Re-pairing** a Relay under a new client doesn't turn an old command's
  `unknown` into permission to send it again.
- **A command isn't its job.** For backups, transfers, provisioning, and
  deployments, the command only hands work to a Relay worker. Success means
  the job was queued; the step then follows the job by its ID until it
  finishes.

Each Relay command kind gets a written recovery recipe: how to find its
job, how to rebuild its result, and when to stop and ask for help.

### Relay reservations (phase 4)

Today each Relay call in a long operation takes its own turn, so a browser
upload or a schedule can slip in between a move's steps. A reservation
holds resources on a Relay for one phase of a Hearth operation:

- **Owned**: tied to the paired Hearth, the operation, and the phase.
  Only that operation's commands, and the Relay jobs they start, run under
  it; everything else waits.
- **Across Relays**: taken one Relay at a time, failing fast instead of
  waiting while holding another; a partial set is released before retrying.
  Nothing critical runs until all are held.
- **Durable** on both sides, released only at a safe point, with an
  operator action to release one whose operation can't finish.
- **Explicit about escape hatches**: terminals and the host shell are
  outside it; each actor that respects it is listed.
- **Negotiated**: an older Relay without reservations keeps today's
  behaviour, and operations that need exclusion there are refused, not
  quietly weaker.

### Callbacks from Relays

Some Relay commands call back into Hearth: deleting a game server asks
Hearth to prepare Tailscale DNS on other Relays. A Hearth operation that
holds locks while waiting for that command, whose callback then wants
conflicting locks, would wait forever.

The rule: Hearth does a command's preparation **before** sending it, or
admits the callback as part of the operation that's waiting, never as a
new operation behind it.

### Reconcilers

DNS and Tailscale state lives outside Kiln, so Kiln converges it rather
than replaying each change:

1. Store the desired state.
2. Schedule a reconcile, folding duplicates together.
3. Take the lock plan for one attempt.
4. Re-read the desired state, inspect the outside state, apply the
   difference.
5. Store what was observed; retry what's unfinished later.

A reconciler converges the latest intent, not every intermediate one. DNS
keeps its rules from [Domains](domains.md): one owner per hostname in
MySQL, claims written with their rows, records found by their marker.

## Observability

Built on the existing [telemetry](../packages/telemetry/src/index.ts)
export.

**Spans cover work, not waiting.** Each is a stretch of active scheduling
or execution, named stably, with IDs in attributes:

| Span                 | Covers                                                    |
| -------------------- | --------------------------------------------------------- |
| `Operations.enqueue` | Validating and storing an operation                       |
| `Operations.grant`   | One scheduler decision that granted it                    |
| `Operations.run`     | One run or recovery of it                                 |
| `Operations.step`    | One attempt at one step; step name in an attribute        |
| `relay.control.*`    | The Relay request, its lane wait there, and its execution |

The operation stores the trace context it was enqueued under; each run
starts a new trace linked to it, as Relay joins already do
(`relay-join.server.ts`). An hours-long move is many spans, joined by its
operation ID.

**Waits come from stored timings.** Admission, grant, release, each step's
start and end, and completion are stored, so an operation's whole life can
be reported across restarts: total time, waiting for locks, waiting on
capacity, running, waiting on a Relay or Cloudflare, backing off, and
holding locks.

**Metrics**, with bounded labels (kind, outcome, step, provider; never IDs):
operations admitted, completed, failed, cancelled; retries; recoveries;
uncertain outcomes; queue depth; wait, run, and lock-hold histograms.
Traces and logs export by default; metrics need `OTEL_METRICS_EXPORTER=otlp`
and an endpoint.

**Logs** for each state change, retry decision, and uncertain outcome,
with the operation ID; failures through the existing `error.fingerprint`.

**An operator view**: what's running, waiting, retrying, or needs
attention; each operation's phase and next retry; the keys it holds or
wants; **what it's waiting on**; its Relay command IDs; and its trace.

## Progress, responses, and cancellation

**Quick changes stay quick.** A rename or a setting goes through the lanes
and answers in the same request, as today. Long work (moves, backups,
deployments, joins) answers with an operation ID and reports progress. Each
operation's definition says which it is, and the CLI follows the same
split.

Progress is stored as named phases with real measures (bytes copied,
children finished). Realtime has no operation-progress updates yet: adding
them, with who may see which, is part of phase 1.

Cancellation is stored intent: a waiting operation is withdrawn; a running
one stops at its next safe point; a remote action in flight is awaited and
checked; cleanup keeps the locks it needs; past a documented point, such
as a move's handover, it finishes instead.

## Data and secrets

Stored workflow inputs and step results are new copies of data that today
never touches disk: passwords, tokens, file contents, query results,
imports.

- Secrets are stored as references to Kiln's encrypted credentials, never
  in workflow data.
- Inputs and results have size limits; large data stays where it is and
  the workflow stores its ID.
- Finished operations and their history are cleaned up on a schedule
  matched to the Relays' journal retention.
- Admission is bounded, and each Relay and provider has a concurrency limit.
- Terminal traffic is never replayed.

## Kiln's own database

Importing a Kiln database dump empties and refills its tables. Once
operations live there, importing an older dump would rewind them while
their effects on Relays and Cloudflare stay applied. Importing, restoring,
and restarting Kiln's database get their own maintenance procedure: stop
admitting, let running work reach a safe point, keep the operation tables
out of the import, and reconcile afterwards.

## Rules

- An in-memory lock is not ownership; a stored claim is.
- A replayed step is not an exactly-once effect; steps that change things,
  here or elsewhere, check first or are safe to repeat.
- An uncertain change is never retried under a new ID.
- No SQL transaction is held across a remote call.
- A parent never holds locks while waiting for a child that needs them.
- A lock's expiry never means the remote work stopped.
- Relays don't join Hearth's workflow cluster; they stay nodes behind the
  control protocol.
- No second workflow engine beside Effect's.
- Audit rows, traces, and open fibers are never the record of truth.

## Phases

| Phase | Builds                                                                                                                        | Rough cost |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 0     | Prototype: Workflow on MySQL through process kills, timers, waits, a lost Relay reply; benchmarks of quick changes and growth | 3–5 days   |
| 1     | `packages/operations`, Hearth's MySQL lanes, durable intake, spans and metrics, progress updates, a basic operator view       | 2–3 weeks  |
| 2     | Pilots that touch nothing else: invitation delivery, then Tailscale cleanup                                                   | 1–2 weeks  |
| 3     | DNS: every path that changes DNS goes through the lanes, then its worker and locks are replaced                               | 2–3 weeks  |
| 4     | Relay link: parent IDs in the protocol, reservations, callbacks, capability checks                                            | 2–4 weeks  |
| 5     | Backups, final deletion, post-provision, server moves, Relay joins and removal                                                | 3–5 weeks  |
| 6     | Everything else, the operator page, removing the old workers                                                                  | 1–2 weeks  |

A first real consumer in about 4–6 weeks; broad adoption in about 12–20,
to be revised after phase 0. Each feature moves whole: every path that
changes it goes through the new lanes, its unfinished rows are carried
over or drained, and its old worker is removed. Old and new never drive the
same work.

Post-provision jobs moved from phase 2 to phase 5: they call DNS, so they
can't pilot before DNS has moved.

"Every operation" means every change has an explicit plan: its locks, a
stated "none", or a stated exemption. Reads take no locks, as on the Relay.

## Decisions

The defaults this is built on. Each can change; each is one setting or one
rule in the code.

- **Retention.** Finished operations and their workflow history are kept 30
  days. The Relay keeps a command's outcome a week from when it started, so
  Hearth resends an `unknown` command only within six days of first sending
  it; after that the step stops and asks for help.
- **One engine.** The engine holds its shards' locks, rows in its own
  tables, for as long as it runs; a second Hearth waits for them instead of
  running beside it, and a dev reload closes the old engine first. Not MySQL
  named locks (`GET_LOCK`): those are shared by every database on the
  server, so two installs on one MySQL server would block each other. A
  Hearth that stops releases its locks; after a crash they expire within 45
  seconds, and the next Hearth resumes the work then. Each lock write gets
  15 seconds, so a busy MySQL doesn't cost the engine its shards.
- **Stuck locks.** A platform administrator may release the locks of an
  operation marked as needing attention, from the operator view, with a
  reason that's kept with the operation.
- **Losing access.** An operation a person started checks their access
  again before it starts and before each destructive step; if it's gone,
  the operation stops at that point. Cleanup an operation already began
  finishes regardless.
- **Newer intent.** Reconcilers converge the latest desired state and skip
  what it replaced. Operations otherwise run in admission order. A
  reconciler holds its locks for one attempt only, never through a
  provider's backoff.
- **Who owns work.** A change belongs to the Hearth that admitted it, which
  registers itself as it admits and heartbeats every 10 seconds. Another
  Hearth takes its waiting work once that heartbeat has been silent for 30
  seconds, and its running work after 2 minutes, past any request's own
  timeouts: silence can't prove a change under way has stopped, as one
  whose Hearth lost MySQL mid-request, and nothing short of stopping that
  process fences it. Taken-over work can't start or end anything after.
  A Hearth that stops says so, and the next takes over at once. An
  operation is named before it's admitted and ending it is retried until
  MySQL answers, so a lost reply or a failed write never leaves its locks
  held.
- **Effect upgrades.** Workflow history outlives a release. Before
  upgrading Effect, a drill resumes workflows the previous version left
  mid-step, with history written by it, not only the new version's tests.
- **During a move.** From handover until the move finishes, changes to
  either server wait their turn behind it; before handover, they run as
  usual and the move re-checks after it gets its handover locks.

## Measured in phase 0

On a development machine's MySQL 8, with the engine in Hearth's process
(`apps/web/src/operations/test/bench.ts`):

- A Hearth killed mid-step (`SIGKILL`) has its workflow finished by the
  next one, which re-runs only the step that was cut off
  (`apps/web/src/operations/engine.test.ts`) once the dead process's shard
  locks expire, within 45 seconds.
- A one-step workflow takes 39 ms at the median, 50 ms at p95, 74 ms at
  p99; 200 at once finish in about 1.5 seconds. Fine for long work, too slow
  for every rename: quick changes go through the lanes and answer in the
  same request, without a workflow.
- An idle engine adds under one MySQL query a second.
- A quick operation costs about 17 ms of MySQL work at the median (admit,
  starting in the same transaction when granted at once, and end; 25 ms
  p95). Each decision reads what's held and what waits, so a blocked
  backlog slows ordinary work linearly: with 1,000 operations waiting
  behind one key, 35 ms (44 ms p95); with 5,000, 103 ms
  (`apps/web/src/operations/test/lanes-bench.ts`). Real backlogs are tens.
- Each run leaves about 6.6 KB in eight rows, kept until retention clears
  them with the operation after 30 days, by its execution ID. The engine's
  message table has no index on that, so each hourly pass scans it; at 30
  days of history that stays small.
- A graceful shutdown lets a step in flight finish; Hearth waits five
  seconds for it before leaving it to the next start.

## Appendix: the Effect pieces

All in Effect 4.0.1, and all marked unstable. Kiln keeps them behind one
small service, pins the version, and re-runs its recovery tests before each
upgrade.

- `Workflow.make({ ... })` for each operation kind, with payload, success,
  and error schemas and an idempotency key; `workflow.execute`,
  `workflow.poll`, `workflow.interrupt`, `workflow.resume`.
- `Activity.make({ name, execute, ... })` for steps; completed results are
  stored and replayed.
- `DurableClock.sleep({ name, duration, inMemoryThreshold })`: a sleep of
  60 seconds or less stays in memory by default and starts over after a
  restart, so the threshold is set deliberately.
- `DurableDeferred` for waits ended from outside; its token is an internal
  capability.
- `SingleRunner.layer({ runnerStorage: "sql" })` runs entities and
  workflows in one process with their state in SQL; it needs an
  `SqlClient` and `Crypto`. `ClusterWorkflowEngine.layer` builds the
  `WorkflowEngine` on it. Both storage implementations support MySQL.
- Hearth's `Database` service keeps its SQL client private today; the
  runtime has to share that client with the workflow layers rather than
  open a second pool.
- `ClusterSchema.WithTransaction`, off by default, runs a step in the
  message store's transaction: the way to commit a MySQL-only step's writes
  with its result.

## Migration checklist

Each item moves when its phase comes. Links point at where it lives today.

### Phase 0–1: foundation

- [x] Prototype Workflow + `SingleRunner` on MySQL; kill-and-recover tests; benchmarks
- [x] Extract `packages/operations` from `apps/relay/src/operation-lanes.ts`; Relay unchanged; add normalization and diagnostics
- [x] Share the SQL client between `Database` and the workflow layers
- [x] Hearth lane broker on MySQL: durable intake, grants with dispatch, driver generations, single engine
- [ ] Relay step adapter: stored command identity, `operation.get` recovery, recipes per command kind
- [x] `Operations.*` spans, links, stored timings, metrics
- [x] Operation progress over realtime
- [x] Operator view (admin): running, waiting, waiting-on, needs attention

### Phase 2: pilots

- [x] Invitation delivery ([`access-invitation-delivery.ts`](../apps/web/src/lib/access-invitation-delivery.ts)): `invitation.deliver` per scoped invitation; the minute sweep is gone. Exempt: platform invitations, whose link carries a token Hearth keeps only hashed, are sent once as they're made ([`access.ts`](../apps/web/src/server/access.ts))
- [x] Tailscale cleanup ([`tailscale-cleanup.ts`](../apps/web/src/effect/tailscale-cleanup.ts)): `tailscale.network.delete` per network, each round removing it from every Relay that's due; the polling worker is gone

### Phase 3: DNS ([`domains.ts`](../apps/web/src/server/domains.ts), [`web-hostnames.server.ts`](../apps/web/src/server/web-hostnames.server.ts))

- [x] A DNS admission boundary every caller goes through: route saves, post-provision, deletion, moves, Relay removal ([`dns-operations.ts`](../apps/web/src/lib/dns-operations.ts): each change holds `<resource>/dns` exclusive and the resource shared; a move takes both resources at once)
- [x] DNS worker → reconciler on the lanes ([`dns-worker.server.ts`](../apps/web/src/lib/dns-worker.server.ts)): the worker stays as its schedule, and each attempt is a DNS change on the lanes; `resource-locks.ts` is gone
- [x] `saveDomainConnection`, `deleteDomainConnection` hold `connection:<id>`; `discoverCloudflareDomains` only reads
- [x] `createInstanceDomain`, `updateInstanceDomain`, `removeInstanceDomain`
- [x] `releaseWebHostname`, app address generation
- [x] Web route saves, Relay write included: `updateInstanceWebRoutes` ([`relay.ts`](../apps/web/src/server/relay.ts)), `updateAppWebRoutes` ([`apps.ts`](../apps/web/src/server/apps.ts))
- [x] Sync (`resyncDomainAssignments`), one resource at a time

### Phase 4: the Relay link

- [ ] Parent operation and step IDs in the control protocol
- [ ] Relay reservations, with ownership, inheritance by jobs, and capability negotiation
- [ ] Browser console, uploads, SFTP, schedules, and crash recovery respect reservations
- [ ] Relay callbacks into Hearth: Tailscale detach on deletion ([`tailscale-instance-deletion.ts`](../apps/web/src/server/tailscale-instance-deletion.ts))
- [ ] Authorization reconciliation on connect, and its delivery ([`relay-connection.ts`](../apps/web/src/lib/relay-connection.ts))
- [ ] Relay transfers: `preflightRelayTransfer`, `startRelayTransfer`, `cancelRelayTransfer` ([`relay-transfers.ts`](../apps/web/src/server/relay-transfers.ts))

### Phase 5: long-running and data-loss work

- [ ] Server moves and duplicates: `startServerMigration`, `cancelServerMigration`, resumption ([`server-migrations.server.ts`](../apps/web/src/lib/server-migrations.server.ts))
- [ ] Deleting a game server, with and without a final backup: `deleteInstance` ([`relay.ts`](../apps/web/src/server/relay.ts), [`final-instance-deletion.ts`](../apps/web/src/lib/final-instance-deletion.ts))
- [ ] Post-provision jobs ([`instance-post-provision.ts`](../apps/web/src/lib/instance-post-provision.ts))
- [ ] Backup copies (`scheduleBackupCopyProcessing`), `copyBackupToDestination`
- [ ] Backups: `createInstanceBackup`, `createDatabaseBackup`, `createPlatformBackup`, `cancelBackup`, `deleteBackup`, `restoreInstanceBackup`, `restoreDatabaseBackup`, `syncBackupRuns` ([`backups.ts`](../apps/web/src/server/backups.ts)); backup maintenance
- [ ] Backup downloads: `getBackupDownloadUrl` reserves exports and shares ([`backups.server.ts`](../apps/web/src/server/backups.server.ts))
- [ ] Relay joins: `addRelay`, `openRelayJoin`, `refreshRelayJoin`, `confirmRelayJoin`, `previewRelayPairing` ([`relays.ts`](../apps/web/src/server/relays.ts), [`relay-join.server.ts`](../apps/web/src/server/relay-join.server.ts))
- [ ] Pairing a Relay from the environment, and start-up reconciliation of Relays ([`server.ts`](../apps/web/src/server.ts), [`relay-registry.ts`](../apps/web/src/lib/relay-registry.ts))
- [ ] Relay removal: `removeRelay`

### Phase 6: everything else

Game servers ([`relay.ts`](../apps/web/src/server/relay.ts), [`bricks.ts`](../apps/web/src/server/bricks.ts)):

- [ ] `createBrickInstance`, `updateInstanceStartup`, `configureBrickNetworking`, `saveCustomBrick`
- [ ] `updateInstanceName`, `updateInstancePorts`, `reserveInstancePort`, `releaseInstancePort`
- [ ] `removeInstanceDatabaseConnection`
- [ ] `performRelayAction` (power), `sendRelayConsoleCommand`, `completeRelayConsoleCommand`
- [ ] `saveRelayFile`, `mutateRelayFiles`, `updateRelayFilePin`, `recordRelayFileView`
- [ ] `mutateRelayDatabase`, `runRelayDatabaseQuery`
- [ ] `uploadToMclogs`, `uploadConsoleLogToMclogs`
- [ ] Instance directory sync loop; `setInstanceFavorite`

Apps ([`apps.ts`](../apps/web/src/server/apps.ts), [`app-deployments.ts`](../apps/web/src/server/app-deployments.ts), [`app-image-updates.ts`](../apps/web/src/server/app-image-updates.ts)):

- [ ] `createApp`, `deleteApp`, `renameApp`, `updateAppConfig`, `updateAppLimits`, `updateAppNetwork`
- [ ] `deployApp`, `runAppAction`, `saveAppGitHubSource`, `redeployAppDeployment`; deployment polling
- [ ] `saveAppImageUpdatePolicy`, `checkAppImageUpdate`, `skipAppImageUpdate`, `deployAppImageUpdate`; image update checks

Databases ([`databases.ts`](../apps/web/src/server/databases.ts)):

- [ ] `createManagedDatabase`, `deleteManagedDatabase`, `wipeManagedDatabase`, `renameManagedDatabase`
- [ ] `runManagedDatabaseAction`, `updateManagedDatabaseLimits`, `updateManagedDatabaseNetwork`, `rotateManagedDatabasePassword`
- [ ] `exportManagedDatabase`, `importManagedDatabase`, `mutateManagedDatabase`, `runManagedDatabaseQuery`

Relays and their hosts ([`relays.ts`](../apps/web/src/server/relays.ts), [`relay-host.ts`](../apps/web/src/server/relay-host.ts), [`relay-volumes.ts`](../apps/web/src/server/relay-volumes.ts)):

- [ ] `updateRelay`, `renameRelay`, `setRelayEnabled`, `checkRelay`, `updateRelayProxy`, `updateRelayClient`, `revokeHearthClient`
- [ ] `createRelayInvitation`, `revokeRelayInvitation`
- [ ] `updateRelayTailscale`, `installRelayTailscale`
- [ ] `restartRelay`, `restartRelayHost`, `mountRelayHostFiles`
- [ ] `createRelayVolume`, `renameRelayVolume`, `deleteRelayVolume`

Tailscale ([`tailscale.ts`](../apps/web/src/server/tailscale.ts)):

- [ ] `createTailscaleNetwork`, `configureTailscaleIntegration`, `syncTailscaleIntegration`
- [ ] `saveTailscaleStack`, `removeTailscaleStack`

The CLI ([`api.cli.v1.$.ts`](../apps/web/src/routes/api.cli.v1.$.ts), [`cli-access.ts`](../apps/web/src/effect/cli-access.ts)), whose endpoints call their own effects:

- [ ] Power, console, server creation, deletion, and startup
- [ ] Backup creation, restore, and deletion
- [ ] File writes and URL uploads
- [ ] Device sign-in requests and token delivery

Access and accounts ([`access.ts`](../apps/web/src/server/access.ts), [`resource-access.ts`](../apps/web/src/server/resource-access.ts), [`users.ts`](../apps/web/src/server/users.ts), [`auth.ts`](../apps/web/src/server/auth.ts), [`cli.ts`](../apps/web/src/server/cli.ts), [`sessions.ts`](../apps/web/src/server/sessions.ts), [`browser-accounts.ts`](../apps/web/src/server/browser-accounts.ts)):

- [ ] `grantOrInviteAccess`, `acceptAccessInvitation`, `revokeAccessInvitation`, `removePlatformAccess`
- [ ] `transferResourceOwnership`, `transferAppOwnership`
- [ ] `inviteResourceAccess`, `decideResourceInvitation`, `updateResourceAccess`, `savePermissionPreset`, `deletePermissionPreset`
- [ ] `setUserStatus`, `manuallyVerifyUser`, `issueAccountClaim`, `requestAccountClaim`, `claimAccount`, `prepareAccountSignup`
- [ ] `createInitialAdministrator`, `replacePendingAccountEmail`, the development sign-in bypass
- [ ] `approveCliAuthorization`, `denyCliAuthorization`, `revokeCliCredential`, `revokeActiveSession`
- [ ] Browser accounts: switch, sign out, resume, remember
- [ ] Authorization delivery loop

GitHub ([`github-sync.ts`](../apps/web/src/server/github-sync.ts), [`github-sync.server.ts`](../apps/web/src/server/github-sync.server.ts)):

- [ ] `startGitHubConnection`, `deleteGitHubConnection`, `saveGitHubSync`, `runGitHubSync`, `deleteGitHubSync`; sync polling
- [ ] App manifest and installation callbacks; push and installation webhooks

Platform and settings:

- [ ] Backup storage: `saveBackupStorage`, `deleteBackupStorage`, `setPreferredBackupStorage`, `updateBackupLimits`, `updateBackupExcludes`, `renameBackup`
- [ ] Bricks: `addBrickCatalog`, `deleteBrickCatalog`, `setBrickCatalogCommunity`
- [ ] Schedules: `createSchedule`, `updateSchedule`, `deleteSchedule`, `runScheduleNow`
- [ ] Kiln's services: `runKilnPlatformAction`, `startSystemUpdates`, `checkForKilnReleases`; update notifications
- [ ] Kiln's database: `mutateKilnDatabase`, `importKilnDatabase` (maintenance procedure), `runKilnDatabaseQuery`
- [ ] Icons: `saveCustomIcon`, `removeCustomIcon`, `detectIcon`, `linkIconFile`; icon detection
- [ ] Security scans: `scanSecurityNow`; scheduled scans
- [ ] Notifications: `markNotificationsRead`, `dismissNotification`, `clearNotifications`, `acknowledgeNotificationsSeen`, `saveNotificationPreferences`, `subscribePushNotifications`, `unsubscribePushNotifications`; push delivery; disk limit warnings
- [ ] `updateAppearancePreferences`

### Exempt, with a stated reason

These change something, but stay outside the lanes on purpose. Each gets a
plan entry saying so:

- [ ] Terminals: `write*Terminal`, `claim*Terminal`, `restart*Terminal`, and the terminal stream routes. Interactive, never replayed; the Relay already exempts them from its lanes, and they stay outside reservations
- [ ] Better Auth (`/api/auth/$`): sign-up, sessions, verification, passwords, two-factor, passkeys, and the configured super user at start ([`auth.ts`](../apps/web/src/lib/auth.ts), [`auth-bootstrap.ts`](../apps/web/src/lib/auth-bootstrap.ts))
- [ ] Browser passthrough to Relays (`/api/relays/$relayId/browser/$`): transport only; the Relay's lanes order the writes
- [ ] Capabilities: `issueBrowserCapabilities`, `issueConsoleCapability`, `issueResourceCapability`, `issueFileCapability`, where issuing advances authorization state
- [ ] CLI credential use: last-used timestamps on each request
- [ ] Realtime publishing, terminal output, and SFTP sign-in checks

### Reads: no locks

- `getRelaySnapshot`, `getRelayInstances`, `getFreshRelayInstance`, `getFreshRelayConnectionState`, `getRelayDirectorySizes`, `getRelayDatabaseRows`, `getManagedDatabaseRows`, `getKilnDatabaseRows`, `getInstanceInventory`, `getRelayTransfer`, `getSystemUpdateStatus`, `getTailscaleIntegrationStatus`, `previewTailscaleIntegration`, `previewServerMigration`, `getAccountClaimPreview`, `loadBrickRecipe`, `fetchIconSource`, `readIconSourceFile`, `readPictureSourceFile`, `fetchMinecraftHead`
- Relay metrics collection
