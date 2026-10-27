---
title: Introduction
description: Kiln runs game servers, apps, and databases on machines you own, managed from one web panel.
---

Kiln is a free, open-source panel for game servers, apps, and databases. It
runs them in Docker on machines you own, and you manage all of them from one
web panel with the same console, files, backups, and access controls.

Kiln is in early development.

## Hearth and Relays

Kiln has two parts:

- **Hearth** is the web panel. You open it in a browser to create and manage
  everything.
- A **Relay** runs on each machine you own. It runs the containers, and Hearth
  tells it what to do.

The machine you install Kiln on runs Hearth and a Relay, so it can host
everything itself. To use more machines, add a Relay to each one from Hearth.
See [How Kiln fits together](/get-started/concepts) for the details.

## What it runs

- **Game servers**, started from **Bricks**, such as Minecraft and Palworld.
  Kiln sets up ports and the right Java version. You can write your own Bricks
  or add community catalogs.
- **Apps**, deployed from a GitHub repository, a Docker image, a Dockerfile, or
  a Compose file. Kiln builds each push and switches over once the new
  containers are healthy.
- **Databases**: MySQL, MariaDB, PostgreSQL, Redis, and Valkey, next to the
  app or game server that uses them.

Around them, Kiln has a live console with search, a file editor in the
browser, backups to S3-compatible storage, schedules, per-instance access
control, an activity history, Cloudflare DNS for game server addresses, HTTPS
for app domains, Tailscale, a command-line tool, and updates from the panel.

Kiln runs on Linux with Docker. It doesn't run on Windows hosts, and it
doesn't orchestrate Docker Swarm or Kubernetes.

## Where to go next

1. [Install Kiln](/get-started/install) on the machine that will run Hearth.
2. Read [How Kiln fits together](/get-started/concepts).
3. [Create your first game server](/get-started/first-game-server) or
   [deploy your first app](/get-started/first-app).

Kiln is open source under AGPL-3.0, with a commercial license available. The
code is at [github.com/kiln-site/kiln](https://github.com/kiln-site/kiln).
