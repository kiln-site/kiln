# Relay browser sessions

Live consoles, usage meters, and file transfers move a lot of data, so the
browser connects straight to the Relay for them and Hearth stays out of the
data path. Hearth still decides who may do what. It signs a short-lived
**capability** for one resource, the actions allowed on it, and a key the
browser holds. The Relay checks the capability and the browser's proof of that
key, then enforces it until it expires. For connections that stay open, Hearth
renews it. Who holds which permission is in
[Access control](access-control.md). Transfer routes and their limits are in
[Relay transfers](relay-transfers.md).

Hearth: `server/relay-capability-service.ts`, `lib/relay-browser-credentials.ts`,
`lib/authenticated-relay-socket.ts`, `lib/authorization-{revision,delivery}.ts`.
Relay: `browser-capability.ts`, `browser-session-registry.ts`,
`browser-socket.ts`, `transfers/browser-files.ts`. Wire shapes:
`packages/contracts/src/relay-protocol.ts`.

## Direct or through Hearth

Each issued capability comes with the Relay's `browserOrigin` and `proxyMode`.
Browsers can't reach a Relay in `hearth` proxy mode, so its traffic goes
through Hearth:

- **Console output** streams from `/api/console/<id>` as NDJSON. Hearth opens
  the Relay socket itself, over the control endpoint or the Relay's tunnel,
  with its own key and renewals. The CLI follows consoles the same way, under
  the session `cli:<credentialId>`. Commands and completions go through
  Hearth's RPCs.
- **Usage** is polled from Hearth every 2 seconds.
- **File requests** go to `/api/relays/<relayId>/browser/files/<root>`. Hearth
  passes them unchanged to the Relay, which checks them as if they came
  direct.

Console and usage also fall back to Hearth when a direct connection fails. An
authorization or protocol failure doesn't switch transports.

## Capabilities

A capability is a base64url JSON payload, signed with the Ed25519 key Hearth
paired with the Relay under. It is at most 16,384 characters.

| Field                                   | Meaning                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `issuer`, `audience`                    | The paired client whose public key verifies the signature, and the Relay's identity fingerprint.                    |
| `subject`, `loginSessionId`             | The Hearth user and their login session.                                                                            |
| `instanceId`, `resourceKind`            | The resource. If `resourceKind` is absent, it's a game server; otherwise `database`, `app`, `relay`, or `platform`. |
| `operation`, `path`                     | `console`, `resources`, or `file`. A path is required for `file` and not allowed for the others.                    |
| `actions`                               | The exact actions allowed. Each must fit the kind and operation and be granted to the issuer's pairing.             |
| `origin`                                | Hearth's public origin. It must match the request's `Origin` and be one the pairing allows.                         |
| `keyThumbprint`                         | SHA-256 of the browser's P-256 public key.                                                                          |
| `authorizationRevision`                 | The subject's revision when Hearth authorized the capability (see [Revocation](#revocation)).                       |
| `issuerGeneration`                      | The pairing's generation.                                                                                           |
| `capabilityId`, `issuedAt`, `expiresAt` | A random ID and the capability's lifetime.                                                                          |

A capability that grants a write (`instance.console.write`, any
`*.files.upload`, or `database.dump.import`) lasts at most 30 seconds. Any
other capability lasts at most 60. The Relay refuses a capability that runs
longer than its maximum, is issued more than 5 seconds ahead of its clock, or
has expired. There is no grace period after `expiresAt`.

Hearth checks the user, their login session or CLI credential, and the
permission behind each action, then checks again after the slow steps. It
signs only with a revision that held through a full check, and gives up after
three attempts.

Each tab creates one non-extractable P-256 key per Relay and resource. The
console and usage sockets for that resource share it, and the tab drops it
once neither socket needs it. Capability requests made in the same microtask
go to Hearth as one batch. File transfers use one key per page and a fresh
capability for every request.

### Proof and renewal

When a socket opens, the Relay sends a session ID, a 32-byte nonce, and a
challenge that expires in 10 seconds. The browser signs the subprotocol, Relay
ID, session ID, nonce, challenge expiry, and capability ID. It sends that
signature with the capability and its public key. The Relay checks the key
against `keyThumbprint`, verifies the proof, checks the issuer generation and
revision floors, and admits the socket.

A file request signs the capability ID and expiry, the method, root, and
path, a 32-byte nonce, and `requestedAt`. `requestedAt` must be within 30
seconds of the Relay's clock. The Relay accepts each capability-and-nonce pair
once and keeps it in SQLite until the capability expires. If that table
reaches `KILN_RELAY_BROWSER_FILE_REPLAYS_MAX` entries, the Relay refuses new
requests rather than evicting old ones.

Admission also returns a renewal nonce. A socket's authority lasts as long as
its capability. The browser renews 10 seconds before a write capability
expires and 20 seconds before a read capability does. It gets a fresh
capability from Hearth, signs the renewal nonce under the same session ID, and
sends `auth.renew` on the open socket. The new capability must have the same
issuer, subject, login session, origin, key, resource, and operation, and it
must pass the generation and floor checks again. The Relay then replaces the
socket's actions, revision, and expiry, and replies `auth.renewed` with the
next nonce. Each socket runs one renewal at a time.

If Hearth refuses a renewal, the browser closes the socket. If Hearth can't be
reached, it retries (400 ms backing off to 5 seconds) until the capability
expires. A renewal sent but never acknowledged may have spent its nonce, so
the browser closes with 4012 and reconnects. File capabilities don't renew;
expiry stops new requests but not a transfer already admitted.

## Revocation

Every change Hearth makes to someone's access increments their
**authorization revision**. The same MySQL transaction records that revision
as the desired floor for each affected Relay and scope:

| Scope           | Raised by                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `instance`      | Grant or ownership changes on one game server, or its deletion. Sent to that game server's Relay.                                  |
| `subject_relay` | Changes on an App or database, sent to its Relay. Account status, verification, profile, or deletion, sent to every enabled Relay. |
| `login_session` | A revoked login session or CLI credential. Sent to every enabled Relay.                                                            |

After the commit, Hearth sends `browser.authorization.revise` in batches of up
to 256 items, in its `relay:<id>#authorization` lane, so a revocation never
waits behind work on a game server. The Relay stores the highest floor it has
seen for each issuer, subject, and scope in SQLite. It closes sockets whose
revision falls below a floor, aborts matching file transfers, and reports what
it stored. Hearth marks only those floors as acknowledged. It resends anything
pending at startup and on each control reconnect, and retries a failed send
after 1 to 3 seconds. Better Auth session and user deletions record a floor
before they delete and again after. A capability is checked only against
floors for its own subject, login session, and game server, so a change on one
game server doesn't affect sessions on another.

The **issuer generation** applies to a whole pairing. Hearth increments it when
a Relay is re-paired, disabled, or deleted. It also increments it when a Relay
reports a lower generation than Hearth last acknowledged, which means the
Relay's state was rolled back. The Relay refuses capabilities from any other
generation. Hearth mints v2 capabilities only in a process with a live control
connection to that Relay, after its generation is in sync. If a pairing's
client is updated or revoked on the Relay, every session and transfer from
that issuer ends.

When an `access.changed` event reaches the browser on Hearth's realtime
stream, every open socket renews immediately. Pages pick up new grants and lose
revoked ones without a reload. A socket closed because access was lost
reconnects only after the next access change.

If Hearth and the Relay can't reach each other, no revocation gets through,
but no renewal does either. Open sockets keep their authority for at most 30
seconds (write) or 60 seconds (read), and file requests stop being admitted
when their capabilities expire.

## Surfaces

| Surface                                     | Channel                      | Actions                                                  |
| ------------------------------------------- | ---------------------------- | -------------------------------------------------------- |
| Game server console, commands, completion   | Console socket               | `instance.console.read`, `instance.console.write`        |
| App, database, Relay, and Kiln service logs | Console socket               | `app.logs.read`, `database.logs.read`, `relay.logs.read` |
| Game server, App, and database usage        | Resource socket              | `instance.read`, `app.read`, `database.read`             |
| Files, App data, host files, database dumps | HTTP `/v1/browser/files/...` | `*.files.download`, `*.files.upload`, `database.dump.*`  |

A socket with the same owner as an open one replaces it (1012), so a tab has
one console and one resource socket per resource; tabs have separate keys.
Console input waits in the game server's lifecycle lane with power changes
([Relay operations](relay-operations.md)). Kiln service logs are for platform
administrators only. Backup links, terminals, and SFTP don't use capabilities.

## Limits

| Variable                                            | Default | Bounds                                                   |
| --------------------------------------------------- | ------: | -------------------------------------------------------- |
| `KILN_RELAY_BROWSER_SESSIONS_MAX`                   |     512 | Authenticated sockets on the Relay                       |
| `KILN_RELAY_BROWSER_SESSIONS_PER_INSTANCE_MAX`      |     256 | Per issuer and resource                                  |
| `KILN_RELAY_BROWSER_SESSIONS_PER_USER_MAX`          |      64 | Per issuer and subject                                   |
| `KILN_RELAY_BROWSER_SESSIONS_PER_USER_INSTANCE_MAX` |      16 | Per issuer, subject, and resource                        |
| `KILN_RELAY_BROWSER_SUBLIMITS_ENFORCE`              |  `true` | Whether the three limits above apply                     |
| `KILN_RELAY_BROWSER_PENDING_HANDSHAKES_MAX`         |      64 | Sockets not yet authenticated                            |
| `KILN_RELAY_BROWSER_PENDING_HANDSHAKES_PER_IP_MAX`  |      16 | The same, per peer address; enforced only in `none` mode |
| `KILN_RELAY_BROWSER_OUTBOX_MESSAGES_MAX`            |     256 | Messages queued to one socket                            |
| `KILN_RELAY_BROWSER_OUTBOX_BYTES_MAX`               |   2 MiB | Bytes queued to one socket                               |
| `KILN_RELAY_BROWSER_PENDING_FILE_AUTH_MAX`          |      16 | File requests authenticating at once; 429 beyond         |
| `KILN_RELAY_BROWSER_FILE_REPLAYS_MAX`               |  65,536 | Stored file-request nonces                               |

An admission that would exceed a limit is refused with 1013. Established
sessions are never evicted to make room. Sockets that haven't authenticated
yet have a separate pool and 10 seconds to authenticate. Behind a proxy, the
Relay sees only the proxy's address and doesn't trust `X-Forwarded-For`, so it
doesn't enforce the per-IP limit there. The bundled Traefik limits
`/v1/browser` upgrades by client address instead: 2 per second, bursting to
the per-IP limit, with IPv6 addresses grouped by /64.

The Relay pings every 15 seconds and drops a socket that misses the next
ping. A console allows 8 pending commands or completions. Auth and operation
replies jump the queue, usage keeps only its newest sample, and console
history uses at most half the outbox. An overflowing outbox closes the socket
(1013) instead of dropping output; the page reconnects from a fresh snapshot.
The browser caps a console at 512 messages and 4 MiB, usage at 64 messages,
and requests at 32 pending with an 8-second timeout, closing with 4013 when it
falls behind.

## One Hearth process

Relay connections, delivery workers, and realtime fan-out live in one
Hearth process's memory, and v2 issuance needs that process's control
connection, so Kiln supports one Hearth process. Floors and pending
deliveries are durable on both sides and survive a restart.

## Version 1 capabilities

Version 1 capabilities are still accepted. They have no login session,
revision, or generation, Hearth issues them for 60 seconds whatever the action,
the Relay doesn't cap their lifetime, and they don't renew; only expiry or
issuer revocation ends one. Hearth issues v2 whenever the caller asks (every
current caller does) and the Relay reports `browser-capability-v2` plus
`browser-lease-renewal-v1` (sockets) or `file-request-replay-v1` (files).
`KILN_BROWSER_CAPABILITY_{CONSOLE,RESOURCES,FILE}_MIN_VERSION=2` stops Hearth
issuing v1. Don't build on v1; remove it when you touch it.

## Invariants

- The Relay trusts only what Hearth signed. It takes the issuer from the
  pairing whose key verified the signature, and never takes a user, origin,
  resource, path, or action from the browser.
- Each message and outbound frame is checked against the socket's cached
  state: active, actions, and expiry. Signatures and floors are checked only
  at admission and renewal.
- Authority grows only when Hearth mints a new capability. The Relay never
  extends a lease on its own.
- Floor deliveries are resent until the Relay confirms them. Floors only rise,
  so a late or repeated delivery is harmless.
