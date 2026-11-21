# Relay transfers

A Relay streams files directly to and from whoever asked for them when they
can reach it; when they can't, Hearth passes the transfer through without
changing what the Relay authorizes (see [Through Hearth](#through-hearth)). Every direct transfer runs through the
same code in `apps/relay/src/transfers/`, whichever route it came in on.

| Route                             | Used for                                                                                      | Authorized by                                                                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `/v1/browser/files/<root>`        | The Files tab's uploads and downloads, App files, host files, and database dump import/export | A capability Hearth signs for one path and action, and a proof from the browser key it names                |
| `/v1/browser/previews/<root>`     | Playing audio and video in the Files tab, seeking with ranges                                 | A `preview` capability Hearth signs for one file, carried in the link; reads only, audio and video only     |
| `/v1/browser/backups/<backupId>`  | Backup archive download links                                                                 | A link Hearth signs for one backup, valid until it expires                                                  |
| `/v1/peer/transfers/<transferId>` | Another Relay pulling files copied to it (below)                                              | A grant Hearth signs for one artifact and one destination Relay, and a proof from that Relay's identity key |

## Adding a route

A route authenticates its request, then hands the transfer to
`serveTransfer` (`transfers/serve.ts`), which gives every route:

- **One span**, `RelayTransfer.serve`, joined to the caller's trace when the
  request carries a W3C `traceparent` in its query string. It records the
  route, file root, operation, bytes moved, and how the transfer ended.
- **Scoped resources.** The transfer's permit, its registration for
  revocation, and any open file are released however it ends: finished,
  refused, failed, or cut off by the client.
- **One way to answer failures.** A `TransferRejected` is an expected
  refusal, answered with its status and reason and not reported as an
  error. Anything else is reported as an error and answered with a 400, or
  cuts the connection if the response has already started.

The pieces it builds on:

| Module                | Purpose                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `transfers/gate.ts`   | How many transfers run at once. Each kind draws from its own pool, with a share per principal (a paired Hearth's browsers, a link's issuer). |
| `transfers/http.ts`   | Refusals, `Range` parsing, download headers, bounded request bodies, and `sendBody`, which streams any body and ends with the bytes it sent. |
| `transfers/bodies.ts` | The bodies a download sends: a file or a range of one, a file compressed on the way out, or a zip of several.                                |

A route that changes a game server, App, or database also takes its lane
locks, as uploads do with `fileRootTransferLocks`
([Relay operations](relay-operations.md)). Reads take none.

## In the browser

`apps/web/src/lib/relay-file-transfer.ts` is the browser's half. Each
transfer is an effect with its own span (`RelayTransfer.upload`,
`RelayTransfer.download`, `RelayTransfer.inspect`,
`RelayTransfer.uploadBatch`), run through `runBrowserEffect` so its spans
export with the page's other browser traces. The request URL carries the
span's `traceparent`, marked sampled only when Hearth keeps that browser
trace, so the browser's and the Relay's halves are kept or dropped
together.

- Uploads go over XHR for its progress events and abort when the effect is
  interrupted. Folder uploads send three files at a time and keep each
  file's failure.
- Downloads are handed to the browser's own download manager with a form
  post, which carries the credentials since it can't set headers.
- The page signs its requests with one non-extractable key pair; each
  capability still names one path and method.
- Failures are `RelayTransferError`s whose `reason` says whether the Relay
  was unreachable, refused, cancelled, or answered with something invalid.
  When Hearth issues the capability with `proxyMode: "hearth"`, requests go
  through Hearth's `/api/relays/<id>/browser/files/<root>` instead. An
  upload that can't reach the Relay either way still saves a UTF-8 text file
  of up to 2 MiB through Hearth.

## Between Relays

Files move from one Relay to another directly, without passing through
Hearth (`apps/relay/src/transfers/peer/`, `apps/web/src/server/relay-transfers.server.ts`):

1. Hearth asks the source Relay to pack the files with
   `transfer.source.prepare`. It writes a gzipped tar under
   `<data>/transfers/outgoing/` in the background, taking the root's
   `transferPackLocks` (shared, as a backup's read), and records its size
   and SHA-256.
2. Once it's ready, Hearth signs a grant with the key it's paired to the
   source under. The grant names the artifact by its digest, the source
   Relay, and the destination Relay by its identity fingerprint, and lasts
   two days.
3. Hearth sends the grant to the destination with `transfer.pull.start`,
   with the addresses it may reach the source at: the listener Hearth
   itself reaches, trusted through the CA Hearth pinned for it, the address
   the Relay advertised, its public browser origin, and last Hearth itself
   (`/api/relays/<source>/peer`), which passes the pull through to the
   source unchanged, through a tunnel when the source dials Hearth. Every
   Relay reaches Hearth, so a copy works even when the destination can't
   reach the source, such as one behind a home router; its bytes then cross
   Hearth, which passes only pulls carrying the grant it signed and keeps
   to its limits on what it carries ([Through Hearth](#through-hearth)). The destination tries each address in turn whatever
   one answers, since an address can reach something other than the source.
4. The destination fetches the artifact into `<data>/transfers/incoming/`
   with Range requests, each signed with its identity key. A dropped
   connection, a busy source, or a restart resumes from what it already
   has; it backs off for about four minutes before giving up. It then
   checks the artifact's SHA-256 against the grant and installs it with
   `transferInstallLocks`, which run alone, into a folder that must be
   missing or empty. Files keep their modes and belong to the root's owner.
5. The destination deletes what it fetched once it's installed. Hearth
   discards the source's artifact once the pull ends, and cancelling a pull,
   failed or not, deletes what it fetched. A pack that's already running
   outlives a discard of its artifact, a database's dump as much as a
   folder's: what it creates after the discard cleaned up is an archive no
   record names, which never expires and can keep that transfer ID from
   packing again. Artifacts nobody discards are
   deleted after a day; finished pulls' records after a week.

`transfer.space` reports a Relay's free disk where it
keeps artifacts and where it keeps game servers' folders, and, asked about
a root, the disk a copy of it takes, archived or unpacked, so Hearth can
check a copy fits first. It walks the root as packing does, counting each
name of a hard-linked file, and rounds each entry up to a filesystem block
plus its archive header. Free disk needs `relay.read`; a folder's size needs
its download action, and a database's what packing it does, `backup.create`.

Copying needs the source root's download action and the destination
root's upload action, for the person on Hearth and for Hearth's pairing on
each Relay; no other Relay action is involved. Game servers, Apps' data,
and host files are copied as their files. Each Relay's records are the
truth about a transfer, so any Hearth process can report one. The process that started a transfer drives it between steps;
if it stops, the transfer stays where it was until it's started again.

A Relay copies a database (`database:<id>`) as its dump, through the same
steps. Packing dumps it, compressed, as a backup of it does, holding what a
backup's read holds; installing runs that dump into the database the pull
names, as restoring a backup into another database does, holding that
database whole. It is copied whole, never by path, and both databases must
be running. A dump of another engine's family is refused before any of it
is imported, and an engine Kiln can't dump (Redis, Valkey) can't be
copied. The Relay dumps and restores it as its administrator, with no
login from whoever asks, so each step takes what a backup's does
(`peerTransferAction`): `backup.create` to pack it on the source,
`backup.download` of whoever signed the grant for the source to serve the
dump, and `backup.restore` to install it on the destination. The
`database.dump.*` actions, which export and import a dump with the
database's own login, don't allow any of it. A Relay that restarts while a dump is being imported fails the
pull, as it does one that was installing files, since the database may
hold part of it. `transfer.space` reports a database's size on disk, which
is more than its dump takes. Hearth asks the person for the same as their
Relays ask of it: `backup.create` and `backup.download` on the database
it's copied from, and `backup.restore` on the one it's copied into.

A Relay copies a Kiln volume as the archive a backup of it is
(`apps/relay/src/backups/tar-archives.ts`), read through Docker with each
file's owner, mode, links and extended attributes. It is named as the
Relay's (`volume:<volume ID>`), or as an App's
(`app:<App ID>:volume:<volume ID>`), which is one only while that App uses
the volume, or it is the one the Relay keeps for a key of the App's
Compose file, deployed yet or not. Packing reads it as it is, beside what
uses it, as a live backup does. Installing stages the archive inside the
volume, checking every entry as a restore does, then swaps it in for what
the volume held; nothing may be running on it, and it holds the volume
alone, and an App's whole when named as one. It is copied whole, never by
path. The Relay archives and fills it as its backups do, so as the Relay's
it takes what a backup's steps do (`backup.create`, `backup.download`,
`backup.restore`), on Hearth too, where a volume's backups are the
Relay's; as an App's it takes the App's file actions, as its other files
do. `transfer.space` reports what Docker last measured of it, waiting for
a measure only when it has none.

The Relay makes the volumes an App's Compose file will keep its keys on
when Hearth asks with `app.volumes.keep`, before the App first deploys, so
a copy of the App can be filled before it runs. They are named as the
App's from then on; the key each is kept for is read back from the name
the Relay made it with and the ID only that App and key give it, and each
volume's users say so (`composeKey`).

`preflightRelayTransfer` lists what would stop a copy and what fixes it:
an offline or outdated Relay, or a pairing that can't move data in or out. A pull that can't reach its source reports why in
its `error` while it waits to try again.

## Through Hearth

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

| Pool      | At once | Per principal        |
| --------- | ------- | -------------------- |
| `browser` | 32      | 8                    |
| `backup`  | 4       | 4                    |
| `peer`    | 8       | 4, per pulling Relay |

A browser request also has 30 seconds to authenticate, with at most
`KILN_RELAY_BROWSER_PENDING_FILE_AUTH_MAX` authenticating at once.

## Telemetry

| Metric                           | Meaning                                                                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `relay.transfer.requests`        | Transfer requests, by `kiln.transfer.route` and `kiln.transfer.outcome` (`completed`, `aborted`, `rejected`, `failed`). |
| `relay.transfer.bytes`           | Bytes moved, by route and `kiln.transfer.direction` (`sent`, `received`).                                               |
| `relay.transfer.duration`        | Time from request to end, by route.                                                                                     |
| `relay.browser.transfers.active` | Browser transfers running, sampled with the Relay's other [capacity metrics](relay-runtime.md#capacity-metrics).        |
