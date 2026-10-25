# Vulnerability checks

Kiln checks the software it runs against known vulnerabilities and tells the
people who can fix it. Kiln's **Security** page (`/kiln/security`, for platform
administrators) shows what it found across every Relay host, Kiln service, game
server, database, and app, narrowed with the instance picker. A resource's Info
page warns anyone who can see it when what it runs has critical or high
vulnerabilities, or ones known to be exploited.

## How it works

Kiln splits the work in two, so nothing is scanned twice and an unreachable
Relay stays covered:

1. **Inventory, on the Relay.** Each Relay inventories its host's OS packages
   and every image its containers run with [Syft](https://github.com/anchore/syft),
   producing an SBOM (a Syft JSON document). An image is identified by its
   content-addressed ID, so each one is inventoried once; redeploying to a new
   image inventories that image. The host's packages change outside Kiln, so
   its inventory is collected again once a day, or when someone scans now.
2. **Matching, in Hearth.** Hearth keeps every inventory in its database and
   checks each against [Grype](https://github.com/anchore/grype)'s
   vulnerability database: when it arrives, and all of them again whenever
   that database changes, which Hearth looks for every six hours. Anchore
   rebuilds it daily from distribution advisories (Debian, Ubuntu, Alpine,
   Red Hat, and others), GitHub's advisories for language packages, NVD (which
   catches software built from source, like PHP in the official `php`
   images), CISA's known exploited list, and EPSS.

Every 15 minutes Hearth asks each connected Relay what it runs, which costs
the Relay one container listing, and asks for any inventory it lacks.
The scan's helper drops the per-file listings Grype doesn't read, and a
host's kernels other than the running one, before the Relay sends an
inventory. Inventories
reach Hearth in 512 KiB chunks over the control connection: a host's is a few
hundred kilobytes gzipped, an image's tens. Hearth refuses one over 32 MiB
unzipped, so a Relay can't run it out of memory.

Findings are kept per inventory with when each was first seen. Hearth keeps
inventories per Relay rather than sharing one image's between Relays, since it
can't verify what a Relay says an image holds.

## Staying out of the way

The Relay never runs Syft, or reads its output, in its own container or a
workload's. It starts a short-lived helper from its own image, which runs
Syft and slims what it found, with:

- the lowest CPU weight Docker gives (`CpuShares: 2`), at most one core, and
  the lowest block I/O weight;
- a 1 GiB memory cap and `OomScoreAdj: 1000`, so it's the first thing killed
  if the host runs short;
- no network, and `no-new-privileges`.

One inventory runs at a time, and none starts while the host's load average is
one per core or more: the Relay answers `busy` and Hearth asks again in five
minutes. Images are read through Docker without being started. The host is
read through only its package databases (`/var/lib/dpkg/status`,
`/var/lib/rpm`, `/lib/apk/db`, and so on) and its OS release file, each mounted
read-only once a probe container that never starts finds which exist, so the
helper never walks the host's filesystem. A host inventory takes seconds.

Hearth runs one Grype at a time at the lowest CPU priority. Checking an
inventory takes a few seconds.

## Notifications

When Grype finds a vulnerability a resource's people haven't heard of, they get
one notification for the resource, in the inbox and on devices with push
notifications on. It goes to people who can act on it:

| Resource                           | Permission                     |
| ---------------------------------- | ------------------------------ |
| A Relay's host and Kiln's services | `relay.update`                 |
| Game server                        | `instance.configuration.write` |
| Database                           | `database.power`               |
| App                                | `app.manage`                   |

Platform administrators hold all of them. In **Settings → Notifications**,
the Security section turns these on or off in Kiln and for push like any other
notification, and chooses the least severe vulnerability that notifies (high
and above by default) and whether only ones an update fixes do (on by
default). Vulnerabilities known to be exploited notify either way. A
vulnerability notifies once per resource while it stays, again when a fix
comes out for it, and again if it goes away and comes back. A notification
opens its resource, whose Info page says what it has and what fixes it.

## Running it

The Relay image ships Syft and the Hearth image ships Grype; nothing needs
configuring. Grype's database is a 200 MB download that unpacks to about
3 GB, which Hearth fetches the first time it has an inventory to check and
keeps in `KILN_VULNERABILITY_DB_DIR` (`/var/lib/kiln/vulnerability-db` in the
image). A platform Relay mounts the `kiln-hearth-data` volume at `/var/lib/kiln`
so it survives Hearth's updates; a Hearth run any other way without a volume
there downloads it again each time its container is recreated.

| Variable                    | Where  | Default                                                    |
| --------------------------- | ------ | ---------------------------------------------------------- |
| `KILN_RELAY_SYFT_PATH`      | Relay  | `/usr/local/bin/syft`                                      |
| `KILN_GRYPE_PATH`           | Hearth | `grype` on `PATH`                                          |
| `KILN_VULNERABILITY_DB_DIR` | Hearth | `/var/lib/kiln/vulnerability-db`, or a temporary directory |

The Relay's data directory must be a volume, as it is in every supported
install, so its helpers can hand inventories back to it. Relays older than the
`security-inventory-v1` feature show as waiting until they're updated.

## Limits

- Game servers are checked through their runtime image, not the server
  software and plugins in their data directory.
- A host is checked through its OS packages. Software installed outside the
  package manager, such as a Docker Engine from a static download, isn't seen.
- Changes made inside a running container aren't seen; its image is.
