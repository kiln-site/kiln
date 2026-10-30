# Hearth operations

Hearth runs two kinds of work that need more than a request handler: short
changes that must not interleave, and long changes that must survive a
restart. Each has one small tool in `apps/web/src/operations`. The Relay
keeps its own lanes for the resources it runs (see
[Relay operations](relay-operations.md)); Hearth doesn't repeat them.

Hearth runs as one process (see
[Relay browser sessions](relay-browser-sessions-plan.md)), so anything that
only has to hold while Hearth runs lives in memory.

## Short changes: `serialized`

`serialized(kind, keys, effect)` runs `effect` once no other serialized
change holds any of `keys`, waiting its turn. Keys are taken in sorted order,
so two changes can't wait on each other. A caller that gives up while it
waits withdraws it; once it runs, it finishes. Nothing is kept in MySQL: a
restart ends every short change.

Use it for changes that read, decide and write, and would corrupt each other
run side by side:

| Key                            | Used by                                       |
| ------------------------------ | --------------------------------------------- |
| `dns:<kind>:<relay>/<id>`      | Changing a resource's DNS records             |
| `authorization:<relay>`        | Sending a Relay who may do what               |
| `database-connections:<relay>` | Handing Apps' database connections to a Relay |
| `connection:<id>`              | Saving or removing a Cloudflare connection    |

Never start one from inside another holding the same key: it would wait for
itself.

## Long changes: durable operations

A durable operation is an Effect workflow: a list of steps (`Activity`)
whose finished results are stored in MySQL, so after a restart it carries on
from the step it was in, and a finished step doesn't run again. Waits that
outlive a restart use `DurableClock.sleep`.

```ts
export const deliverInvitation = durableOperation({
  kind: "invitation.deliver",
  version: 1,
  input: Schema.Struct({ invitationId: Schema.String }),
  run: ({ invitationId }) => Effect.gen(function* () { ... }),
})

yield* startDurableOperation(deliverInvitation, { invitationId }, {
  actorId,
  idempotencyKey: invitationId,
})
```

- **Recorded first.** `startDurableOperation` writes one `operation` row
  with its input, who asked, and the span that asked, then starts its
  workflow. With an idempotency key, starting it again returns the same
  operation.
- **Ended once.** The workflow's last step records how it ended
  (`succeeded`, `failed`, or `interrupted` when cancelled) and why.
- **Restarts.** Effect's cluster resumes started workflows when Hearth
  starts. One recorded but never started, as when Hearth stopped between the
  two, is started by a sweep every minute.
- **No pausing, no repair flows.** An operation finishes or fails with a
  message for its person. A step that can't know what happened, as when a
  Relay lost track of a change, fails saying so. A feature that needs more,
  such as deletion's retry and keep, keeps that in its own rows.

Today's durable operations are invitation emails, Tailscale network
deletion, and deleting a game server, database, App or volume.

### Relay changes from a step

`relayCommand` sends one change to a Relay at most once. It stores the
change's ID before sending it, and if the step runs again after a restart it
asks the Relay how that ID went (`operation.get`) instead of sending it
again. See [Operation IDs](relay-operations.md#operation-ids).

### Conflicting changes

No two of today's durable operations change the same thing, so none takes a
lock. When one does, as moving a game server would against backing it up,
the rule is:

- A person's change is refused at once with what's running, such as "Can't
  move Alpha: it's being backed up". Hearth doesn't queue people's changes.
- A schedule's step waits for the running one to end.

Build that with the first operation that needs it.

### What operators see

Platform administrators see running operations and those that ended
recently on the Operations page, live. Finished rows and their workflow
history are kept 30 days.

### Tracing

`startDurableOperation` is an `Operations.start` span; each run is an
`Operations.run` span linked to it, with `operation.id` and
`operation.kind`, and Effect's workflow engine adds a span per step. A
serialized change is an `Operations.serialized` span with how long it
waited (`operation.wait_ms`).

## Adding a durable operation

1. Write its steps as `Activity`s that are safe to run again: read what's
   already done before doing it.
2. Register its layer in `operations/workflows.ts`. Keep a removed one
   registered until its unfinished runs have drained.
3. If something must start it again after an upgrade, as a reconciler of its
   own rows does, give it an idempotency key.
