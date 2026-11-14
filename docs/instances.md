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
| Database    | A Brick          | One of Kiln's own, of an engine Kiln knows.         |
| App         | A Brick          | One of Kiln's own, for what it deploys.             |
| Tailscale   | A Brick (target) | Today a built-in Brick that runs as a game server.  |

A Tailscale network is an [instance group](#instance-groups). The group has
an instance ID, and so does each installation of it on a Relay. Shared
actions act on one installation on one Relay; the group's page shows them
together and sends an action to each. Today a network has one ID that every
Relay's node shares.

## The foundation

Every kind gets these from the platform.

| Capability  | Target                                          | Today                                                                                                                |
| ----------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Power       | Start, stop, restart and kill, for every kind   | Done for game servers, databases and Apps: one Relay request and one permission                                      |
| Deployments | One redeploy for every kind                     | Done for game servers, databases and Apps: one Relay request and one permission                                      |
| Limits      | One request and one permission for every kind   | Done for game servers, databases and Apps: one Relay request and one permission                                      |
| Domains     | Every kind, automatic for an App's web services | One table of addresses, one reconcile and one Domains table for game servers and Apps; a database has no address yet |
| Networking  | One page for every kind                         | A page per kind, on a few shared sections                                                                            |
| Files       | One file browser and one permission             | Done for game servers and Apps                                                                                       |
| Info page   | One page shell                                  | One profile and container section for every kind; a Relay's page is its own                                          |

A Relay implements each in its own way: it can only be restarted, its
deployments are its updates, and its files are the host's.

Sharing a console, logs or a file is planned as a foundation feature of
Kiln's own, replacing the mclo.gs upload game servers have now.

## What a kind adds

- **Game server**: a console for its output. Its Logs page lists its
  deployments, as a database's and an App's do beside their output.
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

Files, power, deploying, resource limits and saving web routes follow this now. `instance.files.*` is a game
server's files on that game server, and every game server's and App's on a
Relay.
`instance.power.*` is the power of a game server or database it is granted
on, and of every game server, database and App on a Relay; an App's power
is no longer part of `app.manage`. `instance.deploy` deploys again what it
is granted on, and everything on a Relay; it is no longer part of
`app.manage`, nor of changing a game server's configuration.
`instance.limits.write` changes the limits of what it is granted on, and
of everything on a Relay; a database's no longer has a permission of its
own, and an App's is no longer part of `app.manage`.
`instance.network.write` saves the web routes of a game server it is
granted on, and of every game server and App on a Relay; an App's is no
longer part of `app.manage`. See [Access control](access-control.md).

In the catalog (`packages/contracts/src/access-permissions.ts`) these are
the `every` family, and `everyInstanceBlocks` says where each can be granted
and which kinds it reaches from a Relay. A capability that moves gets an
entry there.

## How a shared capability is built

Two patterns are in place. Follow them when a capability moves.

- **One Relay request that names the kind.** `instance.action`,
  `instance.deploy`, `instance.limits.write`, `instance.image.check` and
  `resource.freeze` take `{ kind, id, ... }` rather
  than one request per kind. The Relay picks the permission and the work
  from the same `kind`.
- **One place that picks the permission, on each side.** Hearth has
  `fileRootPermission` and `instancePowerPermission`; the Relay has
  `fileRootAction`, `powerAction` and `deployAction`. Callers say what they want to do and
  never choose a key themselves, so merging keys later changes one function
  and migrates stored grants.

A capability usually moves in two steps: first onto one path with no key
change, then onto one permission with a migration on Hearth and on each
Relay.

Updates follow the same shape with one more piece, for a newer image and
for a newer revision of an instance's Brick alike. Checking, recording,
notifying and waiting are the same for every kind; what differs (which
instances check, and how one takes an update) is one adapter per kind in
`apps/web/src/lib/instance-update-kinds.server.ts`. See
[Instance updates](instance-updates.md).

## Instance groups

A group keeps instances together: an ID, a name, an icon, and members of any
kind on any Relay. It is its own record, not a feature of one kind:

- A Brick can create one, for an App that comes with a database of its own.
- A person can make one.
- Kiln makes one for a Tailscale network, placing an installation on each
  Relay that needs it, and for its own services (a Relay, Hearth, its cache
  and its database), which people can't edit.

The record is built (`apps/web/src/effect/instance-groups.ts`): a group has
an ID of its own in the instance directory, an instance is in one group at
most, and a group goes when its last member does. Deleting an instance, or
removing its Relay, takes it out of its group.

A Brick makes one today, and only that:

- Installing a group Brick (`createInstanceGroupFor`) makes its databases,
  then its Apps connected to them, each with the variables the Brick's
  `connect` gives it for reaching a database, and keeps them as a group. It
  takes the permission making each member alone does. A member that can't
  be made ends it; what was made before it stays, in the group.
- A group has no people of its own. Someone sees the members they may read,
  and may delete the group when they may delete every member.
- New Backup lists a group as a row that ticks what its members keep
  (`getInstanceGroups`): each is still a backup of its own, and the group
  is never backed up itself. See [Backups](backups.md).
- A member's Info page says which group it is part of, lists the rest, and
  deletes the group from there: the members checked are deleted with it, the
  others stay in no group.

A group a Brick made keeps the Brick, its answers, and which of the Brick's
members each instance is, so its Apps can be made again from a newer
revision ([Instance updates](instance-updates.md#brick-revisions)). What an
App was given to reach its database is written at install and again when
the App takes a revision of its Brick; it doesn't follow a password rotated
in between.

Still to come: a group's page, a group someone makes by hand, an icon,
members on more than one Relay, and the groups Kiln makes itself, for a
Tailscale network and for its own services.

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

Only what Kiln runs is settled. The format's App and group parts are
provisional until steps 8 and 11 run them against what Kiln does today: a
group's install order, partial failure and deletion.

A database is created from a database Brick whose `type` is an engine Kiln
knows (`postgres`, `mysql`, `mariadb`, `redis`, `valkey`). The Brick says
what runs: the image, with the version as an input, the data volume, the
port, the start command and how to tell it is ready. Kiln supplies the
database's name, username and password to its templates. What Kiln does to
a database after that is the type's, not the Brick's: its login, password
rotation, dumps and the viewer. That relies on how the Brick runs it (the
image, its port, the variables it takes its login from), so for now only
the database Bricks of Kiln's own catalog are offered and accepted, and the
Relay refuses one that doesn't run as its type does. A database made before
databases ran Bricks is read as its engine's official Brick, and nothing
about its container or data changes.

A database that an App needs should be a member of a group, not a container
in its Compose project: only then is it a database to Kiln, with the viewer,
dumps, backups and permissions one has.

The v1 format is retired, not kept beside v2. Copies already stored (a
Relay's snapshots, Hearth's catalogs, backup manifests) are converted when
read, through `readBrickRecipe` in the contracts, which is the only code
that knows v1. Game servers, databases and Apps are installed from a Brick.

An App is installed from an App Brick, which says what it deploys: an
image, or a Dockerfile or a Compose file. The Brick carries that file,
written in its recipe or kept beside it, or names one in a source chosen
at install, which is a repository or a file written in Hearth. Kiln's catalog
has one for each (`docker-image`, `dockerfile`, `compose`). An App Brick is
offered and accepted from any catalog whoever installs it sees: Kiln's own,
one they added, or one published to everyone
(`apps/web/src/server/visible-bricks.server.ts`). Hearth keeps an App's configuration, so
Hearth turns the Brick and its answers into it
(`appBrickDeploy` in the contracts) and the Relay deploys that
configuration as it always has. An App made from one of those generic
Bricks keeps no Brick: it is read as the one for what it deploys, as are
Apps made before Apps ran Bricks, and nothing about their containers
changed. An App made from any other Brick, alone or in a group, keeps the
Brick, its revision and its answers, follows it, and can be detached from
it ([Instance updates](instance-updates.md#which-apps-follow-a-brick)). A
Brick sets an App's image, or the file it carries, and its variables, and
Kiln makes the secrets it asks for. The folders it keeps are each on a Kiln volume, made with the
App and mounted before its first deployment. Its `ready` command is its
container's health check, which a deployment waits on. Its `command` is the
App's start command, and its public ports are published on its Relay.
A Brick goes by its ID after whose it is (`billy:paper`), from where its
recipe is kept; Kiln's own go by their ID alone
(`brickReference` in the contracts). An App or a group is also installed
from a custom Brick, a recipe at a link of its own that its owner saved, as
a game server is: whoever would run a recipe reads it, a Relay for a game
server's and Hearth for the rest (`loadBrickSource`).

Adding any of them opens the same dialog (`AddInstanceDialogHost`): pick
the kind, pick its Brick, then answer what that kind asks. Each page's Add
button opens it on its own kind. Everything about browsing Bricks is shared;
a kind adds one row to `brickKindPresentations`
(`apps/web/src/components/brick-kinds.ts`) for its categories and labels,
and one pane for what it asks before creating. A game server asks a name
and a Relay, and its Brick's inputs are answered on its Startup page; a
database answers its Brick's inputs there, since its version is chosen
once; an App answers its Brick's inputs there too, and where a Brick that
builds a file finds it.

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

### What other formats have that Bricks don't yet

Read against Pterodactyl's and Pelican's eggs, Coolify's Compose services and
Railpack, before v2 was merged. None of it changed the format; each is an
addition for the step that needs it.

- **Values Kiln supplies to a template**: the port it allocated, the public
  host, a URL. Eggs have `{{server.build.default.port}}`; Coolify has
  `SERVICE_URL_` and `SERVICE_FQDN_`. Kiln tells a container nothing about
  the port it was given, so a game that advertises its own port can't (the
  Palworld Brick hard-codes one). Not as small as it looks: a port can change
  after a server exists, and its container is then rebuilt from the settings
  it already has without reading the Brick again, so a value written into
  its environment has to be worked out again there too. Apps need the same
  for their own URL (step 8).
- **Config files a recipe sets**: eggs set keys in `server.properties`, YAML,
  JSON or INI on each start; Coolify writes a file's content. The Java Ember
  does this in its entrypoint (the EULA, a first `server.properties`), which
  a Brick on a stock image can't. When a Brick first needs it.
- **An install step in a container of its own**: eggs' install script,
  Railpack's steps. A Brick could then use a stock image and a script where
  it needs an Ember image today, and it is what redeploying a game server
  would run again.
- **Generated values of a chosen form and length**: Coolify makes passwords,
  hex and base64 of 32, 64 or 128. `generate` makes one kind. Apps often need
  a key of an exact form (step 8).
- **A build with no Dockerfile**: Railpack, for a repository that has neither
  a Dockerfile nor a Compose file (step 8).

Smaller: prompts that watch the console and offer a fix, as eggs' `eula` and
`java_version` features do (extras for a `type`); several named start
commands to choose from; files people can't edit; Compose services left out
of an App's health; a category beside tags, where the picker guesses "Steam"
from a tag or an image name today.

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
6. One redeploy for every kind. Done: one permission (`instance.deploy`)
   and one Relay request (`instance.deploy`) deploy a game server, a
   database or an App again as it is set up. Resource limits followed the
   same way: `instance.limits.write` is one permission and one request,
   and each kind still applies them its own way.
7. Databases as Bricks. Done: the five engines are official Bricks, the
   Relay creates a database from its Brick, and Hearth records the Brick,
   image and port each database runs instead of a table of engines. Game
   servers and databases are added from one dialog. Only those five Bricks
   run, not another catalog's; a database's version is chosen when it is
   created, and moving one to another major version is not built.
8. Apps as Bricks. Apps are installed from Kiln's three generic Bricks, in
   the one Add dialog, and Umami and WordPress from group Bricks that bring
   their databases (instance groups, pulled forward from step 11). An App made from a
   catalog Brick follows it: it is offered the Brick's newer revisions, and
   can be detached. Its web port gets a new App its address and first web
   route, each folder it keeps is on a volume from the start, and its
   `ready` command is its container's health check. Its `command` starts
   it, and its public ports are published on its Relay. A Brick can carry
   the Compose file or Dockerfile its App runs, as Beszel's hub and agent
   do. An App or group Brick is installed from any catalog its installer
   sees, and a Brick goes by its ID after whose it is. Done.
9. Domains for every kind. Done for game servers and Apps; a database's
   address is still to come.
10. One instance page, with each kind's own tabs.
11. Tailscale as its own kind, with the instance group.
12. One terminal path.
13. One log path. The Logs page is one already: every kind fills the same
    page (`InstanceLogsPage`) with its containers and its deployments. The
    Relay still keeps an App's deployment logs apart from a game server's
    and a database's, behind two read requests.

The CLI is reworked after this, and isn't changed along the way beyond what
keeps it working.
