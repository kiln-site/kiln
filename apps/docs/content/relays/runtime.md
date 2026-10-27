---
title: How a Relay runs
description: What a Relay needs from its machine, how it uses Docker, how Docker checks its health, and how to read its memory use.
---

A Relay is one Docker container on its machine. This page covers what it needs,
how it uses Docker, and how to read its health and memory.

## What a Relay needs

- **Docker.** The install command installs Docker when it's missing. Docker
  Engine 25 or newer lets the Relay's health check run faster at startup.
- **The Docker socket.** The Relay drives Docker through
  `/var/run/docker.sock`, mounted into its container.
- **A data volume.** The Relay keeps its state, backups kept on the Relay, and
  game server files in its volume, `kiln-relay-data`, mounted at `/data`.
- **A way to reach Hearth.** The Relay connects to Hearth's address, or Hearth
  connects to the Relay. See [Connections](/relays/connections).

The ports it uses depend on how it was installed:

| Port      | Used for                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------ |
| 80, 443   | The Relay's Traefik, when it runs one: Hearth reaches the Relay here, and apps get their HTTPS.  |
| 4100      | The Relay's own HTTPS, when it doesn't run Traefik. Not opened when the Relay connects to Hearth. |
| 2022      | SFTP. The installer's `--sftp-port` changes the host port.                                     |

## How it uses Docker

The Relay talks to the Docker Engine API directly over the socket. It never runs
the `docker` command. Everything goes through the API: listing and inspecting
containers, power actions, consoles, terminals, image pulls, and creating
containers, networks, and volumes.

The Relay runs only two Docker programs, both for apps: `docker-compose` for
Compose apps and `docker-buildx` for Dockerfile apps. Both ship in the Relay's
image.

About every 2 seconds, the Relay checks its containers and samples the resources
of running game servers. It does this even without Hearth, so crash recovery
never depends on Hearth. It measures each game server's disk use at most once a
minute.

An idle Relay starts no processes.

## Private registries

To pull private images, the Relay reads logins from its own Docker config file,
`/root/.docker/config.json` in its container, or `config.json` in the directory
`DOCKER_CONFIG` names. Hearth doesn't manage registry logins yet.

Running `docker login` on the host doesn't reach the Relay: Docker keeps logins
on the client, and the Relay's container has its own filesystem. To pull private
images:

1. Write a Docker config file with the credentials inline, under `auths`.
   Credential helpers (`credsStore`, `credHelpers`) aren't supported.
2. Mount it into the Relay's container and set `DOCKER_CONFIG` to its directory.

One login covers images, Compose services, and `FROM` lines in Dockerfiles.

## Health check

The Relay's image has a Docker health check. It asks the Relay's health
endpoint, `/health`, on a listener bound only to `127.0.0.1`, and passes when the
Relay answers. Docker checks every 10 seconds, and every second while the Relay
starts.

- `KILN_RELAY_HEALTH_PORT` sets that listener's port. The default is 4101.
- `/health` also answers without signing in on the Relay's main port, for
  outside monitors.
- The health port must differ from `KILN_RELAY_PORT` and
  `KILN_RELAY_SFTP_PORT`. Relays that share a host network each need their own
  health port; otherwise the second one stops at startup and names the variable
  to change.

## Memory use

The **Memory** column on the Relays page, shown on large screens, gives the
Relay process's own memory. Hover it, or focus it, for the full breakdown:

| Reading          | What it means                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Relay process** | The Relay's own program: resident memory, JavaScript heap, and native buffers.                                               |
| **Charged**       | Everything charged to the Relay's container, including file cache.                                                           |
| **File cache**    | Cache from reading files for backups and downloads. The kernel frees it when memory runs short.                             |
| **Kernel**        | Kernel memory charged to the container, such as caches from scanning game server folders. Some kernels report none.        |
| **Docker stats**  | What `docker stats`, and tools built on it, report for the container.                                                       |

Container memory overstates what the Relay holds, since it counts cache. To judge
the Relay itself, look at its process memory. To judge pressure on the machine,
look at container memory minus cache.

Container readings need cgroup v2 and Docker's default private cgroup namespace.
Without them, only process memory shows. A Relay too old to report memory shows
**Not reported**.

## Telemetry

When OpenTelemetry export is configured with the `OTEL_*` variables, the Relay
reports `relay.memory.*` gauges once a minute, along with metrics on how busy its
control connection, file transfers, and terminals are.
