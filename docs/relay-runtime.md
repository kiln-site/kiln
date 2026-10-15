# Relay runtime

This document describes how the Relay runs on a host: how it talks to Docker,
how Docker checks its health, and how to read its memory use. The Relay runs on
every node, so its idle cost is paid once per host.

## Snapshot loop

The Relay keeps one snapshot sampler running at all times, even without a
Hearth connection, so crash recovery never depends on Hearth. Each sample lists
Kiln's containers, inspects them, and samples resources for running servers.
The next sample starts 2 seconds after the previous one finishes, so a slow
Docker daemon spaces samples out instead of stacking requests. Listing and inspecting share one 30 second
budget per sample.

Disk usage for each server directory is measured separately, at most once a
minute.

## Docker access

The Relay talks to the Docker Engine API over the mounted socket
(`/var/run/docker.sock`), mostly through one client,
`apps/relay/src/docker-engine.ts`. The snapshot loop, power actions, console
logs and streams, container terminals, readiness probes, resource stats, crash
recovery, databases, Tailscale stacks, and Traefik and Coolify discovery all
use it. Console input and tab completion attach to the container over the same
socket directly, because they hold the attach connection open themselves.

An idle Relay starts no processes for its own sampling. Hearth's update check
still runs `docker inspect` on each Relay whenever the Relays page loads or
refetches.

The client keeps the Docker CLI's observable behavior where callers rely on it:

- Daemon errors carry the HTTP status and the CLI's
  `Error response from daemon: <message>` text.
- Force-removing a missing container succeeds. Starting a running container or
  stopping a stopped one succeeds.
- A non-zero exec exit code fails the call.
- An error Docker reports inside a log or exec stream fails the read.
- One-shot reads, such as logs and exec output, stop as soon as they pass
  their size limit. Followed log streams have no total limit, but each line is
  cut off past 1 MiB.

API paths are unversioned, so the daemon answers in its own API version.

The image still ships the `docker` CLI for operations where the API would be
riskier:

| Operation                                  | Why it stays on the CLI                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Creating containers, networks, and volumes | Their labels and options are a compatibility format that other Kiln versions read. Recreating an existing container uses the API.           |
| `docker pull`                              | Keeps registry credentials from `~/.docker/config.json` and credential helpers.                                                             |
| `docker build`                             | Builds Dockerfile apps with the CLI's build output and BuildKit behavior.                                                                   |
| `docker compose`                           | Docker has no API for it.                                                                                                                   |
| Execs that read stdin                      | Database import and export, credential rotation, platform dump and restore, the SQL browser, and database backups stream through a process. |
| Self-update                                | The update check (`docker inspect`) and the updater, which is mostly `pull` and `run`.                                                      |

Console input and container terminals are the other exception: they read
input, but use the API's attach and exec connections instead of the CLI. New
Docker calls should go through the Engine API client unless they fall into one
of these cases.

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

| Reading      | Source                         | Meaning                                                                                                                                                  |
| ------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process      | `process.memoryUsage()`        | The Relay's Node.js process: resident memory (RSS), JavaScript heap, and native buffers.                                                                 |
| Container    | cgroup v2 `memory.current`     | Everything charged to the Relay container, including page cache.                                                                                         |
| Cache        | `memory.stat` `file`           | Page cache charged to the container, mostly from reading files for backups and downloads. The kernel reclaims it under memory pressure.                  |
| Kernel       | `memory.stat` `kernel`         | Kernel memory charged to the container, including the inode and directory caches from scanning server directories. Some kernels report none.            |
| Docker stats | Container minus inactive cache | What `docker stats` and tools built on it, such as Beszel, report.                                                                                       |

Container memory therefore overstates what the Relay holds. To judge the Relay
itself, look at process memory; to judge pressure on the host, look at
container memory minus cache.

Container readings need cgroup v2 and Docker's default private cgroup
namespace. Outside a container, on cgroup v1, or with `--cgroupns=host`, only
process memory is shown. Relays that predate memory reporting show
`Not reported`.

Hearth reads these values from its live Relay connection, so the column adds no
Relay requests. When Sentry is configured, the Relay also reports
`relay.memory.*` gauges once a minute.
