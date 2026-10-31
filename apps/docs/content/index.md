---
title: Get started
description: Install Kiln on one machine, then add your other machines as Relays.
---

Kiln runs game servers, apps, and databases on machines you own, all from one
web panel. It's free and open source, and in early development.

## Install

Run this on the Linux machine that will run Kiln:

```sh title="On the machine that will run Kiln"
curl -fsSL https://kiln.site/install | sh
```

It installs Docker if it's missing, asks where people will open Kiln (press
<kbd>Enter</kbd> for the machine's IP address, or type a domain that points at
it), and starts everything. When it's done, it prints a link. Open it and
create your administrator account.

Kiln needs ports 80 and 443 for HTTPS, and gives game servers ports from 30000
to 39999. To run it with Docker Compose instead, see
[Self-hosting](/self-hosting).

## Add a Relay

The machine you installed on can already run everything. To use another
machine, add a **Relay** to it:

```walkthrough
add-relay
```

1. In Kiln, open **Infrastructure → Relays** and choose **Add Relay**.
2. Choose **Copy** to copy the install command.
3. Run it on the new machine. It installs the Relay and connects it to Kiln.
4. Back in Kiln, check that the fingerprint matches the one in the terminal,
   and choose **Add Relay**.

The command works for 30 minutes. For installer options and pairing errors, see
[Relays](/relays).

## How Kiln fits together

- **Hearth** is the web panel. It holds accounts, permissions, and settings,
  and tells each Relay what to run.
- A **Relay** runs on each machine. It runs your game servers, apps, and
  databases in Docker. A machine behind a home router can still join; its
  Relay connects out to Hearth.
- Game servers start from **Bricks**, recipes that set up the right image,
  settings, and ports. Kiln has official Bricks, such as Minecraft and
  Palworld, and you can add your own.

## Next

- [Create a game server](/game-servers)
- [Deploy an app](/apps)
- [Add a database](/databases)
- [Invite people](/access)
