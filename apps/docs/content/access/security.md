---
title: Vulnerability scanning
description: How Kiln checks your Relay hosts, game servers, databases, and apps for known vulnerabilities, and where it tells you what it found.
---

Kiln checks the software it runs against known vulnerabilities and tells the
people who can fix it. It covers every Relay's host, Kiln's own services, and
every game server, database, and app. Nothing needs setting up.

## The Security page

Kiln Admins see everything Kiln found on the **Security** page. To open it,
click **Kiln** in the Infrastructure toolbar, then the **Security** tab.

- The summary counts vulnerabilities by severity, how many **An update
  fixes**, and how many are **Known exploited**.
- The table lists each vulnerability with its **Severity**, where it was
  **Found in**, the **Package**, the **Fix** if there is one, and when it was
  **First seen**.
- Narrow the list with the instance picker, the severity filter, or search by
  CVE, package, or instance.
- The list beside the findings shows each instance Kiln has inventoried.
- **Scan now** checks the selection again against the latest vulnerability
  data. Each instance in that list has its own **Scan now**.

People who aren't Kiln Admins can't open the Security page. Instead, a
resource's **Info** page warns anyone who can see it when what it runs has
critical or high vulnerabilities, or ones known to be exploited. The warning
says whether updating fixes them.

## How it works

Kiln splits the work in two, so nothing is scanned twice and an offline Relay
stays covered.

1. **Inventory, on the Relay.** Each Relay lists the OS packages on its host
   and the software in every image its containers run, using
   [Syft](https://github.com/anchore/syft). Each image is inventoried once,
   and again only when you deploy a new image. Host packages change outside
   Kiln, so the host is inventoried again once a day, or when you click
   **Scan now**.
2. **Matching, in Hearth.** Hearth keeps every inventory and checks it
   against [Grype](https://github.com/anchore/grype)'s vulnerability
   database: when the inventory arrives, and all of them again whenever that
   database changes. Hearth looks for a new database every six hours. It's
   rebuilt daily from Linux distributions' advisories, GitHub's advisories
   for language packages, NVD, CISA's known exploited list, and EPSS.

Every 15 minutes Hearth asks each connected Relay what it runs and asks for
any inventory it's missing. A new Relay is inventoried within a few minutes
of connecting.

## Notifications

When Kiln finds vulnerabilities you haven't heard about, in something you can
update, you get a **Vulnerability report** in your inbox, and on your devices
if push is on. You have one report at a time: a newer one replaces it, and
folds in what the old one said while it's unread. It says how many new
vulnerabilities there are, the most severe, how many are known to be
exploited, and where.

Reports go to the people who can act on them:

| Resource                                 | Permission needed                                         |
| ---------------------------------------- | --------------------------------------------------------- |
| A Relay's host and Kiln's services on it | **Update Relay** (`relay.update`)                         |
| Game server                              | **Manage configuration** (`instance.configuration.write`) |
| Database                                 | **Control database power** (`database.power`)             |
| App                                      | **Configure and deploy apps** (`app.manage`)              |

Kiln Admins get all of them.

A vulnerability is reported once per resource while it stays, again when a
fix comes out, and again if it goes away and comes back. Choose which
severities notify you in **Settings → Notifications**. See
[Notifications](/access/notifications#choose-what-reaches-you).

## Resource limits

Scanning is built to stay out of the way of your game servers and apps.

The Relay never runs Syft inside its own container or a workload's. It starts
a short-lived helper container with:

- the lowest CPU weight Docker allows, at most one core, and the lowest disk
  I/O weight;
- a 1 GiB memory cap, and first in line to be killed if the host runs low on
  memory;
- no network access, and no way to gain privileges.

One inventory runs at a time. None starts while the host's load average is at
one per core or higher; Hearth asks again five minutes later. Images are read
without being started. The host is read only through its package databases
and OS release file, mounted read-only, so the helper never walks the host's
filesystem. A host inventory takes seconds.

Hearth runs one Grype check at a time, at the lowest CPU priority. Each takes
a few seconds.

> [!NOTE]
> Grype's vulnerability database is a 200 MB download that unpacks to about
> 3 GB on Hearth's machine. Hearth fetches it the first time it has something
> to check.

## What it can't see

- Game servers are checked through their runtime image, not the server
  software, mods, or plugins in their files.
- A host is checked through its OS packages. Software installed outside the
  package manager, such as Docker from a static download, isn't seen.
- Changes made inside a running container aren't seen; its image is.
- Relays older than the version that added scanning show as waiting until
  you update them.
