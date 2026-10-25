# Relay transfers

A Relay streams files directly to and from whoever asked for them, so
Hearth stays out of the data path. Every direct transfer runs through the
same code in `apps/relay/src/transfers/`, whichever route it came in on.

| Route                            | Used for                                                                                      | Authorized by                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `/v1/browser/files/<root>`       | The Files tab's uploads and downloads, App files, host files, and database dump import/export | A capability Hearth signs for one path and action, and a proof from the browser key it names |
| `/v1/browser/backups/<backupId>` | Backup archive download links                                                                 | A link Hearth signs for one backup, valid until it expires                                   |

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
together. Relays that predate this ignore the parameter.

- Uploads go over XHR for its progress events and abort when the effect is
  interrupted. Folder uploads send three files at a time and keep each
  file's failure.
- Downloads are handed to the browser's own download manager with a form
  post, which carries the credentials since it can't set headers.
- The page signs its requests with one non-extractable key pair; each
  capability still names one path and method.
- Failures are `RelayTransferError`s whose `reason` says whether the Relay
  was unreachable, refused, cancelled, or answered with something invalid.
  An unreachable Relay still takes a small text file through Hearth.

## Limits

| Pool      | At once | Per principal |
| --------- | ------- | ------------- |
| `browser` | 32      | 8             |
| `backup`  | 4       | 4             |

A browser request also has 30 seconds to authenticate, with at most
`KILN_RELAY_BROWSER_PENDING_FILE_AUTHENTICATIONS` authenticating at once.

## Telemetry

| Metric                           | Meaning                                                                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `relay.transfer.requests`        | Transfer requests, by `kiln.transfer.route` and `kiln.transfer.outcome` (`completed`, `aborted`, `rejected`, `failed`). |
| `relay.transfer.bytes`           | Bytes moved, by route and `kiln.transfer.direction` (`sent`, `received`).                                               |
| `relay.transfer.duration`        | Time from request to end, by route.                                                                                     |
| `relay.browser.transfers.active` | Browser transfers running, sampled with the Relay's other [capacity metrics](relay-runtime.md#capacity-metrics).        |
