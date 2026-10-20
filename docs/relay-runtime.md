# Relay runtime

This document describes how the Relay runs on a host: how it talks to Docker,
how Docker checks its health, and how to read its memory use. The Relay runs on
every node, so its idle cost is paid once per host.

## Snapshot loop

The Relay keeps one snapshot sampler running at all times, even without a
Hearth connection, so crash recovery never depends on Hearth. Each sample lists
Kiln's containers, inspects them, and samples resources for running servers.
The next sample starts 2 seconds after the previous one finishes, so a slow
Docker daemon spaces samples out instead of stacking requests. Listing and
inspecting share one 30 second budget per sample.

On-demand samples skip the 2 second gap. A request for a snapshot reuses one
taken in the last 2 seconds, or else joins the sample in progress or starts
one. After a change, such as creating or renaming a game server, the Relay
waits for any sample in progress, then samples again.

Disk usage for each server directory is measured separately, at most once a
minute.

## Docker access

The Relay talks to the Docker Engine API over the mounted socket
(`/var/run/docker.sock`), through one client, `apps/relay/src/docker-engine.ts`.
Everything but app Compose projects and Dockerfile builds uses it: the snapshot
loop, power actions, console logs and streams, container terminals, readiness
probes, resource stats, crash recovery, image pulls, container, network, and
volume creation, databases, Tailscale stacks, Traefik and Coolify discovery,
the update check, self-updates, and the host's operating system for the
node's details. That lookup runs in the background with a short timeout, so a
slow daemon never holds up a snapshot. Console input and tab completion attach to
the container over the same socket directly, because they hold the attach
connection open themselves.

Power actions for game servers the Relay discovers but doesn't own, such as a
Compose service labeled for Kiln, act on that container through the API and
leave its restart policy alone.

An idle Relay starts no processes. Every 10 seconds it checks each Tailscale
stack's forwarding rules, but runs `iptables` only after the stack's container
changes, inside that container through an API exec.

Hearth's update check runs only while the Updates dialog is open, refetching on
focus or reconnect once its result is 30 seconds old. Each check asks every
Relay the user can update to inspect its own container and, for platform
administrators, Hearth's, both by hostname. A Relay that can't inspect a
hostname directly, such as a remote Relay asked for Hearth's, lists its running
containers and inspects each to find it.

The client keeps the Docker CLI's observable behavior where callers rely on it:

- Daemon errors carry the HTTP status and the CLI's
  `Error response from daemon: <message>` text.
- Force-removing a missing container succeeds. Starting a running container or
  stopping a stopped one succeeds.
- A non-zero exec exit code fails the call.
- An error Docker reports inside a log, exec, or pull stream fails the call.
- One-shot reads, such as exec output and readiness logs, stop as soon as they
  pass their size limit. Line-by-line reads, such as console history, followed
  console streams, and an app's last log lines, have no total limit, but each
  line is cut off past 1,048,576 characters. Console history and deployment
  logs keep their newest 5,000 lines within 16 Mi characters.
- Execs that read stdin, for database import and export, database backups, the
  SQL browser, platform dump and restore, and password rotation, stream over a
  connection Docker upgrades, as `docker exec -i` did.
- Pulls send credentials for the image's registry only, from the Docker
  config file (see [Private registries](#private-registries)).
- Containers, networks, and volumes are created from Relay's own description
  of them. The request carries only what Relay sets, and Docker fills in its
  defaults. Labels are a format other Kiln versions read.

Self-updates use the API end to end: the Relay pulls and verifies the image and
launches the update helper, which replaces the container and rolls it back as
[Versioning and updates](versioning-and-updates.md#container-replacement)
describes.

API paths are unversioned, so the daemon answers in its own API version.

### Compose and buildx

The Relay runs only two Docker executables, both for app deployments:

| Executable       | Used for                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-compose` | Compose apps, with the arguments `docker compose` had. Docker has no API for Compose.                                                     |
| `docker-buildx`  | Dockerfile apps, as `docker build` ran it: BuildKit, `.dockerignore`, and `--progress plain` logs. Compose uses it for `build:` services. |

Dockerfile builds run buildx from its path in the image on Docker's own
builder (`BUILDX_BUILDER=default`), so the image always lands in Docker.

The Relay image ships no `docker` CLI, so builds and Compose deploys no longer
start it as a wrapper around the plugin. (Compose still starts buildx for
`build:` services.) It ships Compose v5.5.1 at
`/usr/local/bin/docker-compose` and buildx v0.37.2 at
`/usr/local/libexec/docker/cli-plugins/docker-buildx`, both pinned by checksum
for amd64 and arm64. `scripts/relay-docker-cli.test.mjs` fails if Relay code
starts `docker` or the image definitions install the CLI.

### Adding Docker calls

Use the Engine API client for anything the daemon does: inspecting and
listing, creating, starting, and stopping containers, execs, logs, pulls,
networks, and volumes. The `docker` CLI only turns its arguments into these
requests, so calling the API directly skips a process per call and gives
callers the daemon's own status and error.

Run a standalone Docker binary only for work the client does itself, where
the API would mean rebuilding Docker's tooling. Compose and BuildKit builds are
those cases today: Compose has no API, and buildx handles the build context,
`.dockerignore`, and BuildKit's session. Never start the `docker` CLI for
either; it only wraps the binaries.

### Private registries

Registry logins live in one file, the Relay's Docker config:
`$DOCKER_CONFIG/config.json`, or `/root/.docker/config.json` in the Relay
image. It is the format `docker login` writes, and pulls, Compose, and buildx
all read it, so one login covers images, Compose services, and `FROM` lines.
Only `auths` entries with the credentials inline are used. Credential helpers
(`credsStore`, `credHelpers`) are programs the image doesn't ship.

Hearth doesn't manage registry logins yet. Running `docker login` on the host
doesn't reach the Relay: Docker keeps logins on the client, not in the daemon,
and the Relay's container has its own filesystem. On many hosts, such as
Docker Desktop, the login sits in the system keychain instead of the file. To
pull private images today, mount a config file with inline `auths` into the
Relay container and point `DOCKER_CONFIG` at its directory.

## Health check

The Relay image's Docker `HEALTHCHECK` runs `kiln-relay-healthcheck`, a small
static Go binary built from `apps/relay/healthcheck`. It requests
`GET /health` from a plain-HTTP listener that the Relay binds only to
`127.0.0.1:KILN_RELAY_HEALTH_PORT` (default `4101`) and succeeds only on
`204 No Content`.

- The health listener serves only `/health`, is never published, and starts
  after the main listener, so `healthy` still means the Relay is serving.
- `/health` also stays available without authentication on `KILN_RELAY_PORT`
  for external monitors.
- The check runs every 10 seconds, and every second during startup, so the
  self-updater sees a replacement become healthy quickly. The faster startup
  interval needs Docker Engine 25 or newer; older engines check every
  10 seconds.
- The Relay refuses to start if `KILN_RELAY_HEALTH_PORT` matches
  `KILN_RELAY_PORT` or `KILN_RELAY_SFTP_PORT`. Relays that share a host network
  namespace need different health ports; otherwise the second Relay stops at
  startup and names the variable to change.
- Update helpers run from the Relay image with no health check, because they
  serve no health endpoint.

The development stack has no native checker. Its Compose health check probes
the same loopback listener with BusyBox `wget`.

## Memory reporting

Each snapshot includes the Relay's own memory, separate from the host totals.
The Relays page shows it in the Memory column on large screens as two lines,
for example `164 MiB process` above `264 MiB container · 29 MiB cache`. The
tooltip shows the full breakdown.

| Reading      | Source                         | Meaning                                                                                                                                      |
| ------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Process      | `process.memoryUsage()`        | The Relay's Node.js process: resident memory (RSS), JavaScript heap, and native buffers.                                                     |
| Container    | cgroup v2 `memory.current`     | Everything charged to the Relay container, including page cache.                                                                             |
| Cache        | `memory.stat` `file`           | Page cache charged to the container, mostly from reading files for backups and downloads. The kernel reclaims it under memory pressure.      |
| Kernel       | `memory.stat` `kernel`         | Kernel memory charged to the container, including the inode and directory caches from scanning server directories. Some kernels report none. |
| Docker stats | Container minus inactive cache | What `docker stats` and tools built on it, such as Beszel, report.                                                                           |

Container memory therefore overstates what the Relay holds. To judge the Relay
itself, look at process memory; to judge pressure on the host, look at
container memory minus cache.

Container readings need cgroup v2 and Docker's default private cgroup
namespace. Outside a container, on cgroup v1, or with `--cgroupns=host`, only
process memory is shown. Relays that predate memory reporting show
`Not reported`.

Hearth reads these values from its live Relay connection, so the column adds no
Relay requests. When OpenTelemetry export is configured, the Relay also reports
`relay.memory.*` gauges once a minute.

## Capacity metrics

Every user of a Relay shares its control connection and its file, transfer,
and terminal limits. With `OTEL_METRICS_EXPORTER=otlp`, Hearth and the Relay
report how full they are, so you can see when one caller crowds out the rest.
Gauges are sampled every ten seconds. Every metric is labelled with
`relay.id`; other labels are small fixed sets, never users, paths, or request
IDs.

| Metric                                                                   | From   | Meaning                                                                                                                                                                               |
| ------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hearth.relay.requests.pending`                                          | Hearth | Requests Hearth has sent the Relay and is waiting on; it sends at most 32.                                                                                                            |
| `hearth.relay.requests.oldest_age`                                       | Hearth | How long the oldest of those has waited.                                                                                                                                              |
| `hearth.relay.changes.unsettled`                                         | Hearth | Changes whose connection dropped before they answered, whose outcome Hearth is still asking for.                                                                                      |
| `hearth.relay.requests.refused`                                          | Hearth | Requests turned away for lack of room, by `reason`: `hearth_limit` (Hearth's 32) or `relay_limit` (the Relay refused).                                                                |
| `hearth.relay.request.duration`                                          | Hearth | Time from sending a request to it settling, by `relay.operation` and `outcome` (`ok`, `error`, `timeout`, `cancelled`, `refused`).                                                    |
| `relay.control.requests.in_flight`, `relay.control.requests.oldest_age`  | Relay  | Control requests the Relay is running, summed across Hearth sessions (each may run 32), and how long the oldest has run.                                                              |
| `relay.control.work.orphaned`, `relay.control.work.oldest_orphaned_age`  | Relay  | Work still running after its request ended, such as a read Hearth cancelled that the Relay can't stop, or a change finishing after its Hearth disconnected. It holds no request slot. |
| `relay.control.requests.refused`                                         | Relay  | Requests the Relay refused, by `reason`: `in_flight_limit` (a session's 32) or `lanes_full` (too many changes waiting in the operation lanes).                                        |
| `relay.control.reverse_requests.pending`                                 | Relay  | Requests the Relay sent Hearth that are waiting for an answer.                                                                                                                        |
| `relay.files.directory_size.scans`, `relay.files.directory_size.pending` | Relay  | Folder-size scans running and folders waiting for one, by `filesystem` (`instances`, `apps`, `host`).                                                                                 |
| `relay.files.cursors`                                                    | Relay  | Open directory listing and search cursors, by `filesystem` and `kind`.                                                                                                                |
| `relay.browser.transfers.active`                                         | Relay  | Direct file transfers between browsers and the Relay.                                                                                                                                 |
| `relay.terminals.sessions`, `relay.terminals.viewers`                    | Relay  | Terminal sessions open and the viewers attached to them.                                                                                                                              |

A frozen Relay can't report, so during an outage Hearth's metrics are the ones
that move. Ten-second samples can miss a spike shorter than that; the refusal
counters and request durations record every request as it happens, though a
request Hearth refuses before sending is only counted, not timed.
