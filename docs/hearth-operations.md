# Hearth operations

Every change Hearth makes is an **operation**: one definition that says what
it takes, who may run it, what it changes, and the work itself. One pipeline
runs every operation the same way, so a new feature writes only its own
logic, and conflicts, durability, audit, realtime updates and tracing come
with it. The code is in `apps/web/src/operations`.

Hearth runs as one process (see
[Relay browser sessions](relay-browser-sessions-plan.md)), so its lanes live
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
   - A **person's** operation is refused at once when another holds a lock
     it needs, or waits ahead for one, naming what: "Deleting this game
     server is in progress. Try again once it's done." Hearth doesn't queue
     people's changes. One that conflicts with nothing runs.
   - **Hearth's own** work, a schedule, worker or reconciler, waits its
     turn, and is authorized again once it has, since what it read may have
     changed. One that waits over 30 seconds logs what it waits behind.
   - An operation run **inside another** runs under its parent's locks and
     takes none of its own. It may only need what its parent holds: the same
     keys, or parts of a whole its parent holds exclusively. Needing more is
     a bug and fails at once, rather than deadlock: declare those locks on
     the outer operation. Inside means anything the operation's run reaches,
     including promise code through `promiseEffect` and the effects it starts
     with `runAppEffect`.
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

- `startDurableOperation` takes its lanes like any operation, refusing a
  person's or waiting for Hearth's own, then records it (its input, locks
  and who asked) and starts its workflow, and returns its ID.
- Its locks are held until the workflow ends, however long that is, across
  restarts. They're the ones its definition declares, also for one
  recorded before it kept them. When Hearth starts, it takes back the locks
  of every durable operation still running before it admits anything else
  or resumes their workflows, retrying until MySQL answers. Meanwhile a
  person is told after 15 seconds that Hearth is still starting.
- Most durable operations take no locks. One that only does its own work,
  such as sending an invitation's email or deleting a Tailscale network,
  is kept to one run by its idempotency key, and holding a lock while it
  waits days between retries would only get in the way. Deleting a
  resource holds it whole, so nothing else changes it until the deletion
  ends.
- An idempotency key makes starting it again return the same operation.
- It finishes or fails with a message; there's no paused state.

Hearth runs as one process, and a deploy stops the old one before the new
one starts. The Relays order their own work, such as a backup, in their own
lanes; Hearth's lanes order what Hearth does.

### Lane keys

A key names a whole (`instance:<relay>/<id>`) or a part of one, after `#`
(`instance:<relay>/<id>#dns`). Taking a part also takes its whole shared,
so taking the whole exclusively, as deleting it does, waits for or turns
away every part.

| Key                               | Changes                                                |
| --------------------------------- | ------------------------------------------------------ |
| `instance:<relay>/<id>`           | A game server; `app:`, `database:`, `volume:` likewise |
| `instance:<relay>/<id>#dns`       | Its DNS records and web routes                         |
| `user:<id>`                       | An account and its access                              |
| `relay:<id>#authorization`        | What a Relay holds of who may do what                  |
| `relay:<id>#database-connections` | Apps' database connections handover                    |
| `cloudflare-connection:<id>`      | A Cloudflare connection                                |

## Tracing and metrics

- **Spans.** `Operations.<name>` wraps a run, with `operation.id`,
  `operation.name`, `operation.initiator` (`person`, `system`),
  `operation.parent_id`, `operation.locks`, `operation.wait_ms`,
  `operation.outcome` and, when refused, `operation.blocked_by`. Its
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
waits on, live from the lanes, and durable operations that ended in the
last 30 days.

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
   `server/auth-coverage.test.ts` checks each reaches `runOperationPromise`
   or `startDurableOperation`. Those not moved yet are listed there, and the
   list only shrinks.

For a step several features share that must not interleave with itself,
such as a DNS update, `inLanes(name, doing, locks, effect)` runs it as an
operation of whatever runs it.
