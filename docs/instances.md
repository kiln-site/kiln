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

A Tailscale network is an **instance group**. The group has an instance ID,
and so does each installation of it on a Relay. Shared actions act on one
installation on one Relay; the group's page shows them together and sends an
action to each. Today a network has one ID that every Relay's node shares.

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

## Bricks

Today a Brick is a `kiln.brick/v1` recipe for a game server
(`apps/bricks/docs/recipe-v1.md`). The target is that every kind except a
Relay comes from a Brick, in a new format:

- **`kind`**: game server, database, App or Tailscale. Each kind has a
  section of its own in the recipe.
- **`type`**, optional, within a kind. A Brick with no type runs with the
  foundation and nothing more. A type such as `minecraft` or `postgres`
  unlocks extras Kiln implements, and the recipe says which it uses and
  supplies their data.
- **Several services** in one Brick.
- **An icon** that is an SVG mark or a full image, shown in the Brick menu
  and as the instance's default icon.
- **Apps** come from catalog Bricks, a Docker image Brick, or a GitHub Brick.

The v1 format is retired rather than kept beside the new one. Copies already
stored (a Relay's snapshots, Hearth's catalogs, backup manifests) are
converted when read.

The code decides by a Brick's ID or a game's name in places a recipe should
decide: `brickId === "tailscale"` stands in for a kind, and Velocity's
version lookup, Java selection, console completion, the Minecraft status
check, SRV records and the picker's grouping stand in for a type.

## Order of work

1. Kill on every instance, with one rule for stopped and failed. Done.
2. One power permission for every kind. Done.
3. Remove unused Relay requests and checks for older Relays.
4. The new Brick format, with the v1 converter and the official recipes.
5. `kind` and `type` in place of the Brick ID and game name checks.
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
