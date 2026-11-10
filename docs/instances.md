# Instances

An instance is anything Kiln runs: a Relay, a game server, a database, an App,
or a Tailscale network. Each has one ID (see [Instance IDs](instance-ids.md)).

Kiln is moving every kind onto one foundation. What every kind has is built
once, as an instance feature; a kind adds only what is unique to it. Much of
the code predates this and has a copy of the same feature per kind. This page
says where the foundation stands, what the target is, and the order of the
work. Update it as each step lands.

## Kinds

| Kind        | Comes from       | Notes                                               |
| ----------- | ---------------- | --------------------------------------------------- |
| Relay       | The installer    | The host node. An instance, but never from a Brick. |
| Game server | A Brick          | Called `instance` in permissions and the protocol.  |
| Database    | A Brick (target) | Today a fixed list of engines in code.              |
| App         | A Brick (target) | Today a source the person supplies.                 |
| Tailscale   | A Brick (target) | Today a built-in Brick that runs as a game server.  |

A Tailscale network is an [instance group](#instance-groups). The group has
an instance ID, and so does each installation of it on a Relay. Shared
actions act on one installation on one Relay; the group's page shows them
together and sends an action to each. Today a network has one ID that every
Relay's node shares.

## The foundation

Every kind gets these from the platform.

| Capability  | Target                                          | Today                                                                                   |
| ----------- | ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| Power       | Start, stop, restart and kill, for every kind   | Done for game servers, databases and Apps: one Relay request and one permission         |
| Deployments | One redeploy for every kind                     | An App's redeploy and a game server's Brick reinstall are separate; databases have none |
| Domains     | Every kind, automatic for an App's web services | Game servers only                                                                       |
| Networking  | One page for every kind                         | A page per kind, on a few shared sections                                               |
| Files       | One file browser and one permission             | Done for game servers and Apps                                                          |
| Info page   | One page shell                                  | A page per kind, on a shared shell                                                      |

A Relay implements each in its own way: it can only be restarted, its
deployments are its updates, and its files are the host's.

Sharing a console, logs or a file is planned as a foundation feature of
Kiln's own, replacing the mclo.gs upload game servers have now.

## What a kind adds

- **Game server**: a console in place of logs.
- **Database**: the viewer in place of files, and import and export. An
  engine without a viewer has neither a viewer nor files.
- **App**: volumes, and its source.
- **Tailscale**: networking spread across Relays, shown as one group.

## Permissions

- What every kind has takes one `instance.*` permission. Only what one kind
  alone has keeps that kind's name.
- A grant on a Relay reaches every instance on it. A grant on one instance
  stays on it.
- A Relay's own host keeps `relay.*`: its files and its shell are the
  machine's.

Files and power follow this now. `instance.files.*` is a game server's
files on that game server, and every game server's and App's on a Relay.
`instance.power.*` is the power of a game server or database it is granted
on, and of every game server, database and App on a Relay; an App's power
is no longer part of `app.manage`. See [Access control](access-control.md).

In the catalog (`packages/contracts/src/access-permissions.ts`) these are
the `every` family, and `everyInstanceBlocks` says where each can be granted
and which kinds it reaches from a Relay. A capability that moves gets an
entry there.

## How a shared capability is built

Two patterns are in place. Follow them when a capability moves.

- **One Relay request that names the kind.** `instance.action` and
  `resource.freeze` take `{ kind, id, ... }` rather than one request per
  kind. The Relay picks the permission and the work from the same `kind`.
- **One place that picks the permission, on each side.** Hearth has
  `fileRootPermission` and `instancePowerPermission`; the Relay has
  `fileRootAction` and `powerAction`. Callers say what they want to do and
  never choose a key themselves, so merging keys later changes one function
  and migrates stored grants.

A capability usually moves in two steps: first onto one path with no key
change, then onto one permission with a migration on Hearth and on each
Relay.

## Instance groups

A group keeps instances together: an ID, a name, an icon, and members of any
kind on any Relay. It is its own record, not a feature of one kind:

- A Brick can create one, for an App that comes with a database of its own.
- A person can make one.
- Kiln makes one for a Tailscale network, placing an installation on each
  Relay that needs it, and for its own services (a Relay, Hearth, its cache
  and its database), which people can't edit.

Groups don't exist yet. The Brick format already describes one.

## Bricks

Every kind except a Relay comes from a Brick. Three things stay separate:

- **The Brick** is the recipe: one instance, or a group of them.
- **The source** is where its files come from: an image, a Git repository
  from a connected [source](github-sync.md), or an upload. It is chosen at
  install, so GitHub is a source and never a kind of Brick. Picking a
  repository installs the Kiln file in it, or else the generic Dockerfile or
  Compose Brick.
- **The Kiln file** is a Brick with settings, kept in a repository: volumes,
  domains, limits, backups, schedules. Applied once at import, or tied so
  that Git stays the source of truth. Not built; the format reserves
  `settings` for it.

`kiln.brick/v2` (`apps/bricks/docs/brick-v2.md`) is the format:

- **`kind`**: game server, database, App or group. Each has a section of its
  own.
- **`type`**, optional, within a kind. A Brick with no type runs with the
  foundation and nothing more. A type such as `minecraft` or `postgres`
  unlocks extras Kiln implements, and the Brick says which it uses.
- **`inputs`**, the install form, where `suggest` lets one default follow
  another answer.
- **`deploy`**: an image, a Dockerfile, or a Compose project for an App with
  several containers.
- **An icon** that is an SVG mark or a full image.

Only what Kiln runs is settled. The format's database, App and group parts
are provisional until steps 7, 8 and 11 run them against what Kiln does
today: a database's separate administrator login, password rotation and
per-engine setup, and a group's install order, partial failure and deletion.

A database that an App needs should be a member of a group, not a container
in its Compose project: only then is it a database to Kiln, with the viewer,
dumps, backups and permissions one has.

The v1 format is retired, not kept beside v2. Copies already stored (a
Relay's snapshots, Hearth's catalogs, backup manifests) are converted when
read, through `readBrickRecipe` in the contracts, which is the only code
that knows v1. Game servers are the kind installed from a Brick so far.

An instance carries what its Brick says it is: `brickKind` and `brickType`,
from the `kiln.brick.kind` and `kiln.brick.type` labels on its container.
Whatever depends on what an instance is reads those. The older
`kiln.brick.network-mode` label is still written, for backups and for
containers made before the type was; one of those is read as `minecraft`
when its network mode is `minecraft-backend`.

One thing is still told apart by its Brick's ID: a Tailscale node, which a
Relay runs as a game server until Tailscale is a kind of its own. Everything
that asks goes through `isTailscaleNode` in the contracts, so that step
changes one function. The Brick picker also still guesses its "Steam"
category from a tag or an image name.

Tied settings have four things to settle before they are built: secrets stay
in Hearth and the file only names them; a push acts with the authority of
whoever linked the repository, checked again each time; removing a database
or a volume from the file detaches it and never deletes data; and a push
that can't be applied leaves the last good state.

## Order of work

1. Kill on every instance, with one rule for stopped and failed. Done.
2. One power permission for every kind. Done.
3. Remove unused Relay requests and checks for older Relays. Done for four
   requests and the resource limit checks; other checks for older Relays go
   as their code is touched.
4. The new Brick format, with the v1 converter and the official recipes.
   Done for game servers: Hearth and Relays read `kiln.brick/v2`, and
   convert v1 where it is stored.
5. `kind` and `type` in place of the Brick ID and game name checks. Done:
   an instance says its kind and type, and console completion is something
   a Brick declares.
6. One redeploy for game servers and Apps.
7. Databases as Bricks.
8. Apps as Bricks.
9. Domains for every kind.
10. One instance page, with each kind's own tabs.
11. Tailscale as its own kind, with the instance group.
12. One terminal path.
13. One log path.

The CLI is reworked after this, and isn't changed along the way beyond what
keeps it working.
