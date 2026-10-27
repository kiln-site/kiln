---
title: Vulnerability scanning
description: Kiln checks your Relay hosts, game servers, databases, and apps for known vulnerabilities and tells the people who can fix them.
---

Kiln checks every Relay's host, Kiln's own services, and every game server,
database, and app against known vulnerabilities. Nothing needs setting up.

## The Security page

Kiln Admins click **Kiln** in the Infrastructure toolbar, then the
**Security** tab.

- The summary counts vulnerabilities by severity, how many **An update
  fixes**, and how many are **Known exploited**.
- The table shows each one's **Severity**, where it was **Found in**, the
  **Package**, the **Fix**, and when it was **First seen**. Narrow it with the
  instance picker, the severity filter, or a search by CVE, package, or
  instance.
- **Scan now** checks the selection again. Each instance in the list beside
  the findings has its own.

Everyone else sees a warning on a resource's **Info** page when what it runs
has critical, high, or known exploited vulnerabilities, and whether updating
fixes them.

## Reports

When Kiln finds new vulnerabilities in something you can update, you get a
**Vulnerability report**. A newer one replaces it.

| Resource                                 | Report goes to                                            |
| ---------------------------------------- | --------------------------------------------------------- |
| A Relay's host and Kiln's services on it | **Update Relay** (`relay.update`)                         |
| Game server                              | **Manage configuration** (`instance.configuration.write`) |
| Database                                 | **Control database power** (`database.power`)             |
| App                                      | **Configure and deploy apps** (`app.manage`)              |

Kiln Admins get all of them. A vulnerability is reported again when a fix
comes out. Choose which severities notify you in
[Notifications](/access#notifications).

## How it works

Each Relay inventories its host's OS packages and every image its containers
run with [Syft](https://github.com/anchore/syft): each new image once, the
host daily or on **Scan now**. Hearth checks the inventories against
[Grype](https://github.com/anchore/grype)'s vulnerability database, and looks
for a new database every six hours. A new Relay is covered within minutes.

Scanning stays out of your workloads' way. Syft runs in a helper container at
the lowest CPU and disk priority, with at most one core, 1 GiB of memory, and no
network, and waits while the host is busy.

> [!NOTE]
> Grype's database is a 200 MB download that unpacks to about 3 GB on Hearth's
> machine.

## What it can't see

- Game server files: the server software, mods, and plugins. Only the runtime
  image is checked.
- Host software installed outside the package manager, such as Docker from a
  static download.
- Changes made inside a running container.
- Relays older than the version that added scanning. They show as waiting
  until you update them.
