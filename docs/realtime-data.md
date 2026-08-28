# Realtime data boundaries

Kiln uses TanStack DB as Hearth's reactive browser data layer. It does not
replace MySQL, Relay state, or high-frequency Relay streams.

## Authority

- Hearth owns durable collaborative intent, access, user preferences, and
  cross-Relay history.
- Relay owns machine identity, host-local execution, files, containers,
  resource observations, and the state required to continue safely while
  Hearth is unavailable.
- The browser owns unsaved interaction state, including dirty editor buffers.
- Each field has one authority. Copies identify their source revision or
  observation time and are treated as projections.

| Domain                                                             | Authority | Browser delivery                                           |
| ------------------------------------------------------------------ | --------- | ---------------------------------------------------------- |
| Users, memberships, roles, and access grants                       | Hearth    | `access` query-scope invalidation                          |
| Relay registration, display name, and enabled state                | Hearth    | Policy refresh, `relays` invalidation, and fleet recovery  |
| Relay reachability and observed host facts                         | Hearth    | Exact `relay-health` invalidation                          |
| Relay proxy configuration                                          | Relay     | Exact Relay-scoped `relay-proxy` invalidation              |
| User appearance preferences and platform appearance defaults       | Hearth    | User or authenticated `preferences` invalidation           |
| Domain integration and instance vanity assignments                 | Hearth    | `domains` query-scope invalidation                         |
| Schedules and their desired revisions                              | Hearth    | `schedules` collection invalidation                        |
| Managed database records and encrypted credentials                 | Hearth    | Relay-scoped database invalidations                        |
| Database containers and observed database state                    | Relay     | Projected through the `databases` query                    |
| Backup catalog, policies, and storage destinations                 | Hearth    | Separate catalog, policy, and storage invalidations        |
| Backup execution and progress                                      | Relay     | Active-task polling after immediate catalog invalidation   |
| Tailscale network definitions and integration credentials          | Hearth    | `tailscale` query-scope invalidation                       |
| Tailscale deployments and observed node state                      | Relay     | Projected through the `tailscale` query                    |
| Relay audit history                                                | Relay     | `activity` invalidation after audited control mutations    |
| Pinned and recently viewed file records                            | Hearth    | Relay-reader `file-activity` invalidation                  |
| Server definitions, names, startup, ports, routes, and power state | Relay     | Instance deltas plus exact route-query invalidation        |
| Relay health, host facts, and resource observations                | Relay     | Incremental Relay snapshot deltas                          |
| Containers, processes, console output, and host-local execution    | Relay     | Purpose-built Relay streams and commands                   |
| Files, directory entries, file metadata, and file contents         | Relay     | Outside this rollout; never copied into Hearth collections |
| Unsaved forms and open file editor buffers                         | Browser   | Local state until explicitly persisted                     |

Relay registration and schedules use TanStack DB collections. Access,
preferences, domains, databases, backups, Tailscale, activity, and file
activity retain their existing Query shapes and use the same topic-scoped
transport. This avoids duplicating nested, secret-bearing, historical, or
parameterized data in browser memory merely to call it a collection. A Relay
may retain an applied projection of Hearth intent so it can continue operating
offline, but it does not become the authority for that intent.

## Browser collections

- Collections are defined by business domain, never by screen or filter.
- Small control-plane collections may load eagerly. Large histories and
  catalogs load only the subsets requested by active views.
- TanStack Query remains the fetch and SSR hydration layer. Query Collections
  materialize its normalized rows and use existing server functions to persist
  mutations.
- Authorized Hearth events mark only the affected exact collection or domain
  query prefix stale and refetch active observers. Database credential events
  carry a database ID; backup policy and Relay-local settings events carry a
  Relay ID. Tailscale control-plane changes are global but restricted to
  platform-admin streams. Reconnects, overflow, and invalid payloads do the
  same for every Hearth domain. Relay deltas recover from an authoritative
  snapshot before replaying newer buffered deltas. Failed recovery retries
  with bounded backoff instead of leaving a connected tab stale.
- Console output, resource samples, file contents, editor buffers, and secrets
  never enter general-purpose collections.

## Transport

- Each Relay control connection starts with one validated full snapshot and
  subsequently sends only changed instance rows, deleted IDs, and changed node
  observations. Unchanged 2-second samples do not produce a frame.
- Each authenticated browser tab opens one same-origin SSE stream to Hearth.
  Hearth projects Relay and mutation events through a cached per-user access
  policy before any payload is serialized.
- Every Hearth process has a unique stream epoch, so a reconnect after restart
  or worker failover cannot confuse new sequence numbers with an older stream.
- Session revocations close matching streams immediately. Access revocations
  clear browser projections before rebuilding policy, and periodic session
  validation covers revocations handled by another process.
- The per-client queue is bounded. A slow client receives a coalesced reset
  instead of allowing memory or stale deltas to grow without limit.
- A 15-second named ping, accompanied by an SSE comment, keeps intermediaries
  and the browser watchdog active without creating application-level renders.
  Forty-five seconds without a delivered frame replaces the EventSource; the
  new stream's guaranteed initial reset performs one authoritative fleet and
  Hearth recovery.
- Successful audited Relay mutations publish one `activity` invalidation at
  the shared RPC boundary. Read operations never do, which keeps feature code
  simpler without adding background Activity polling.
- Mutation fan-out is currently process-local. Kiln's supported Compose image
  runs one Hearth application process; horizontally replicated Hearth workers
  require a shared pubsub transport before they are supported. Periodic session
  validation protects cross-process revocation, but it is not mutation fan-out.

## Performance and lifecycle

- One `QueryClient` and one dependent `DbClient` exist per SSR request or
  browser router session. They are never module-global.
- Components subscribe to the smallest live query that can render their view.
- Invalidation refetches only mounted queries. A database change does not load
  backups, Tailscale, or Activity in a browser that is not displaying them.
- Every backup reservation path, including CLI and final-delete backups, pushes
  the catalog change immediately. Its existing 1.5-second poll runs only while
  a visible task is queued, running, or deleting, then stops.
- Relay identity changes intentionally refresh Relay-derived labels across
  mounted domains, refresh stream policy, and recover the fleet snapshot.
  Health checks refresh only the Relay list; proxy writes use an exact Relay
  query. Neither refetches unrelated domains or the fleet.
- Identity policy events remain ordered through server backpressure. If the
  byte buffer coalesces one into recovery, the reset retains both its Hearth
  refresh and fleet recovery requirements.
- The server list projects only fields it displays, so resource-only Relay
  samples do not trigger collection writes, rebuilds, or row repaints.
- Relay snapshot delta v1 compares control fields without resources. A rare
  control change still carries one complete v1 row, including its current
  resource sample, so old and new Relays reconstruct the same snapshot without
  a protocol break.
- Schedule views retain a visible-only 15-second reconciliation poll because
  Relay-originated executions and acknowledged next-run times are imported into
  Hearth by that read path. User mutations still invalidate every active tab
  immediately.
- Schedule target options retain referenced targets that have disappeared from
  the live directory. Authorized users can still run, edit, or delete the
  schedule; execution is best-effort and records missing targets as failed so
  successful live targets produce a partial run. Saving requires removing or
  replacing unavailable targets. Instance membership deltas invalidate only
  this target-options query.
- Provisioning fallback reads only the owning Relay and upserts only the active
  instance; it does not poll or replace the full authorized fleet.
- Relay connection transitions rewrite only that Relay's reachability fields
  in the existing rows and publish only when crossing the authenticated
  boundary. A reconnect's subsequent reset recovers authoritative Relay
  membership and the fleet snapshot in one server request, so queue coalescing
  cannot split the toast and fleet state or retain a removed Relay. That reset
  remains the recovery boundary for deltas missed while offline. Each
  unavailable Relay falls back independently to its last snapshot and is
  marked unreachable, so one outage cannot block membership recovery for the
  rest of the fleet. Recovery cancels older in-flight fleet queries before
  committing, preventing a slower pre-reset response from restoring stale
  membership or rows.
- Collection IDs include business scope. Filters, ordering, and pagination do
  not create additional collection instances.
- Sign-in and sign-out use full-document navigation. The old JavaScript realm
  is discarded before the next router creates its per-session Query and DB
  clients, so one user's collections cannot materialize for another user.
- TanStack DB and the router integration remain pinned while their APIs are
  pre-1.0; upgrades are deliberate and validated as part of this boundary.
- Realtime payloads contain safe client DTOs only; encrypted credentials,
  hashes, tokens, and host paths are excluded at the source.

## Desired and observed state

Hearth-to-Relay resources follow the schedule deployment model: Hearth stores
the desired revision, Relay persists the applied projection, and Relay reports
the acknowledged revision and observed result. Immediate actions such as a
restart remain commands whose execution and recovery state belong to Relay.
