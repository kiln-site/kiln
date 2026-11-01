# Hearth operations

Every change Hearth makes is an **operation**: one definition that says what
it takes, who may run it, what it changes, and the work itself. One pipeline
runs every operation the same way, so a new feature writes only its own
logic, and conflicts, durability, audit, realtime updates and tracing come
with it. The code is in `apps/web/src/operations`.

Hearth runs as one process (see
[Relay browser sessions](relay-browser-sessions.md)), so its lanes live
in memory, like each Relay's (see [Relay operations](relay-operations.md)).

## Defining one

```ts
export const addInstanceDomain = operation<CreateInstanceDomainInput>()({
  name: "domain.add",
  // What it's doing, for whoever its locks turn away.
  doing: "Changing this game server's domains",
  // Who may run it, and what the run needs; an Effect.
  authorize: ({ input, user }) => loadWritableInstance(user, input),
  // What it changes, as lane keys.
  locks: ({ input }) => [exclusive(dnsKey(input))],
  run: ({ input, user, context }) => createInstanceDomainEffect(...),
  audit: ({ input }) => ({ kind: "instance", id: input.instanceId, relayId: input.relayId }),
  publish: ({ input }) => publishDomainChange(input),
})
```

A server function or CLI endpoint runs it for the person it signed in, in
its handler:

```ts
.handler(async ({ data }) =>
  runOperationPromise(addInstanceDomain, data, {
    user: await requireEligibleResourceUser(),
  })
)
```

## The pipeline

Every run goes through the same steps, in one `Operations.<name>` span:

1. **Authorize.** `authorize` checks the actor may run it and loads what the
   run needs (`Operations.authorize` span). Nothing is locked yet.
2. **Take its lanes.** Its locks are admitted to Hearth's lanes, the same
   kernel the Relays run (`@workspace/operations`): each key is a lane,
   shared or exclusive, and work on different keys runs at once.
   - A **person's** operation is refused at once when work on a whole is in
     its way, replacing or removing it, naming what: "Deleting this game
     server is in progress. Try again once it's done." Behind work on a
     part, the same kind of everyday change, such as another power action,
     it waits its turn, up to 30 seconds, then is refused the same way. One
     that conflicts with nothing runs.
   - **Hearth's own** work, a schedule, worker or reconciler, waits its
     turn, and is authorized again once it has, since what it read may have
     changed. One that waits over 30 seconds logs what it waits behind. A
     person's that waited is authorized again too. If what it found then
     needs locks it doesn't hold, as a backup whose preferred destination
     changed, it takes its turn again with them rather than run without.
   - An operation run **inside another** runs under its parent's locks and
     takes none of its own. It may only need what its parent holds: the same
     keys, or parts of a whole its parent holds exclusively. Needing more is
     a bug and fails at once, rather than deadlock: declare those locks on
     the outer operation. Inside means anything the operation's run reaches,
     including promise code through `promiseEffect` and the effects it starts
     with `runAppEffect`. Work it only wakes and doesn't wait for, such as
     Relay authorization delivery, starts with `outsideOperation` and takes
     its own lanes.
3. **Run.** Once it starts it finishes, even if the person leaves; one still
   waiting is withdrawn.
4. **After.** Whatever the outcome, `publish` sends realtime updates. The
   audit event is written off the request's path, best effort: a failed
   audit or publish is logged and never turns a change that went through
   into an error.

Errors keep their type for the caller. A refusal is `OperationBusyError`,
whose message is what the person sees.

### Durable operations

`durableOperation` defines one that survives a restart, with the same
`doing` and `locks`. Its `run` is an Effect workflow: steps (`Activity`)
whose results are stored, waits that outlive a restart (`DurableClock`), and
Relay changes sent at most once (`relayCommand`).

- `startDurableOperation` takes its lanes as any operation does
  (`awaitTurn`): a person waits behind the same kind of change and is
  refused by work on a whole, Hearth's own waits. Its `authorize` is checked
  first, before an idempotency key can hand back an operation, and again
  once it has waited. Then it's recorded (its input, locks and who asked),
  its workflow starts, and it returns its ID.
- Its locks are held until the workflow ends, however long that is, across
  restarts. They're the ones its definition declares. When Hearth starts, it takes back the locks
  of every durable operation still running before it admits anything else
  or resumes their workflows, retrying until MySQL answers. Meanwhile a
  person is told after 15 seconds that Hearth is still starting.
- Most durable operations take no locks. One that only does its own work,
  such as sending an invitation's email or deleting a Tailscale network,
  is kept to one run by its idempotency key, and holding a lock while it
  waits days between retries would only get in the way. Deleting a
  resource holds it whole, so nothing else changes it until the deletion
  ends (see [Restore and deletion safety](backups.md#restore-and-deletion-safety)).
- An idempotency key makes starting it again return the same operation.
- `queueDurableOperation` queues one for Hearth to run when its turn
  comes, for work no one waits on: it's recorded `waiting` and returns its
  ID at once, takes its turn in its lanes as Hearth's own work however long
  that takes, and is taken up again after a restart. Queued with a `key`,
  what's asked while it waits joins it, by its definition's `join`, rather
  than queueing another; it gives up the key as it starts, so what's asked
  then queues one behind it. Asks during the same work make one run after
  it, and the pipeline, not the feature, keeps what was asked. A
  definition's `ready` says whether one can start when its turn comes, as
  when what it needs is there; one that can't gives its turn back, still
  waiting, joinable and holding no lanes, and is tried again within a
  minute. One still waiting can be cancelled (`cancelQueuedOperation`),
  leaving its place in line at once.
- It finishes or fails with a message; there's no paused state.
- Hearth's own work that's only worth doing now, such as a poll that asks
  again every minute, can be `onlyIfFree`: turned away, rather than
  waiting, when anything is in its way, so such work never piles up.

Hearth runs as one process, and a deploy stops the old one before the new
one starts. The Relays order their own work, such as a backup, in their own
lanes; Hearth's lanes order what Hearth does.

### Lane keys

A key names a whole (`instance:<relay>/<id>`) or a part of one, after `#`
(`instance:<relay>/<id>#dns`). Taking a part also takes its whole shared,
so taking the whole exclusively, as deleting it does, waits for or turns
away every part.

An everyday change mustn't turn away another everyday change. Each takes
the least that keeps it safe (`resourceOperation`'s `lock`):

- **The whole, exclusive**, only to replace or remove it: deleting,
  wiping, restoring, importing.
- **A part, exclusive**, for one kind of change applied on the Relay and
  saved in Hearth in turn, which another of its kind mustn't interleave
  with: `#power`, `#config`, `#name`, `#ports`, and a database's
  `#credentials` and `#connections`. Wiping a database replaces it, so it
  holds the whole.
- **The whole, shared**, for everything the Relay or the database already
  keeps in order: file writes, port reservations, an App or game server
  joining a database, a database's data requests and exports.

A database's export, import or data request reads its password once
admitted and holds its `#credentials` shared while it sends it, so a
rotation waits for it. File changes hold what the files belong to
(`fileRootKey`): a game server, the App whose folder they are, or the
Relay's `#host-files`.

Work a change reaches that takes locks of its own is declared on the
change, so it runs inside it: a start, a port change and a startup change
each provision the game server's domains, so each also takes its `#dns`.
Features declare what they change and leave ordering to the lanes; they
don't keep queues, markers or timestamps of their own.

Whole keys that aren't resources follow the same rule: a backup takes
`#name` to rename it and `#task` to cancel it, a GitHub sync `#settings` to
change it and `#files` to write them, a schedule `#settings` to save it,
which running it now takes shared, a GitHub connection `#installation`
for what GitHub reports, a Cloudflare connection `#settings` to save it.
A backup destination's save takes `#settings`, which reserving a backup to
it takes shared, so each waits for the other. An edit to Hearth's own database holds
`hearth` shared; importing into it, or restarting or repairing Kiln's
services, holds it whole. Deleting any of them takes it
whole, as reinstalling a game server does. An account
(`user:<id>`) and a CLI request (`cli-device:<id>`) stay whole on purpose:
sign-ins wait for nothing while an administrator changes the account, and a
request is answered once.

| Key                               | Changes                                                |
| --------------------------------- | ------------------------------------------------------ |
| `instance:<relay>/<id>`           | A game server; `app:`, `database:`, `volume:` likewise |
| `instance:<relay>/<id>#dns`       | Its DNS records and web routes                         |
| `instance:<relay>/<id>#power`     | Starting, stopping or restarting it                    |
| `#config`, `#name`, `#ports`      | Its startup, its name, its ports                       |
| `user:<id>`                       | An account and its access                              |
| `user:<id>#session:<id>`          | One of its browser sessions, signing it out            |
| `user:<id>#cli-credential:<id>`   | One of its linked CLIs, unlinking it                   |
| `cli-device:<id>`                 | A CLI's request to be linked, by its ID, not its code  |
| `email:<hash>`                    | Access for an address, before or without an account    |
| `relay:<id>`                      | A Relay; removing or pairing it takes it whole         |
| `relay:<id>#settings`             | Its name, pausing and connection settings              |
| `relay:<id>#proxy`, `#tailscale`  | Its proxy, its Tailscale                               |
| `relay:<id>#connections`          | Its pairing invitations and connected clients          |
| `relay:<id>#host-files`           | Its host files mount                                   |
| `relay:<id>#process`              | Restarting it or its host, and starting updates on it  |
| `relay:<id>#authorization`        | What a Relay holds of who may do what                  |
| `relay:<id>#database-connections` | Apps' database connections handover                    |
| `cloudflare-connection:<id>`      | A Cloudflare connection                                |
| `hearth`                          | Hearth: its update, backups, services and database     |
| `backup:<id>`                     | A backup: changing it, or restoring from it            |
| `backup-storage:<id>`             | A backup destination; `#settings` saving it            |
| `<resource>#backup-policy`        | What its backups keep, leave out, and where they go    |
| `github-sync:<id>`                | A GitHub sync: changing it, or writing a file for it   |
| `github-connection:<id>`          | A GitHub connection; what reads through it, shared     |
| `schedule:<id>`                   | A schedule: deleting it; `#settings` saving or running |

A backup or restore holds what its data belongs to: the game server or
database, or the App for its folder and the volumes it owns, since deleting
the App takes them with it.

An App's changes take its parts too: `#config` for its configuration and
limits, `#name`, `#power`, and `#deploy` for starting a deployment. Its image
update settings hold it shared.

An image check is a read: it asks the registry with no lane held and
records what it found holding the App shared, so it conflicts with nothing
but replacing or removing the whole App. What it found counts only while it still describes
the App, judged where it's used (`currentImageUpdate`): it asked about the
image the App names now, and no deployment has started since. Checks keep
no state of their own; when each App was last asked is what it recorded.

An App deploys the same way whatever asked: each ask queues the App's
deployment (`app.deploy`) under the App, or joins the one waiting there, and
the deployment holds the App's `#deploy` until its Relay says the build
ended. See [App deployments](app-deployments.md#how-deployments-queue).

A GitHub sync's run holds the sync's `#files`, and its `#settings`, target
and connection shared. See [GitHub sync](github-sync.md#when-a-sync-runs).

## Tracing and metrics

- **Spans.** `Operations.<name>` wraps a run, with `operation.id`,
  `operation.name`, `operation.initiator` (`person`, `system`),
  `operation.parent_id`, `operation.locks`, `operation.wait_ms`,
  `operation.outcome` and, when refused, `operation.blocked_by`. A run
  turned away before it starts, by `authorize` or by Hearth still starting,
  gets its outcome and metrics too, though it writes no audit event. Its
  children are `Operations.authorize` and the work's own spans. A durable
  run is `Operations.<name>` with `operation.durable`, linked to the
  `Operations.start` span of the request that started it; Effect's workflow
  engine adds a span per step.
- **Logs.** Every log line inside a run carries `operation.id` and
  `operation.name`.
- **Metrics.** `hearth.operation.duration` (by `operation.name` and
  `operation.outcome`) and `hearth.operation.wait.duration` (by
  `operation.name`) histograms, and `hearth.operation.refused` by
  `operation.name`. Durable operations add `hearth.operations.duration` and
  `hearth.operations.finished` by `operation.kind`.

## What operators see

The Operations page shows what runs now and what each waiting operation
waits on, live from the lanes, and the latest 50 durable operations that
ended. Ended ones are kept for 30 days.

## Adding an operation

1. Define it with `operation<Input>()({ ... })`, and run it from the
   server function's handler with `runOperationPromise`. Keep `run` to the
   feature's own logic.
2. Name every key it changes: a part (`#dns`) for a change to one part of a
   resource, the whole for a change to all of it. Declare on the outer
   operation every lock the work it reaches needs.
3. Make it durable only when it has steps that must survive a restart.
   Write each step so it's safe to run again.
4. Run Kiln's promise code from an operation through `promiseEffect`, so
   what it starts stays inside the operation. Pass it the person the
   operation runs for: it mustn't read the request's session itself.
5. Every mutating server function runs an operation.
   `server/auth-coverage.test.ts` checks each `POST` server function reaches
   `runOperationPromise`, `startDurableOperation` or `queueDurableOperation`.
   A read is `GET`, unless its input is too large or too secret for a URL
   (`readsOverPost`); sessions, keystrokes and capability signing change
   nothing an operation orders (`notOperations`). Each exception gives its
   reason. Those not moved yet are listed there too, and that list only
   shrinks.

For a step several features share that must not interleave with itself,
such as a DNS update, `inLanes(name, doing, locks, effect)` runs it as an
operation of whatever runs it.
