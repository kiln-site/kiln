---
title: FAQ
description: Short answers about what Kiln costs, its license, what it runs on, and where to get help.
---

## Is Kiln free?

Yes, when you host it yourself. Self-hosted Kiln has every feature, with no
limit on Relays or instances, and costs nothing. You run Hearth and your
Relays on machines you control and store backups wherever you choose.

Paid plans, where Kiln hosts Hearth for you and your own machines still run
the instances, are coming soon. See [pricing](https://kiln.site/pricing).

## What license is Kiln under?

Kiln is dual-licensed:

- The [GNU Affero General Public License v3.0](https://github.com/kiln-site/kiln/blob/main/LICENSE)
  (AGPL-3.0). You can use, change, and share Kiln, including commercially,
  as long as you follow the AGPL. Running an unmodified copy, even as a
  service for others, doesn't by itself require you to publish source code.
- The [Kiln Commercial License](https://github.com/kiln-site/kiln/blob/main/COMMERCIAL_LICENSE.md),
  a paid option for anyone who wants to keep changes private, build a
  proprietary product on Kiln, or can't use the AGPL. Email
  [contact@kiln.site](mailto:contact@kiln.site) to buy one.

If you can follow the AGPL, you don't need the commercial license.

## What does Kiln run on?

Hearth and Relays run on Linux with Docker 20 or newer. The installer sets up
Docker for you on Debian, Ubuntu, Fedora, CentOS, RHEL, Rocky, AlmaLinux,
Oracle Linux, Raspberry Pi OS, SLES, Alpine, and Arch.

Kiln's images are built for x86-64 and ARM64 machines. Some Bricks need
x86-64: those built on the SteamCMD Ember, which many Steam games use, don't
run on ARM64.

How much CPU, memory, and disk you need depends on what you run. Hearth, its
database, and its cache share one machine; each game server, app, or database
adds its own needs on top.

## Does Kiln run on Windows?

Not as a host. Hearth and Relays need Linux with Docker. The installer also
runs on macOS with Docker Desktop.

The [kiln CLI](/cli) does run on Windows: download `kiln.exe` from the
[GitHub releases](https://github.com/kiln-site/kiln/releases).

## Can one Kiln manage several machines?

Yes. [Install Kiln](/get-started/install) once, then
[add each other machine as a Relay](/relays/add). Every Relay
connects to the same Hearth, and you manage all their game servers, apps, and
databases from it.

## Where do I get help?

- Ask the community on [Discord](https://discord.gg/gu76VAtSK5).
- Report bugs and request features on
  [GitHub](https://github.com/kiln-site/kiln).
- Email [contact@kiln.site](mailto:contact@kiln.site).

Before asking, check [Troubleshooting](/help/troubleshooting).
