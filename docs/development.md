# Development

Use the Node version in `.node-version`, pnpm/Vite+, Git, and a local Docker
engine with Compose v2.24.4+ and Linux containers. OrbStack is optional.

```sh
vp install --frozen-lockfile
pnpm dev:setup
pnpm dev:docker
```

Run `dev:setup` once per clone. It creates `.env` in the primary checkout and
fills missing secrets; linked worktrees share that file. Open the Hearth URL
printed at startup.

A stack is a Hearth and a Relay. They use the box's shared MySQL and Valkey,
which start with the first stack and stay up (see
[Shared services](#shared-services)).

React Scan is opt-in so its instrumentation and toolbar don't delay fresh
dev loads, especially on mobile. Start with `VITE_REACT_SCAN=true pnpm dev:docker`
to enable the toolbar and `window.__hearthRenderAudit` for profiling. Restart
with ordinary `pnpm dev:docker` to disable it again. For a local web process,
use `VITE_REACT_SCAN=true pnpm --filter web dev`.

## Access and worktrees

Standard Docker uses `http://localhost:3000`, with the shared MySQL on port 3307
and SFTP on port 2022. All published ports bind to loopback. OrbStack is detected
automatically and uses HTTPS container domains instead of fixed host ports.
Override detection with `KILN_DEV_NETWORK=localhost` or `orbstack`.

The primary checkout uses project `kiln`. Linked worktrees use the branch name:
`chore/repo-cleanup` becomes `kiln-repo-cleanup`, with the OrbStack URL
`https://kiln-repo-cleanup.orb.local`. The name is saved on first start so
branch switches keep the same stack and data. Set `KILN_DEV_PROJECT` before
first start to choose a different name; keep names unique across checkouts.

For concurrent stacks without OrbStack, choose free host ports:

```sh
KILN_DEV_WEB_PORT=3001 KILN_DEV_SFTP_PORT=2023 pnpm dev:docker:up
```

Set overrides in your shell, not the shared `.env`, and keep them set for
subsequent commands. Use a fresh project when changing network modes because
paired Relays retain their endpoints. Game server port allocations also need
to be unique across running stacks.

## Commands

| Command                   | Purpose                                          |
| ------------------------- | ------------------------------------------------ |
| `pnpm dev:docker`         | Start and follow Hearth logs                     |
| `pnpm dev:docker:up`      | Start in the background and wait until healthy   |
| `pnpm dev:docker:logs`    | Follow Hearth and Relay logs                     |
| `pnpm dev:docker:refresh` | Restart Relay and Hearth                         |
| `pnpm dev:docker:down`    | Stop, preserving data                            |
| `pnpm dev:docker:destroy` | Delete a worktree's stack and everything it owns |
| `pnpm dev:docker:test`    | Run web tests on the box's MySQL                 |
| `pnpm dev:docker:shared`  | Manage the box's shared MySQL and Valkey         |
| `pnpm dev:docker:s3`      | Manage the tailnet's S3 endpoint                 |

## Shared services

Each Docker engine runs one MySQL (`kiln-dev-mysql`) and one Valkey
(`kiln-dev-cache`), from `compose.dev.shared.yaml`. A stack gets:

- its own database and user, named from a hash of the stack: `s_<hash>` and
  `u_<hash>`. Its tables keep the `kiln_` prefix production uses. A database
  rather than a table prefix per stack, because platform backups dump and
  restore a whole database, and teardown is one `DROP DATABASE`.
- test databases `t_<hash>_test_*`, which its user can create. That user can
  reach nothing else.
- a cache namespace, which Hearth derives from its database, so stacks can't
  read each other's keys.

`pnpm dev:docker:shared status` lists the services, the slice each runs in,
every registered stack with its database and checkout, and any database no
stack owns. The registry is the `kiln_dev.stacks` table on the same MySQL.

| Command                                 | Purpose                                      |
| --------------------------------------- | -------------------------------------------- |
| `pnpm dev:docker:shared status`         | Show services, stacks, and strays            |
| `pnpm dev:docker:shared up`             | Start them; a stack does this itself         |
| `pnpm dev:docker:shared up --recreate`  | Recreate them after a version change         |
| `pnpm dev:docker:shared down`           | Stop them, refusing while stacks run         |
| `pnpm dev:docker:shared remove <stack>` | Clear a stack whose checkout is gone         |
| `pnpm dev:docker:shared destroy`        | Delete them, refusing while stacks have data |

A stack never recreates healthy services, which every other stack on the box
depends on. If it reports another version, `compose.dev.shared.yaml` changed:
run `shared up --recreate` once nothing is busy. Data stays in the
`kiln-dev-mysql` volume.

### Connecting

`pnpm dev:docker:shared status` prints each stack's database. Its user has the
same hash with a `u_` prefix, and its password is `DB_PASSWORD` in `.env`. A
client on the host connects to `127.0.0.1:3307` as that user, or as `root` with
password `kiln-root`. For a shell:

```sh
docker exec -it -e MYSQL_PWD=kiln-root kiln-dev-mysql mysql -uroot
docker exec -it kiln-dev-cache valkey-cli
```

Valkey isn't published to the host and keeps nothing across restarts. It holds
up to 256 MiB and evicts the least recently used keys, which Hearth treats as
misses. A stack's keys start with `kiln:hearth:v1:<digest>:`; list a namespace
with `valkey-cli --scan --pattern 'kiln:hearth:v1:*'`.

### Slices

Development containers belong in the box's memory budget. Docker's own
`cgroup-parent` setting is the way to get them there, because it also covers
the containers a Relay creates:

```ini
# /etc/systemd/system/dockerbudget.slice
[Unit]
Description=Shared Docker daemon and container memory budget

[Slice]
MemoryAccounting=yes
MemoryHigh=7G
MemoryMax=8G
MemorySwapMax=1G
```

```json
{ "cgroup-parent": "dockerbudget.slice" }
```

Put the second in `/etc/docker/daemon.json`, then restart Docker, which stops
every container on the box. Without that restart, set
`KILN_DEV_CGROUP_PARENT=dockerbudget.slice` in your shell to place the shared
services, Hearth and the Relay, but not what the Relay creates.

`dev:docker:up` warns when a container lands outside the slice, and `shared
status` shows where each service runs.

## Tailnet S3

One [RustFS](https://rustfs.com) serves development backups for every box, with
a real certificate through Tailscale Serve. It runs on S02, at
`https://s02.tail3e4733.ts.net:8480`, keeping its data on `/archive`. Tailnet
peers reach it directly. Containers on S02 can't reach Serve, so they go through
a small forwarder on Docker's gateway address, and `dev:docker` picks that route
for itself. Any container on S02 can reach the forwarder, so the endpoint's
credentials are what protect it there.

To use it from a box, add the settings to the primary checkout's `.env`, then
run `pnpm dev:docker:down` and `pnpm dev:docker:up` in each stack, since
`refresh` doesn't change a container's hosts. Get them on S02 with `pnpm dev:docker:s3 env`, and add the
box's name as a prefix, since stack names repeat between boxes:

```sh
KILN_DEV_S3_ENDPOINT=https://s02.tail3e4733.ts.net:8480
KILN_DEV_S3_BUCKET=kiln-dev
KILN_DEV_S3_ACCESS_KEY=...
KILN_DEV_S3_SECRET_KEY=...
KILN_DEV_S3_PREFIX=s01
```

Then, as a platform administrator, add a destination in Hearth with the same
values and these settings:

| Field                | Value                             |
| -------------------- | --------------------------------- |
| Endpoint             | `KILN_DEV_S3_ENDPOINT`            |
| Region               | `us-east-1`                       |
| Bucket               | `kiln-dev`                        |
| Object prefix        | `KILN_DEV_S3_PREFIX`              |
| Path-style URLs      | On                                |
| Private network      | On: tailnet addresses are private |
| Platform destination | On: Kiln's own backups need it    |

Backups land under `<prefix>/kiln/<stack>/`, which `dev:docker:destroy` deletes.

To run the endpoint on a box, or move it:

```sh
KILN_DEV_S3_DATA=/archive/kiln-dev-s3 pnpm dev:docker:s3 up
```

This needs Tailscale with HTTPS on, and the account as a Tailscale operator. It
generates credentials on first run and keeps them, with the data location, in
`~/.config/kiln-dev/s3.env`. `KILN_DEV_S3_DATA` defaults to a Docker volume.
`dev:docker:s3 status` and `dev:docker:s3 down` report and stop it; its data
stays.

## Verification

Before pushing, run the same checks as CI:

```sh
pnpm verify
```

`pnpm verify` runs the four **Code checks** stages in order and stops on the
first failure. CI runs those same stages in separate jobs. The command uses
the box's shared MySQL for Hearth tests, starting it if needed, and never
silently skips database tests. Tests run as the stack's own user, in databases
only it can reach, so stacks' runs can't touch each other's data. Two full runs
at once can still time out on a small box, for lack of CPU.

| Command              | Checks                                                |
| -------------------- | ----------------------------------------------------- |
| `pnpm verify static` | All package typechecks and `vp check`                 |
| `pnpm verify tests`  | Non-Hearth package tests and repository tooling tests |
| `pnpm verify hearth` | Hearth tests, including the real-MySQL suites         |
| `pnpm verify build`  | All package builds and the generated route tree diff  |

Use individual stages and targeted tests while iterating. For example,
`pnpm dev:docker:test src/server/auth-coverage.test.ts` and
`pnpm verify hearth src/server/auth-coverage.test.ts` both use the shared
Hearth stage. Validate user-visible changes in the browser.

To use a disposable MySQL outside the dev stack, set `KILN_TEST_MYSQL=1`
and `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USERNAME`, and `DB_PASSWORD`.
`DB_NAME` must end in `_test`; the test runner creates per-worker databases.
CI supplies these variables for its MySQL container, and runs the same suite
on MariaDB, which some installations use for Hearth. Point these variables at a
`mariadb:11.8` container to check a query there.

The build stage writes to `artifacts/verify/build.log`, then prints the log
and returns the build's exit status. This avoids Vite+ output-forwarding
errors on long asset lists. A successful build also requires
`apps/web/src/routeTree.gen.ts` to match the checked-in version.

Native CLI platform checks and container-image builds remain separate CI
workflows; `pnpm verify` covers the Code checks workflow.

`vp run typecheck` uses the pinned tsrs compiler with two checkers per package
and checks packages one at a time to leave resources for parallel work. Package
tasks remain cached by Vite+; use `vp run --filter web typecheck` for Hearth-only
work. tsrs is experimental and follows TypeScript 7; keep its exact version
pinned and validate upgrades against the package checks. TypeScript remains
installed for editor support and declaration builds. If tsrs cannot start (for
example on Windows or Intel macOS), the task falls back to Vite+'s built-in
typechecker, without formatting or linting. A type error from an available tsrs
compiler fails the task directly; it never triggers the fallback. Ordinary
`vp check` still runs type-aware lint rules without a second compiler check.

## Marketing site

`apps/marketing` is the public site at kiln.site, a separate TanStack Start app
with no database or Relay. It needs no Docker stack:

```sh
pnpm --filter marketing dev
```

It serves `http://localhost:3100`. `KILN_HEARTH_URL` (default
`https://panel.kiln.site`) is where Log in, Sign up, and plan buttons point, and
`KILN_DOCS_URL` (default `https://docs.kiln.site`) is where docs links point,
and `KILN_SITE_URL` (default `https://kiln.site`) is the site's own address for
canonical links and link previews. All three are read when the site serves a
request, not at build time. `robots.txt`, `sitemap.xml`, and `llms.txt` in
`apps/marketing/public` name `https://kiln.site` directly.

Optional Umami tracking uses two runtime environment variables on the marketing
app (see `.env.marketing.example`):

```sh
KILN_WEB_ANALYTICS_URL=https://stats.example.com/script.js
KILN_WEB_ANALYTICS_WEBSITE_ID=your-umami-website-id
```

Use the full tracker script URL from Umami's website settings, including any
custom `TRACKER_SCRIPT_NAME`, and that website's ID. Both values are public.
The script loads with `defer` and Umami tracks client-side page navigations
automatically. Leaving either variable unset disables tracking; invalid or
non-HTTP(S) URLs also disable it. No rebuild is needed when changing these
variables; restart the marketing app. Umami's database URL and authentication
secrets belong on the Umami app, not the marketing app.

`/install` serves `apps/marketing/install.sh` as plain text, for
`curl -fsSL https://kiln.site/install | sh` (see [Self-hosting](self-hosting.md)).
It's bundled when the site builds, so kiln.site serves the script from the
commit it deployed. Edit it there; the Marketing image workflow already runs for
changes under `apps/marketing`.

The site serves the Terms of Use and Privacy Policy at `/terms` and `/privacy`.
Hearth's footer links to them, and Hearth's own `/terms` and `/privacy`
redirect there, on any panel running Kiln's official images, since those send
QuartzDev telemetry. A fork's panel (one whose repository, `KILN_GIT_REPO` or the
one built into its image, isn't `kiln-site/kiln`) links to `/forks-legal`
instead: an unindexed page saying Kiln doesn't run that panel, with `from` set
to the panel's `KILN_URL`. `KILN_MARKETING_URL` overrides both with another
site's `/terms` and `/privacy`. Choosing a
paid plan opens Hearth's sign-up with `plan` and `interval` parameters and a
`redirect` to `/settings/billing` carrying the same choice.

Its console and editor demos render Hearth's own components from
`apps/web/src`, which the site resolves through the `@/` alias; site code uses
`~/`. Build with `vp run marketing#build` and serve with
`pnpm --filter marketing start`.

The **Marketing image** workflow builds `ghcr.io/kiln-site/marketing` on PRs
that touch the site or the Hearth code it renders, and publishes `latest` and
`sha-<commit>` from `main` when the `PUBLISH_IMAGES` variable is `true`. It
isn't part of a Kiln release, so self-hosted installs never pull it. The image
listens on port 3000 and takes the same three URLs:

```sh
docker run -p 3000:3000 -e KILN_HEARTH_URL=https://panel.kiln.site \
  ghcr.io/kiln-site/marketing:latest
```

The first publish creates the GHCR package as private. Make it public in the
package's settings, as with the other images (see [Forking](forking.md)). Run
the workflow by hand to publish without a change.

## Pull requests

See [Contributing](../CONTRIBUTING.md) for branch names, PR titles and
descriptions.

## Cleanup

After merge, run `pnpm dev:docker:destroy` before removing the worktree and
merged branches, then update `main` with `git pull --ff-only`.

| Layer                  | Removed by `dev:docker:destroy`               |
| ---------------------- | --------------------------------------------- |
| Hearth and Relay       | Containers, Compose networks and volumes      |
| What the Relay created | Containers, networks and volumes it owns      |
| Shared MySQL           | The stack's database, test databases and user |
| Shared Valkey          | The stack's keys                              |
| S3 endpoint            | Backups under `<prefix>/kiln/<stack>/`        |
| Registry               | The stack's row, last                         |

Destroy stops the stack's writers first and clears its registry row last. If a
step fails it says so and exits non-zero; run it again to finish. A stack being
destroyed can't start. Destroy stops before deleting anything when it can't read
the registry, and it deletes only names the registry records and Docker
resources carrying the stack's labels.

| Situation                  | What to do                                |
| -------------------------- | ----------------------------------------- |
| Finished worktree          | `pnpm dev:docker:destroy`, then remove it |
| Keep data, free memory     | `pnpm dev:docker:down`                    |
| Worktree already removed   | `pnpm dev:docker:shared remove <stack>`   |
| Primary checkout           | `pnpm dev:docker:down`                    |
| Reset the primary checkout | `pnpm dev:docker:destroy --primary`       |
| No stacks left on the box  | `pnpm dev:docker:shared destroy`          |

`shared remove` refuses while the checkout exists or the stack's containers do.
Destroy refuses the primary checkout's unscoped Relay resources. `--primary`
deletes its data but not those resources, and refuses while any unscoped
workload exists, since it might need that Relay to manage it or belong to
another Relay on the box.

A stack from before shared services has its own MySQL, which this revision
can't run. Starting one stops with a message: `pnpm dev:docker:destroy` deletes
it and its data, including that MySQL. To keep the data, stay on an older
revision. Stacks on older revisions keep running as they are.
