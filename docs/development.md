# Development

## Prerequisites and setup

Use the Node version in `.node-version`, pnpm (version in `package.json`),
[Vite+](https://viteplus.dev), Git, and Docker with Compose v2.24.4 or newer
(`!override` support). Use Linux containers; Docker Engine on Linux and Docker
Desktop (macOS or Windows via WSL2) are suitable. OrbStack on macOS is optional.
The Relay needs access to the Docker socket and the Docker host's filesystem; with a VM-based engine,
that filesystem is the VM's, not your desktop's. Remote Docker engines are not
supported by this bind-mounted dev stack.

From the repository root:

```sh
vp install --frozen-lockfile
pnpm dev:setup
pnpm dev:docker
```

`dev:setup` creates `.env` in the primary checkout from `.env.hearth.example`,
fills missing secrets, and creates the shared `kiln-dev-pnpm-store` Docker
volume. Run it once per clone; linked worktrees share that `.env`. It preserves
existing values. Keep secrets out of Git.

The stack runs Hearth and Relay from source with live reload, plus MySQL,
Valkey, and a local TLS MinIO backup target. Each project has its own data and
dependency volumes; only the pnpm download store is shared. Dependency
volumes start empty so Docker never copies host binaries into Linux containers.
No production Compose configuration needs changing.

## Browser access

Open the Hearth URL printed at startup. The script detects OrbStack from the
active Docker engine, rather than the host OS:

- Standard Docker: `http://localhost:3000`. Browser connections to Relay go
  through Hearth's existing proxy; Relay uses managed TLS on the private
  Compose network. MySQL is at `127.0.0.1:3306` and SFTP at `localhost:2022`.
  Published ports bind to loopback only.
- OrbStack: `https://<project>.orb.local`, with Relay at
  `https://relay.<project>.orb.local`. OrbStack handles browser HTTPS and DNS;
  the stack does not publish fixed host ports. Enable OrbStack's container
  domains and trust its local CA if prompted. See
  [OrbStack domain settings](https://docs.orbstack.dev/docker/domains).

Set `KILN_DEV_NETWORK=localhost` or `KILN_DEV_NETWORK=orbstack` to override
automatic detection; the default is `auto`. These are environment variables
for the script, not settings in the shared `.env`. For example:

```sh
KILN_DEV_NETWORK=localhost pnpm dev:docker:up
```

Use the same network setting for subsequent commands. Stop the stack before
switching modes. Existing paired Relays keep their stored endpoints and proxy
settings; use a fresh project when testing a different network mode.

## Project names and worktrees

The primary checkout uses `kiln`. A linked worktree uses its branch name,
dropping the first slash-separated prefix and normalizing it for Docker/DNS:
`chore/repo-cleanup` becomes `kiln-repo-cleanup`, with a panel URL of
`https://kiln-repo-cleanup.orb.local` on OrbStack. Detached worktrees use
`kiln-detached-<commit>`.

The first start saves the project name in that worktree's Git metadata
(`git rev-parse --git-path kiln-dev-project`). Branch switches then keep the
same stack and data, and `down`/`destroy` still target the original project.
Before the first start, set `KILN_DEV_PROJECT=kiln-my-name` for a custom name.
Use a unique name for branches that normalize alike or multiple clones using
the same Docker engine. The script refuses to operate on a Compose project
whose containers belong to another checkout.

For concurrent worktrees on standard Docker, give each stack free host ports:

```sh
KILN_DEV_WEB_PORT=3001 KILN_DEV_MYSQL_PORT=3307 KILN_DEV_SFTP_PORT=2023 pnpm dev:docker:up
```

Keep these variables set for subsequent commands, especially `url` and `test`.
OrbStack stacks do not need separate host ports. Game server ports still share
the Docker host, so choose non-overlapping allocations when testing multiple
Relays.

### Existing development stacks

The old names were `hearth` and `hearth-<worktree-directory>-<hash>`. The new
names create fresh projects; old data is **not** migrated or deleted. Before
updating an existing checkout, use its old script's `dev:docker:down` (or
`dev:docker:destroy` in a disposable worktree). `docker compose ls --all`
helps locate leftover projects. Keep any data you need before removing old
volumes.

To deliberately rename a new stack, stop it first, remove only its
`kiln-dev-project` metadata file, then start with `KILN_DEV_PROJECT` set. That
creates a fresh stack and leaves the previous project's volumes intact.

## Commands and validation

| Command                   | Purpose                                                        |
| ------------------------- | -------------------------------------------------------------- |
| `pnpm dev:docker`         | Start and follow Hearth logs                                   |
| `pnpm dev:docker:up`      | Start in the background and wait for health checks             |
| `pnpm dev:docker:url`     | Print this stack's Hearth URL                                  |
| `pnpm dev:docker:logs`    | Follow Hearth and Relay logs                                   |
| `pnpm dev:docker:refresh` | Restart Relay/Hearth, or start missing services                |
| `pnpm dev:docker:down`    | Stop the stack, preserving volumes                             |
| `pnpm dev:docker:destroy` | Delete a linked worktree's stack, volumes, and Relay resources |
| `pnpm dev:docker:list`    | List Compose projects                                          |
| `pnpm dev:docker:test`    | Run web tests against this stack's real MySQL                  |

`destroy` refuses to remove the primary checkout's unscoped Relay resources.
Use `down` there and remove data deliberately if needed. The shared pnpm store
is not removed by `destroy`.

Validate user-visible changes in the browser at the printed URL. Agents should
use T3 Code's collaborative Preview when available. Repo tooling and docs
changes need only the relevant checks; run `vp check`, `vp run -r typecheck`,
or targeted `vp test run` suites as appropriate. Web database suites require
the running dev stack (`pnpm dev:docker:test`).

After a PR merges, stop and remove its disposable dev stack with
`pnpm dev:docker:destroy` **before** deleting the worktree. Update `main` with
`git pull --ff-only`, then remove the merged worktree and local branch and
delete its remote branch if it still exists. Do not delete the primary
checkout.
