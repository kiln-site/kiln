# Relay browser sessions plan

## Outcome

Build one reusable, Effect-backed authenticated-socket core for direct Relay
features. It must make permission changes take effect without a page refresh,
keep the current direct-connection latency, bound every queue and authority
window, and stop each feature from implementing authentication and lifecycle
again.

This plan retains Kiln's signed, proof-of-possession capabilities. JWT is only
a token encoding; changing to it would not improve the authorization model.
Our narrower actions, asymmetric issuer signatures, and browser-key binding
are worth keeping.

## Decisions

| Concern | Decision |
| --- | --- |
| Traffic planes | Keep Hearth-Relay control, browser-Relay data, and browser-Hearth SSE separate. |
| Browser ownership | Connections belong to one browser tab, login session, and instance. Different tabs, users, sessions, and instances never share authority. |
| Physical sockets | Move write/completion onto console-read; keep resources separate for backpressure isolation. Files remain request-scoped HTTP. |
| Reuse | Console and resources use one scoped direct-socket helper but retain feature-specific codecs and fallbacks. Do not build a session framework or message bus. |
| Authorization | Treat a capability as a short, renewable Relay-enforced lease, not one-time admission to an unlimited socket. |
| Permission changes | Refresh authorization in place when possible; otherwise reconnect the affected socket automatically. Never require a page refresh. |
| Revocation | Push persisted revision watermarks to Relay for prompt revocation; lease expiry is the hard bound during a partition. |
| High-frequency data | Keep console and resource samples out of TanStack Query/DB and React context state. |
| Scale | Encode once per changed instance, enforce hierarchical limits, and keep authorization delivery durable without adding shared infrastructure to single-node installs. |

This is today's traffic isolation minus the unnecessary third command socket,
not a new lane framework. Console bursts, history, and slow-consumer recovery
must not delay or disconnect resource samples. A console page therefore uses
at most two sockets; other instance pages use only the resource socket. Merge
console and resources later only if production measurements show a net benefit
after accounting for TCP head-of-line blocking.

```text
browser tab / instance
  resource socket  -------> Relay ResourceHub(instance)
  console socket   -------> Relay ConsoleHub(instance)
    read + write + complete

browser tab         -------> Hearth SSE (domain invalidation only)
Hearth gateway      -------> Relay control socket (RPC + revocation)
file request        -------> Relay HTTP (path/method-bound proof)
```

## Non-negotiable invariants

- Relay derives issuer identity from its paired control connection and never
  trusts a browser-stated user, origin, instance, path, or action.
- Admission fully verifies issuer and issuer generation, audience, origin,
  proof, scope, actions, revision, and expiry. Inbound dispatch and sensitive
  outbound sends then use only the socket's cached active/action/revision/expiry
  state; they never do signature, database, or policy work per frame.
- Access loss closes only matching subjects/sessions/scopes when push delivery
  works and always takes effect by lease expiry.
- Permission elevation, reduction, logout, and session revocation work in open
  tabs without navigation.
- No queue, pending-request map, replay table, or connection pool can grow
  without a configured bound.
- Console ordering is preserved. Resource samples may coalesce to the newest
  value. A gap never becomes silent stale state: reconnect produces an
  authoritative reset/history.
- One slow user, tab, or instance cannot grow memory without bound or cause an
  unrelated socket to close.
- Direct and Hearth-proxied transports produce the same logical events for UI
  state, although their wire protocols may differ.

## Building blocks

### Browser

Extract `openAuthenticatedRelaySocket` from the existing console path. It is
the only shared building block and it:

- opens the direct socket speculatively while Hearth authenticates and issues
  the capability;
- performs challenge, proof, serialized authentication/renewal, retry,
  heartbeat, and cleanup in one lifecycle;
- exposes a typed inbound stream and a bounded request/reply facility;
- uses cached browser routing metadata and skips the failed direct attempt when
  the Relay is already known to require Hearth proxying;
- keeps the last authoritative UI snapshot visible during renewal or transient
  reconnects.

The console client uses it for subscribe/write/complete. The resource client
uses it for subscribe only. Their current NDJSON and polling fallbacks stay in
the feature clients; they are transport adapters, not WebSocket lanes. A small
route-owned credential coordinator shares one non-extractable P-256 key and one
batched issuance request when both sockets are active. It owns no event
demultiplexing or React state. Cross-tab sharing through a `SharedWorker` is not
part of the first version.

Components consume one route-level controller through narrow external-store
selectors; components do not open sockets or independently consume streams.

### Effect boundary

Use Effect where it removes lifecycle and concurrency code:

- `Scope` and `acquireRelease` for sockets, listeners, timers, hub leases, and
  interruption-safe cleanup;
- one scoped fiber tree per socket for handshake, reading, renewal, and bounded
  request/reply work;
- `Deferred` for readiness and challenge coordination, bounded `Queue`/`Stream`
  for delivery, and a capped jittered `Schedule` for transient reconnects;
- `Ref` for the serialized socket state machine.

Keep the credential registry, codecs, byte counters, React stores, query
adapters, Relay's encoded-frame `Map`/`Set` fanout, and existing server service
boundaries as ordinary TypeScript. Keep native `EventSource`. React teardown
closes the one owning Scope; it must not create a second competing lifecycle.
Do not add Layers or put Effect around a hot fanout loop merely for consistency.

## Capability and lease protocol

Introduce capability schema version 2 without changing the current browser
WebSocket subprotocols: resource remains v1 and console remains v2, including
its existing batches and history behavior. Capability, browser wire, and
control versions are independent. Retain the current claims and require:

- issuer, Relay audience, subject user ID, Hearth login session ID;
- instance, operation kind (`console`, `resources`, or `file`), optional
  normalized path, exact actions, and browser origin;
- capability ID, authorization revision, issuer generation, issued-at, expiry,
  and version;
- thumbprint of the session's non-extractable browser key.

Capabilities containing a write action have a maximum 30-second lease and
renew around 20 seconds; read-only capabilities have a maximum 60-second lease
and renew around 40 seconds. When the shortest active lease is due, one
jittered Hearth request refreshes every active capability for that tab/instance
from one authorization snapshot; initial issuance never waits for a batching
timer. Relay enforces `0 < expiresAt - issuedAt <= max`, permits `issuedAt` at
most five seconds ahead of its own clock, and applies no grace to `expiresAt`.
An expiry fiber closes the socket at Relay time `expiresAt`.
Inbound dispatch and the existing per-socket send path also perform a cheap
cached time/state check so event-loop delay cannot extend authority.

Relay advertises `browser-capability-v2`, `browser-lease-renewal-v1`, and
`file-request-replay-v1` in a new optional `features` field on the existing
authenticated control `auth.ready` frame. Hearth records features from the
current control connection. Add the field with `Schema.optionalKey` and a
compatibility fixture proving the pre-change Hearth decoder accepts a ready
frame containing it; do not assume excess-key behavior. This adds no
browser-path discovery request.

Issuance is negotiated per operation kind and requires both sides. The browser
issuance request explicitly opts that kind into the lease protocol. Console and
resources receive v2 only when their shipped client can renew and Relay reports
both `browser-capability-v2` and `browser-lease-renewal-v1`. Files receive v2
only when the caller opts in and Relay reports both `browser-capability-v2` and
`file-request-replay-v1`. During the compatibility window, any other combination
receives v1; after a kind's secure minimum is enabled it is rejected rather than
silently downgraded. One advertised feature is never sufficient.

Routine renewal happens on the existing socket. Hearth issues a fresh
capability for the same key after fresh login-session and permission checks;
issuance therefore reads the Better Auth session rather than relying on
`requireAuthenticatedUser` alone. In development bypass only, use a stable
synthetic login-session ID; production capabilities always name a real session.
Relay keeps the browser socket's Relay session ID stable and provides the next
one-time renewal nonce in `auth.ready` and each renewal acknowledgement. The
existing proof transcript binds that fresh nonce, stable Relay socket session
ID, capability, and negotiated subprotocol. Relay requires the same issuer,
subject, Hearth login session, origin, instance, operation kind, and key
thumbprint, and first applies the normal current-generation/floor predicate to
the fresh capability. It rejects actions outside that kind, serializes renewal,
and atomically replaces the action set, revision, expiry, and nonce. A file
capability cannot renew a socket. There is no grace period beyond the previous
expiry.

An access change can race safely with renewal:

1. Hearth commits the policy and its new authorization revision.
2. The browser's Hearth SSE projection updates the UI and asks active sockets to
   renew if their requested actions changed.
3. A durable control operation raises Relay's minimum accepted revision and
   closes matching sockets still below it.
4. A socket that already renewed remains open; a closed socket automatically
   obtains current authority and reconnects. Neither path reloads the page.

Only Hearth can mint the fresh lease. Relay never infers added permissions from
the browser or extends a lease while Hearth is unreachable.

### Durable revocation

Use a small, coalescing desired/acknowledged table, not a generic event bus.
Every Kiln-owned mutation that can change effective access allocates the
subject's next monotonic authorization revision and upserts the affected
Relay/scope's desired revision in the same database transaction. Capability
authorization and the subject revision are read from one consistent snapshot;
if the revision changes during other issuance work, authorize again before
signing.

A Better Auth-owned session deletion cannot share that transaction. Its
delete-before hook first durably raises the session floor on every affected
Relay, then allows deletion to proceed; delivery remains asynchronous. A failed
delete may briefly fail closed and a subsequent renewal can recover. Any
provider/internal deletion path that cannot run the hook is still bounded by
the lease because renewal always rechecks session existence. Do not claim
cross-library transaction atomicity.

After commit, a dispatcher sends a bounded batch of
`browser.authorization.revise { subject, scope, minimumRevision }` items as a
Hearth-to-Relay control operation. It coalesces rows and shares the existing
32-request in-flight bound; the user-facing mutation never waits for Relay.
Relay derives issuer from that authenticated connection, persists
`max(current, received)` in SQLite, atomically publishes that floor to its
active registry, marks stale sockets inactive, and aborts matching transfers
before returning the persisted maximum; physical close frames may follow.
Hearth advances `acknowledgedRevision` only to
`max(oldAck, min(returned, currentDesired))`; a newer desired value therefore
remains pending. Pending rows are resent on process start and control reconnect;
after a timeout, Relay error, or saturated control request budget, one scoped
dispatcher fiber retries the still-pending coalesced rows with capped jittered
backoff while the connection remains up. Post-commit notification wakes it
immediately; this is delivery retry, not periodic database polling. Duplicate,
coalesced, and out-of-order delivery is harmless.

The scope tuple is one of `instance(instanceId)`, `subjectRelay`, or
`loginSession(loginSessionId)`. Relay compares a capability revision only with
the floors applicable to that capability's issuer, subject, login session, and
instance, and independently requires its issuer generation to equal the
current persisted generation:

```text
accept when
  capability.issuerGeneration == currentIssuerGeneration
  and capability.revision >= max(
    subjectRelayFloor,
    instanceFloor(capability.instanceId),
    loginSessionFloor(capability.loginSessionId)
  )
```

This same admission predicate applies to WebSocket authentication, renewal,
and HTTP file requests. A generation/floor update marks matching active work
inactive, so the hot path needs only its cached active bit afterward.

The subject revision can therefore be globally monotonic while the floors stay
targeted: a change for instance B does not close instance A. A fresh capability
issued after the mutation carries at least the new revision and survives the
matching control operation.

Fan-out is explicit. A grant, ownership, invitation, instance, or Relay-scoped
change targets that instance's Relay. A login-session revocation targets every
enabled paired Relay because a platform administrator may have no grant rows.
A ban, user deletion, platform-role/admin change, or all-session revocation also
targets every enabled paired Relay, including disconnected ones; these rare
mutations trade O(Relays) durable rows for correct revocation. A new Relay has
no pre-existing browser work. Relay/instance deletion targets the associated
Relay. Relay disable and issuer key rotation/revocation first increment a
durable issuer generation and enqueue an issuer-scoped operation; Relay
persists the generation, marks every socket/transfer for that issuer inactive,
then acknowledges. New capabilities must carry the current generation. If the
control connection is already unavailable, v2 leases remain the hard bound.

During a Hearth-Relay partition, prompt revocation is impossible. The fixed
30-second write and 60-second read bounds apply to WebSocket continuing
authority and future HTTP admission. An HTTP transfer already admitted follows
the operation boundary below: it ends on pushed abort or completion.

Legacy v1 remains admission-only during the short rolling compatibility window,
but Relay enforces its signed expiry for every version. It therefore has the
same hard partition-time lifetime bound while lacking v2's pushed revocation and
in-place renewal. Track v1 use, finish the client rollout, and enable each kind's
secure minimum before claiming prompt revocation for that kind.

### Files

Files stay HTTP because ranges, uploads, downloads, and streaming do not fit a
WebSocket. Capability v2 uses operation kind `file` and remains path-, method-,
and proof-bound. Persist each accepted `capabilityId + nonce` in a bounded
SQLite WAL table through expiry so
restart cannot replay the same signed request; reserve it atomically before I/O
and garbage-collect by expiry with a hard row cap. A full table fails closed
rather than evicting an unexpired entry. Each retry or range request must mint a
fresh request proof. Do not make the capability itself single-use
until HEAD, browser retry, range resume, and hidden-form semantics require and
define it. Capability expiry prevents request admission; it does not interrupt
a large transfer already admitted. A pushed subject/session/issuer revocation
aborts an active download, and Relay rechecks cached revocation state before a
temporary upload is committed. The bytes delivered before revocation cannot be
recalled, which is the explicit HTTP operation boundary.

HTTP expiry is an admission TTL, not renewal: GET/HEAD and other read-only file
requests use at most 60 seconds; `instance.files.upload` and every mutating
method/action use at most 30 seconds. The admitted transfer boundary above is
unchanged.

## Performance and data work

- Capability issuance accepts the active socket set. One indexed permission and
  revision snapshot can issue the required capabilities; independent
  authentication, Relay lookup, signing-key access, key generation, and socket
  connection work runs concurrently. Bound and jitter renewal work so reconnect
  storms cannot create an issuance storm.
- Cache decrypted issuer signing material by the immutable Relay/client/key
  material tuple and invalidate it when that tuple changes. Never cache an
  authorization decision or browser capability.
- Renewal reuses known route metadata and does not repeat proxy discovery.
- Keep the existing shared snapshot sampler. ResourceHub groups subscribers by
  instance, retains the latest sample, encodes once per subscribed instance, and
  sends that cached sample/history to every new subscriber immediately. Do not
  introduce per-instance samplers until profiling proves the global sampler is
  the bottleneck.
- Resource delivery is latest-only under pressure. Console queues are bounded
  by messages and bytes; overflow closes and recovers from authoritative
  history rather than losing lines silently. Auth and operation replies have
  bounded priority queues and deadlines.
- High-frequency samples update `resourceHistoryStore`; console batches retain
  their current publication behavior. Query state changes only when durable or
  displayed server fields actually differ, preserves references for no-ops,
  and never triggers an unrelated full-fleet refetch.
- Retry only transient network/server/slow-consumer failures, with capped
  exponential jitter. Authorization, origin, revision, and malformed-protocol
  failures wait for changed access/session input. Readiness means authenticated
  plus first authoritative event, not merely an open TCP socket.
- Keep direct access primary. Console NDJSON and resource polling remain
  feature-specific Hearth fallbacks; do not add a Hearth hop or a new proxy
  WebSocket to the healthy path. After command moves onto the direct console
  socket, its fallback remains the existing Hearth command RPC.

Extend the existing console timing with low-cardinality active/pending counts by
channel, capability/renewal query rate and latency, connect/auth/first-event
latency, fallback reason, reconnect recovery, queue messages/bytes, resource
coalescing, close category, and limit rejection. IDs never become metric labels.

## Limits

All counters apply to physical sockets and are enforced before expensive work.
Identity keys are scoped by paired issuer so IDs from different Hearths cannot
collide. Reject the newest admission with WebSocket 1013; do not evict an
established unrelated session.

| Environment variable | Initial default | Scope |
| --- | ---: | --- |
| `KILN_RELAY_BROWSER_SESSIONS_MAX` | 512 | Relay total |
| `KILN_RELAY_BROWSER_SESSIONS_PER_INSTANCE_MAX` | 256 | issuer + instance |
| `KILN_RELAY_BROWSER_SESSIONS_PER_USER_MAX` | 64 | issuer + subject |
| `KILN_RELAY_BROWSER_SESSIONS_PER_USER_INSTANCE_MAX` | 16 | issuer + subject + instance |
| `KILN_RELAY_BROWSER_PENDING_HANDSHAKES_MAX` | 64 | unauthenticated Relay total |
| `KILN_RELAY_BROWSER_PENDING_HANDSHAKES_PER_IP_MAX` | 16 | unauthenticated source IP |
| `KILN_RELAY_BROWSER_PENDING_FILE_AUTH_MAX` | 16 | concurrent HTTP body/proof authentication |

Pending handshakes use their own pool so an unauthenticated flood cannot consume
established capacity. After authentication, one registry critical section first
finds an exact old match on issuer, subject, Hearth login session, proof-key
thumbprint, instance, and operation kind. It transfers/replaces that established
permit and closes the old socket before testing or incrementing hierarchical
caps. If no exact match exists, normal caps apply. The new socket uses only the
pending pool until this admission step; separate tabs have separate keys. This
preserves handover without quota overlap or cross-tab eviction.

The per-IP pending limit is enforced only when the peer address is authoritative.
In `none` mode this is the direct TCP peer. Bundled Traefik and Coolify require an
explicit trusted-proxy CIDR before Relay may use forwarded addresses; Relay must
never trust `X-Forwarded-For` merely because a proxy mode is selected. Until that
policy is configured, proxy-mode per-IP accounting is observable but not an
enforcement boundary. The total pending pool remains enforced in every mode.
Bundled Traefik additionally rate-limits the exact browser WebSocket upgrade
route by its authoritative TCP peer address (including IPv6 /64 grouping);
Coolify and other external edges must configure the equivalent source-aware
upgrade policy.

Validate positive bounded integers and the hierarchy at startup, expose current
usage/rejections, use a 15-second ping/pong heartbeat, and release every permit
through the socket Scope. Reject-newest is the deliberate DoS posture; these are
ceilings, not reserved capacity. Identity/instance sublimits are enforced by
default and may be overridden for emergency operations. Keep current
direct-transfer defaults (32 global, 8 per paired issuer), with a separate
bounded pre-authentication pool, until a per-subject byte and concurrency design
is measured. Runtime configuration can later replace the environment variables
without changing limiter interfaces.

## Scale boundary

The first release keeps the supported single-Hearth-process connection Map and
uses the existing control connection for authorization delivery. The small
desired/acknowledged table and Relay watermarks are durable because crash-safe
revocation matters even on one node; Redis, a generic bus, and RPC rewrites are
out of scope. Metrics use transport/channel/result categories, never user,
Relay, session, or instance IDs as labels.

Do not enable a second Hearth worker until a separate design provides fenced
single-owner Relay gateways and shared Hearth invalidation delivery. That future
design may introduce shared infrastructure, but this session plan neither
requires nor preselects it.

## Delivery order

1. **Measure and bound.** Record current connect-to-first-console/resource,
   command, completion, reconnect, query, render, memory, and socket baselines.
   Add heartbeat, bounded queues, observe-only hierarchical accounting, and the
   existing global limit's validated environment configuration.
2. **Deploy Relay support first.** Relay accepts capability v1 and v2 on the
   existing resource-v1/console-v2 subprotocols, serializes authentication,
   enforces v2 lifetimes, persists revision floors/request nonces, adds the
   bounded revise control operation, and advertises support in control
   `auth.ready`. Old Hearth/browser behavior is unchanged.
3. **Remove the third socket.** Extract the shared authenticated-socket helper
   from console and route read/write/completion through the console connection,
   retaining proxy fallback and current batching/history behavior.
4. **Opt console and files into v2.** Only when the caller opts in and the
   current Relay advertises every required feature, Hearth issues capability v2
   for console or files. Add batched issuance, continuing console renewal,
   SSE-triggered refresh, targeted desired/ack authorization delivery, and
   automatic reconnect. Resource issuance remains v1 in this step.
5. **Move resources onto the helper, then opt them in.** Add renewal,
   speculative setup, cached routing, immediate latest snapshot, latest-only
   pressure handling, and grouped encode-once fanout without changing the
   sampler cadence. Enable resource v2 only after this client ships.
6. **Enforce and retire.** After adoption and limit telemetry are healthy,
   enforce hierarchical limits, set a minimum secure capability version, and
   remove capability v1/old socket implementations on an explicit release date.

These steps are ordered for rolling compatibility, not independently
deployable in arbitrary order. There is no silent downgrade after the minimum
secure version is enabled.

## Recorded direct-mode baseline

The pre-change T3 Preview run used the development `none` proxy setting, which
still gives the common production topology: browser HTTPS/WSS goes directly to
Relay through the deployment edge rather than through Hearth. On one warm local
run, console read took 12.8 ms to open, 6.5 ms more to authenticate, and 39.9 ms
to its first authoritative event. Resources took 13.5 ms to open, 1.6 ms more
to authenticate, and 0.7 ms to the first sample. A first command required a
third socket and took 123.6 ms from click to result, including roughly 14.8 ms
of capability/setup work. Route transition overlapped two resource sockets for
about 1.06 seconds. These are diagnostic local baselines, not production SLOs;
repeatable median and p95 runs remain the release gate.

## Release gates

- Deterministic Effect tests cover cancellation during handshake/read/renewal,
  exactly-once cleanup and permit release, retry schedules, expiry, and bounded
  queue behavior.
- Protocol tests cover double-auth races, cross-socket proof replay, malformed
  and overlong claims, unknown/downgraded versions, action widening/reduction,
  stale revisions, Relay restart, issuer revocation, old-decoder acceptance of
  optional feature/renewal fields, and per-kind v2 negotiation.
- Integration tests cover two users, multiple tabs and login sessions, multiple
  instances on one Relay, every audited access mutation, grant/revoke/logout
  while connected, desired/ack duplication/loss/reordering, control partitions,
  and revocation during file transfer. A change for user A never disrupts user
  B; an instance-scoped change does not disrupt another instance.
- Load tests prove bounded memory for unauthenticated floods, slow console
  consumers, resource bursts, pending commands, replay entries, and file
  transfers. Fanout work is linear in subscribers for the changed instance,
  not all instances multiplied by all subscribers.
- Browser validation proves cached content remains visible, permission changes
  require no navigation, commands never wait for on-click capability/socket
  setup, and unrelated components do not render.
- Across repeatable preview runs, statistically meaningful median and p95
  route-to-first-event, command, and completion timings may not regress more
  than 5% from the recorded baseline. The secure protocol adds no serial network
  round trip to the healthy initial path; renewal completes in the background.

## Deliberately deferred

- Changing the capability encoding to JWT.
- Sharing a socket across tabs or multiplexing multiple instances.
- Merging console and resource sockets without production evidence.
- Making a file capability single-use without defined retry/range semantics.
- Adaptive/idle resource sampling before preserving and measuring the current
  six-minute history and two-second active cadence.
- Horizontal Hearth workers, shared infrastructure, and control-RPC redesign.
