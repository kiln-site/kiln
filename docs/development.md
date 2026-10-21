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

## Access and worktrees

Standard Docker uses `http://localhost:3000`, with MySQL on port 3306 and SFTP
on port 2022. All published ports bind to loopback. OrbStack is detected
automatically and uses HTTPS container domains instead of fixed host ports.
Override detection with `KILN_DEV_NETWORK=localhost` or `orbstack`.

The primary checkout uses project `kiln`. Linked worktrees use the branch name:
`chore/repo-cleanup` becomes `kiln-repo-cleanup`, with the OrbStack URL
`https://kiln-repo-cleanup.orb.local`. The name is saved on first start so
branch switches keep the same stack and data. Set `KILN_DEV_PROJECT` before
first start to choose a different name; keep names unique across checkouts.

For concurrent stacks without OrbStack, choose free host ports:

```sh
KILN_DEV_WEB_PORT=3001 KILN_DEV_MYSQL_PORT=3307 KILN_DEV_SFTP_PORT=2023 pnpm dev:docker:up
```

Set overrides in your shell, not the shared `.env`, and keep them set for
subsequent commands. Use a fresh project when changing network modes because
paired Relays retain their endpoints. Game server port allocations also need
to be unique across running stacks.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev:docker` | Start and follow Hearth logs |
| `pnpm dev:docker:up` | Start in the background and wait until healthy |
| `pnpm dev:docker:logs` | Follow Hearth and Relay logs |
| `pnpm dev:docker:refresh` | Restart Relay and Hearth |
| `pnpm dev:docker:down` | Stop, preserving data |
| `pnpm dev:docker:destroy` | Delete a worktree's stack, data, and Relay resources |
| `pnpm dev:docker:test` | Run web tests against the stack's MySQL |

Run relevant checks with `vp check`, `vp run -r typecheck`, or targeted
`vp test run` suites. Validate user-visible changes in the browser.

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
`apps/marketing/public` name `https://kiln.site` directly. Choosing a
paid plan opens Hearth's sign-up with `plan` and `interval` parameters and a
`redirect` to `/settings/billing` carrying the same choice.

Its console and editor demos render Hearth's own components from
`apps/web/src`, which the site resolves through the `@/` alias; site code uses
`~/`. Build with `vp run marketing#build` and serve with
`pnpm --filter marketing start`.

The **Marketing image** workflow builds `ghcr.io/kiln-site/marketing` on PRs
that touch the site or the Hearth code it renders, and publishes `latest` and
`sha-<commit>` from `main`. It isn't part of a Kiln release, so self-hosted
installs never pull it. The image listens on port 3000 and takes the same two
URLs:

```sh
docker run -p 3000:3000 -e KILN_HEARTH_URL=https://panel.kiln.site \
  ghcr.io/kiln-site/marketing:latest
```

The first publish creates the GHCR package as private. Make it public in the
package's settings, as with the other images (see [Forking](forking.md)). Run
the workflow by hand to publish without a change.

## PR titles

Use `<type>(<scope>): <short human title>`. Examples:

- fix(relay): prevent player disconnects when updating relays
- ci(repo): update agent skills
- ui(cli): improve help menu visual

See [Contributing](../CONTRIBUTING.md) for the other PR conventions.

## Existing stacks and cleanup

The new `kiln-*` names create fresh stacks; old `hearth*` data is preserved.
Before updating an existing checkout, stop its stack with the old script's
`dev:docker:down`, or use `dev:docker:destroy` for a disposable worktree.

After merge, run `pnpm dev:docker:destroy` before removing the worktree and
merged branches, then update `main` with `git pull --ff-only`. Destroy refuses
to remove the primary checkout's unscoped Relay resources; use `down` there.
