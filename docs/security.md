# Vulnerability checks

Kiln checks the software it runs against known vulnerabilities, says plainly
whether each image and host is safe, and offers what fixes it. Kiln's
**Security** page (`/kiln/security`, for platform administrators) lists every
image and Relay host, worst first, narrowed with the instance picker. A
resource's Info rail has a **Security** row with the same word on what it runs,
for anyone who can see it. It never moves the page, and for administrators it
opens the Security page with that instance selected.

## Verdicts

An image on a Relay, counted once however many resources run it, or a host,
gets one word
(`securityVerdict`):

| Verdict | When                                                     |
| ------- | -------------------------------------------------------- |
| Unsafe  | Anything known to be exploited, or a critical with a fix |
| Risky   | A critical without a known fix, or anything high         |
| Minor   | Only medium, low, or negligible                          |
| Clean   | Nothing known                                            |

A critical without a known fix isn't unsafe, or an image already on its newest
version would stay red with nothing anyone could do about it.

Opening one says what the resource is, where what it runs came from, what to
move it to, and one button that says what it does. Below that are its
vulnerabilities, rolled up by package since one update clears them all, with
each package's CVEs a click further. They're read only then, so the page stays
light however many a host has. The dialog keeps one size throughout.

## Fixing

What Kiln offers depends on where the software came from:

| Where                 | Fix                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image app, tag moved  | **Update and redeploy** deploys the image the tag names, as the app's Updates do                                                                           |
| Image app, otherwise  | Newer versions of the tag its registry lists, recommending the newest of its major version; **Update and redeploy** changes the app's image and deploys it |
| Built apps            | A hint: the change goes in its repository or file, then **Redeploy**                                                                                       |
| Relay host            | **Check for updates**, then **Install** (see below)                                                                                                        |
| Kiln's own services   | A pointer to updating Kiln                                                                                                                                 |
| Database, game server | A hint: Kiln and Bricks choose these images                                                                                                                |

Versions are read anonymously from Docker Hub and GHCR, the only registries
Kiln asks, so an image's name can't send Hearth anywhere else. A private image,
or one from another registry, gets the hint instead. Only a tag that spells out
a version is compared, against tags of the same shape: `1.21.0-alpine` moves to
`1.21.6-alpine`, never to `1.21` or `1.21.6`. A newer version isn't known to fix
anything until it runs, so when a deployment ends, whatever started it, Kiln
inventories what the app runs now rather than waiting for the next sweep.

### Updating a host

Updating a host needs `relay.terminal`, since a root shell could do the same, and
`KILN_RELAY_HOST_ACCESS`. **Check for updates** asks the host what's new, so
nobody confirms blind, then **Install** runs its own package manager as root: APT,
DNF, YUM, Zypper, or apk. Other hosts are pointed at their Terminal.

- It updates only what's installed, without adding or removing packages, and
  keeps their configuration. A kernel APT holds back stays until someone
  upgrades it.
- It leaves the container engine alone (Docker, containerd, runc, Podman), since
  updating that restarts every container on the host. The confirmation names
  what it left out.
- It restarts nothing. Kiln says when the host wants a reboot, which stays
  someone's choice.
- It runs detached on the host, under systemd where there is one, and keeps its
  state in `/var/lib/kiln-host-packages`, so it survives the Relay restarting and
  only one runs at a time.

When it ends, the page collects the host's inventory again. So does the next
sync, within 15 minutes, for anyone who closed the page: the Relay reports when
an update last finished, without starting the host's helper to find out.

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
  the lowest block I/O weight, on kernels that have one;
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

When Grype finds vulnerabilities a resource's people haven't heard of, each of
them gets a vulnerability report, in the inbox and on devices with push
notifications on. A person has one report at a time: a newer one replaces it,
adding in what it said while it's unread, so the inbox never fills with one
notification per resource. It says how many new vulnerabilities there are, the
most severe, how many are known to be exploited, and where. For administrators
its **Review** button opens the Security page, narrowed to the resource when
there's one; others go to the resource (see below). It
goes to people who can act on it:

| Resource                           | Permission                     |
| ---------------------------------- | ------------------------------ |
| A Relay's host and Kiln's services | `relay.update`                 |
| Game server                        | `instance.configuration.write` |
| Database                           | `database.power`               |
| App                                | `app.manage`                   |

Platform administrators hold all of them. In **Settings → Notifications**,
**Vulnerability reports** chooses where these reach you like any other
notification, and below it you choose the least severe vulnerability that
notifies (high and above by default) and whether only ones an update fixes do
(on by default). [Notifications](notifications.md#choosing-what-you-hear)
covers whose instances you hear about and turning them off for one resource.
Vulnerabilities known to be exploited notify either way. A vulnerability is
reported once per resource while it stays, again when a fix comes out for it, and again if it goes away and comes back. People who aren't
platform administrators can't open the Security page, so their report opens
the resources it names instead, where the Info rail's Security row says what
it has and what fixes it.

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
