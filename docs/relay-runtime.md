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

What callers can rely on:

- Daemon errors carry the HTTP status and the text
  `Error response from daemon: <message>`.
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
  connection Docker upgrades.
- Pulls send credentials for the image's registry only, from the Docker
  config file (see [Private registries](#private-registries)).
- Containers, networks, and volumes are created from Relay's own description
  of them. The request carries only what Relay sets, and Docker fills in its
  defaults. Labels are stored with what they label, so a Relay after an
  update reads the ones an earlier version wrote.

Self-updates use the API end to end: the Relay pulls and verifies the image and
launches the update helper, which replaces the container and rolls it back as
[Versioning and updates](versioning-and-updates.md#container-replacement)
describes.

API paths are unversioned, so the daemon answers in its own API version.

### Compose and buildx

The Relay runs only two Docker executables, both for app deployments:

| Executable       | Used for                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `docker-compose` | Compose Apps. Docker has no API for Compose.                                                                    |
| `docker-buildx`  | Dockerfile Apps: BuildKit, `.dockerignore`, and `--progress plain` logs. Compose uses it for `build:` services. |

Dockerfile builds run buildx from its path in the image on Docker's own
builder (`BUILDX_BUILDER=default`), so the image always lands in Docker.

The Relay image ships no `docker` CLI, so builds and Compose deploys don't
start it. (Compose still starts buildx for `build:` services.) It ships Compose v5.5.1 at
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

## Docker cleanup

Kiln removes what it leaves on Docker once it's done with it
(`apps/relay/src/docker-cleanup.ts`):

- Work that replaces a container removes the old one itself: a deployment
  its App's previous containers, a database change its old container, and
  a game server's recreation for ports or routes the container it set
  aside. A removal Docker refuses is recorded in the Relay's SQLite state
  and tried again by each cleanup pass until the container is gone, in its
  owner's lifecycle lane, so it never removes one mid-change.
- An update's helper runs in its own process and can't record what it
  couldn't remove. A pass removes an exited `io.kiln.update-helper`
  container of an update this Relay recorded as finished, and a stopped
  `<name>-kiln-backup-<time>` container the helper set aside, once a
  running container has the original name and the set-aside one is a
  Hearth or Relay container of this installation (`io.kiln.component`, and
  `io.kiln.installation` absent or this one's). While an update this Relay
  recorded is starting or running, or any update helper on the host hasn't
  exited, a pass leaves both alone, since a helper rolling back needs the
  container it set aside. Only a container an update this Relay recorded
  replaced counts as set aside, or, from before updates were recorded, a
  helper or set-aside container named as Kiln's updater names them that has
  been stopped for a day (by Docker's `FinishedAt`), which no update ever
  is. Other containers named `kiln-…`, such as game servers, aren't these. Update records live in the Relay's data
  volume, so this holds for an update a restarted Relay or the helper
  carries on; while any record can't be read, a pass leaves updates'
  leftovers and Hearth's and the Relay's images alone. An update writes its
  records in their turn after any cleanup deciding which images to remove
  (`relay.update.record`, holding `relay:docker-cleanup` shared), so
  cleanup either sees the update or is done before it pulls.

Images are removed by unforced removal only, so Docker keeps any a
container uses, even a stopped one, and never one Kiln can't tell is its
own:

- **App builds and images.** Each build is recorded as it finishes, and
  each successful deployment records the image IDs its containers run
  (`relay_app_deployment_images`). The App keeps the images of its 5 newest
  successful deployments; any other build for it (`kiln.app.id`) is removed
  a day after it was built, which keeps a failed deployment's build, its
  first deployment's too, for a day to look into. An image a deployment
  pulled goes like any other image Kiln ran (below). Builds from before
  builds were recorded: for an App with no deployment record yet, its
  newest 5 stand in until it deploys. After each successful deployment
  this runs in the background, behind other cleanup but not the App's next
  deployment, which pulls an image again if it's gone; passes run it too.
- **Hearth and Relay images.** Only those this Relay's update records name
  (the image each update replaced, as `previousImageId`, the one it put in
  place, and the Relay image its helper ran, as `helperImage`) or its own
  containers ran, so another Kiln installation on the host keeps its own.
  Of those, each pass removes the ones no container uses and no tag names,
  keeping a running update's images and, for each of Hearth and the Relay,
  the image it ran before its latest successful update, for a downgrade.
  Only when no such image is on the host does the newest stand in for it.
  A pass leaves them alone while an update this Relay recorded starts or
  runs.
- **Every other image Kiln ran.** Each pass notes the image of each of
  Kiln's containers (the Relay's own and its services, and every App's,
  database's, and game server's, as the security inventory counts them,
  `kiln-containers.ts`) with the time (`relay_docker_images`). An image
  none of Kiln's containers has used for a day is removed: a deleted game
  server's or database's, an old Traefik or CoreDNS, a turned-off
  service's. A pass removes at most 50. An image no Kiln container ever
  ran, such as one a person pulled or one Kiln stopped using before this
  record existed, is never removed automatically.

Named volumes are never removed by cleanup; they go only with the deletion
that owns them. Passes leave BuildKit's cache alone too: App builds share
Docker's default builder with the host, and Docker trims that cache itself.

A Relay's Info page in Hearth shows its Docker storage
(`relay.docker.storage`, for anyone with `relay.read`): its images, what
Kiln could remove now, unused images no Kiln container ran, BuildKit's
cache, leftover containers, and the latest cleanup since the Relay started.
Someone with `relay.configure` can clean up now (`relay.docker.cleanup`),
which the Relay starts in the background and answers at once; it runs one
such cleanup at a time, and while it runs the storage figures stay those it
last counted and show it running, so Hearth checks for its end every few
seconds without Docker counting layers mid-removal. It removes what a pass
removes, without waiting the day for images no Kiln container
uses, and, if they choose, unused images no Kiln container ran and
BuildKit's unused cache (`POST /build/prune`, the host's own builds' too).
App builds keep their day, and retention and volumes stay as above.

A pass runs a minute after the Relay starts and then every hour, and every
ten minutes while the filesystem holding the Relay's data, usually Docker's
too, is 90% full. Each part of it waits for nothing: work in its way leaves
it for the next pass. A container create that finds its image removed
meanwhile pulls it again (`createContainer` in `docker-container-spec.ts`),
so a removal racing a create costs a download, never the create.
Unforced image removal (`removeImage(..., { force: false })`) is refused
while any container, even a stopped one, uses the image.

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
The Relays page shows the process's resident memory in the Memory column, and
the container, cache and kernel readings in its tooltip.

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

## Node metrics

To size what Kiln keeps for itself against what workloads may take, the Relay
also reports what its node spends and who spends it, with the same
`OTEL_METRICS_EXPORTER=otlp`. It samples every fifteen seconds; OOM kills and
exits are counted from Docker's events as they happen. Every metric is
labelled with `relay.id`.

Container metrics carry `kiln.container.group`, one of `relay`, `hearth`,
`mysql`, `valkey`, `relay_services` (Traefik, CoreDNS, Tailscale, Limbo),
`game_server`, `app`, `database`, or `other` for every container Kiln doesn't
run, such as Coolify's. Workloads are summed per kind, never labelled per
resource, and every group is written each sample, so one that empties reads
zero.

`hearth`, `mysql`, and `valkey` are Hearth and the database and cache it uses,
whatever their engine (`mysql` includes MariaDB, `valkey` includes Redis) and
however they were deployed. The Relay on their Docker host finds them the way
[Kiln's pages](self-hosting.md#installs-that-run-hearth-by-hand) do, once a
minute, so Hearth, MySQL, and Valkey deployed by Coolify report without any
labels. Only a Relay on their host can see them: without one these groups read
zero on every Relay, and only Hearth's own process metrics below report.

| Metric                                                                                       | Meaning                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relay.container.count`                                                                      | Running containers in the group.                                                                                                                                                       |
| `relay.container.cpu.time`                                                                   | CPU seconds the group used. Its rate is cores in use.                                                                                                                                  |
| `relay.container.cpu.throttled_time`                                                         | Seconds the group's CPU limits held it back.                                                                                                                                           |
| `relay.container.memory.usage`, `relay.container.memory.anon`, `relay.container.memory.file` | Container memory, page cache included; the anonymous part, which can't be reclaimed without swap; and the page cache, which can.                                                       |
| `relay.container.oom_kills`                                                                  | Times the kernel killed a process in the group for want of memory, whether the container's limit or the node ran out.                                                                  |
| `relay.container.exits`                                                                      | Times one of the group's containers stopped, by `exit.code`. Stops Kiln asks for count too; 137 is a SIGKILL, as an OOM kill sends.                                                    |
| `relay.host.cpu.time`, `relay.host.cpu.cores`                                                | The node's CPU seconds by `cpu.mode` (`user`, `system`, `iowait`, `steal`, `idle`, ...), across all cores, and its core count.                                                         |
| `relay.host.memory.total`, `relay.host.memory.available`, `relay.host.swap.used`             | The node's memory, what it can give out without swapping, and the swap in use.                                                                                                         |
| `relay.host.pressure.stall_time`                                                             | Seconds tasks stalled for `pressure.resource` (`cpu`, `memory`, `io`), by `pressure.scope`: `some` (at least one task waited) or `full` (all did). Its rate is the share of time lost. |
| `relay.host.oom_kills`                                                                       | Processes the kernel killed for want of memory anywhere on the node, Kiln's containers or not.                                                                                         |

Host readings come from `/proc`, which a container shares with its host, so a
Relay in a container reports the whole node. Pressure needs Linux's PSI:
kernel 4.20 or later with it enabled (Debian also needs `psi=1` on the kernel
command line); without it the pressure metric is absent. Counters start from
the Relay's first sample, so a restart loses at most one interval.

## Hearth's process metrics

With the same `OTEL_METRICS_EXPORTER=otlp`, Hearth reports its own process
every fifteen seconds, from inside it, so these report however Hearth was
deployed and whether or not a Relay shares its host. Its container's numbers
are the `hearth` group above, which also counts child processes such as Grype:
expect that group's CPU to run well above `hearth.cpu.time` while Grype
updates its database.

| Metric                                                                   | Meaning                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `hearth.memory.rss`, `hearth.memory.heap_used`, `hearth.memory.external` | Resident memory, the JavaScript heap, and native memory.     |
| `hearth.cpu.time`                                                        | CPU seconds Hearth's process used. Its rate is cores in use. |

## Connection drops

Both ends log each control connection that ends, unsampled, so a drop that
lasts a moment still leaves a record. Both log the same
`kiln.relay.session_id`, the one the Relay's challenge names, so the two
sides of one session can be lined up.

| Log                                                               | From   | Says                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Relay connection dropped`                                        | Hearth | The Relay stopped reading as connected. `kiln.relay.control.close_cause` is `liveness` (silent for three 15-second intervals), `closed`, `error`, `failed` (it failed before it was fully up, such as when its first snapshot never came), `hearth_reconnect`, `hearth_closed` or `replacement_failed`. Also logs the close code and reason, session length, and time since the Relay was last heard. |
| `Relay connection restored`                                       | Hearth | Connected again after a drop, with `kiln.relay.control.downtime_ms`.                                                                                                                                                                                                                                                                                                                                  |
| `Relay replaced its control connection`                           | Hearth | A connection the Relay dialed took the place of the current one, which isn't a drop.                                                                                                                                                                                                                                                                                                                  |
| `Relay's address changed, so Hearth reconnects`                   | Hearth | The endpoint Hearth opens its connection to changed, so the old connection was closed.                                                                                                                                                                                                                                                                                                                |
| `Hearth's control connection opened`                              | Relay  | A session authenticated, with who opened it and its session ID.                                                                                                                                                                                                                                                                                                                                       |
| `Hearth's control connection closed`                              | Relay  | An authenticated session ended, with its close code and reason, who opened it, and the time since Hearth last answered a ping.                                                                                                                                                                                                                                                                        |
| `Dropped Hearth's control connection: it stopped answering pings` | Relay  | The Relay's 15-second heartbeat got no pong in time and dropped the session.                                                                                                                                                                                                                                                                                                                          |

## Workload memory limit

Game servers, Apps, and databases on a node run under one systemd slice,
`kilnworkloads.slice`, with a memory ceiling they share, which leaves the rest
to Kiln and the OS. Its size is the node's memory less a reserve (see
[Memory for Kiln and the OS](self-hosting.md#memory-for-kiln-and-the-os)).
The slice takes no memory itself; it's a ceiling, not a set-aside amount. Each
workload keeps its own limit.

The Relay sets the slice up each time it starts, as a short-lived privileged
container that enters the host, like [host access](#host-access) and under
the same `KILN_RELAY_HOST_ACCESS` setting:

    systemctl set-property kilnworkloads.slice MemoryMax=<bytes> MemorySwapMax=0 CPUWeight=50

The name has no hyphen because systemd reads one as nesting. It needs Docker
on systemd's cgroup driver and cgroup v2, not rootless, and a Relay with no
`KILN_RELAY_RESOURCE_NAMESPACE`, since a namespaced Relay shares its Docker
host. Anywhere else the Relay logs why and runs without it. Hearth's assignable
memory applies either way.

New workloads go in the slice only once the kernel is seen enforcing it: a
probe container has to land in the slice with `memory.max` at the right value.
If that fails on a first setup, the change is undone. If it fails on a node with
a limit already, the limit stays, and new workloads stay out of the slice until
a later start confirms it. The same probe failing never stops the Relay or a
workload starting.

**What it covers.** Only memory charged inside the slice. App builds run in
Docker's daemon, and other software on the host and Kiln's own containers run
outside it, so they aren't held back, and a runaway Kiln container can still
press on workloads. Workloads with no memory limit share what the others
leave, so one can still starve another; the ceiling holds them all together.
The Relay also sets `OomScoreAdj=300` on workloads, which makes them likelier
victims of a node-wide out-of-memory kill but doesn't guarantee it. `CPUWeight=50`
gives everything outside the slice, as a whole, twice the slice's share while
CPUs are contended, and nothing while they aren't.

**Existing workloads** need a new container to enter the slice, and the Relay
never restarts one for it. A game server moves the next time it starts or
restarts, an App on its next deployment, and a database when its container is
next replaced. Until then it runs outside the ceiling, and the Node card counts
it.

**Size changes.** The ceiling stays as high as the memory limits already
assigned, up to the node's memory and rounded down to a whole MiB, so a node
over budget when this arrives keeps what they promise. Bringing those limits
down doesn't bring the ceiling with them. The Node card shows it above its
target until someone lowers it. Raising it takes effect at once, without
restarting anything.

The Relay never lowers a ceiling, because that can kill workloads. Raising the
reserve therefore leaves an existing ceiling as it is, and the Node card shows
it above its target. To lower it, accepting that risk, run this on the host. The
Relay keeps a ceiling set this way, as long as it isn't below the target:

    systemctl set-property kilnworkloads.slice MemoryMax=<bytes>

**Turning it off.** Set `KILN_RELAY_WORKLOAD_MEMORY_LIMIT=false` and restart the
Relay, which removes the limit from the running slice. Workloads stay in the
slice, unlimited. With host access off, or to remove it by hand, run both of
these on the host, since `systemctl revert` alone leaves the kernel enforcing
the old limit:

    systemctl set-property kilnworkloads.slice MemoryMax=infinity MemorySwapMax=infinity CPUWeight=100
    systemctl revert kilnworkloads.slice

Kiln owns the slice's settings: each Relay start sets its swap and CPU weight
again, and raises a ceiling that's below the target. Use
`KILN_RELAY_RESERVED_MEMORY` to change the target.

## Host access

The Relay workspace includes a root terminal on its Docker host, protected by
`relay.terminal`. Set `KILN_RELAY_HOST_ACCESS=false` on the Relay to disable host
access. Its small shell helper is created on first use and removed when host
access is disabled. Each person's session survives page and Hearth reconnects
and closes after the configured terminal idle timeout.

The Files page browses and edits the host's files with the same browser and
editor as game server and App files, protected by `relay.files.read` and
`relay.files.write`. It needs the host's filesystem mounted at `/host`. Someone
with `relay.files.mount` (Relay owners and platform admins by default) can turn
that on from the Files page, which restarts the Relay with the mount and puts it
back as it was if that fails. With Compose, start it with
`docker compose -f compose.yaml -f compose.host-files.yaml up -d` instead.
Recreating the Relay from a Compose file without it removes the mount. Saving a
host file overwrites it in place, as editors do, so its hard links and
containers that bind-mount it see the change. Where Docker is rootless, remaps
users, or SELinux confines the Relay, the Files page says which files it can't
reach. Links with absolute targets resolve inside the Relay's container, so the
Files page refuses to open them.

The Database page inspects the live `/data/network/relay.sqlite` file in
read-only mode. `relay.database.read` grants access to its state, including
sensitive configuration. When host files are mounted, `relay.files.read` can
read the same file through Docker's volume directory.
