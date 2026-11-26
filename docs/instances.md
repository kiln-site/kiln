# Instances

An instance is anything Kiln runs: a Relay, a game server, a database, an App,
or a tunnel. Each has one ID (see [Instance IDs](instance-ids.md)).

Kiln is moving every kind onto one foundation. What every kind has is built
once, as an instance feature; a kind adds only what is unique to it. Much of
the code predates this and has a copy of the same feature per kind. This page
says where the foundation stands, what the target is, and the order of the
work. Update it as each step lands.

## Kinds

| Kind        | Comes from    | Notes                                               |
| ----------- | ------------- | --------------------------------------------------- |
| Relay       | The installer | The host node. An instance, but never from a Brick. |
| Game server | A Brick       | Called `instance` in permissions and the protocol.  |
| Database    | A Brick       | One of Kiln's own, of an engine Kiln knows.         |
| App         | A Brick       | One of Kiln's own, for what it deploys.             |
| Tunnel      | Its type      | Its Brick's gateways, one per Relay it reaches      |

A tunnel connects instances on any Relay to a private network outside them,
through a gateway on each Relay something it connects is on. Its type says
which network: Tailscale is the only one, and others (NetBird, WireGuard,
Cloudflare Tunnel) may follow. See [Tunnels](#tunnels).

## The foundation

Every kind gets these from the platform.

| Capability  | Target                                          | Today                                                                                                                                                |
| ----------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Power       | Start, stop, restart and kill, for every kind   | Done for game servers, databases, Apps and tunnels: one Relay request and one permission                                                             |
| Deployments | One redeploy for every kind                     | Done for game servers, databases, Apps and tunnels: one Relay request and one permission                                                             |
| Limits      | One request and one permission for every kind   | Done for game servers, databases and Apps: one Relay request and one permission                                                                      |
| Domains     | Every kind, automatic for an App's web services | One table of addresses, one reconcile and one Domains table for game servers and Apps, tunnel names included; a database has only its tunnel names   |
| Terminal    | A shell in every kind, on one path              | Done for game servers, databases, Apps and tunnels: one set of Relay requests, one stream and one permission                                         |
| Logs        | One Logs page, one log store and one permission | Done for game servers, databases, Apps and tunnels                                                                                                   |
| Ports       | One list of taken ports and one Ports section   | Done for game servers and Apps: one list on the Relay and one Ports section. Each kind still saves its ports its own way                             |
| Networking  | One page for every kind                         | A page per kind, on a few shared sections                                                                                                            |
| Files       | One file browser and one permission             | Done for game servers and Apps                                                                                                                       |
| Info page   | One page shell                                  | One profile and container section for every kind; a Relay's page is its own                                                                          |
| Move        | Move and duplicate every kind but a tunnel      | Done for game servers, databases, Apps and volumes: one operation, dialog, toast and notification ([Moving and duplicating](resource-migrations.md)) |

A Relay implements each in its own way: it can only be restarted, its
deployments are its updates, and its files and its shell are the host's.

Sharing a console, logs or a file is planned as a foundation feature of
Kiln's own, replacing the mclo.gs upload game servers have now.

## What a kind adds

- **Game server**: a console for its output. Its Logs page lists its
  deployments, as a database's and an App's do beside their output.
- **Database**: the viewer in place of files, and import and export. An
  engine without a viewer has neither a viewer nor files.
- **App**: volumes, and its source.
- **Tunnel**: the instances connected through it, and the names they have
  there.

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
longer part of `app.manage`. `instance.terminal` opens a shell in what it
is granted on, and in everything on a Relay; `app.terminal` and
`database.terminal` are gone, and a game server's owner holds it only when
it's granted. `instance.logs.read` reads the logs of what it is granted
on, and of everything on a Relay; `app.logs.read` and `database.logs.read`
are gone. See [Access control](access-control.md).

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
- Kiln makes one for its own services (a Relay, Hearth, its cache and its
  database), which people can't edit.

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
members on more than one Relay, and the group Kiln makes itself for its own
services.

## Tunnels

The plan for step 11, and where it stands. A tunnel is one instance, of
kind `tunnel`, made from a tunnel Brick: today's only type is Tailscale,
shown as "Tunnel · Tailscale". It reaches Relays through its gateways, one
on each Relay something it connects is on. You never pick a Relay for it:
you connect a game server, an App's service or a database to it, and Kiln
makes the gateway on that Relay if there is none, or takes it away when
the last thing there leaves. A Tailscale network of before is a tunnel
now, each of its Relays' nodes a gateway. Built: that, the migration,
connecting, power and deploying across its gateways, DNS reloading in
place, names, tunnel names as primary addresses, and its pages. Its
permissions of its own follow.

### What runs

- **A gateway** is a tunnel's part on one Relay: two containers from the
  images its tunnel's Brick pins, Tailscale (`kiln-ts-<key>`, a subnet
  router) and CoreDNS (`kiln-ts-<key>-dns`, in the Tailscale container's
  network namespace, so only its tailnet reaches it). What the tunnel
  connects on that Relay joins the gateway's Docker network
  (`kiln-ts-<key>-network`), each at an address of its own; nobody sees
  that network.
- A gateway is no instance: nobody opens, lists or picks it, and it has no
  page. It has its own ID, reserved in the directory so it is never handed
  out again, and on its Relay its containers, lanes and saved state. A
  Relay still calls it a tunnel, in its requests (`tunnel.*`, and
  `kind: "tunnel"` in the shared ones), labels, folders and state; Hearth
  calls it a gateway (`kiln_tunnel_gateway`).
- A tunnel has what every instance has, across its gateways: power and
  deploying again act on every gateway it may (one failing doesn't stop
  the rest, and each says how it went), or on one; its Logs show each
  gateway's two containers and their deployments, kept with every kind's;
  its terminal opens in one gateway's Tailscale container, since CoreDNS's
  image has no shell.
- Its DNS reloads in place. Its records are a hosts file that CoreDNS reads
  again by itself, and its Corefile is one CoreDNS watches and reloads
  gracefully, keeping the old one if the new one fails; a change to either
  never recreates the container or drops a query. Both files sit in a folder
  mounted whole (`dns/`), so a file replaced by a rename is seen. Only
  making its Tailscale container again, as redeploying or renaming its node
  does, recreates CoreDNS, which lives in its network. Built.

### The tunnel

- Hearth keeps it in `kiln_tunnel`: its name, its owner, the Brick its
  gateways run, its Tailscale login (an OAuth client and secret, which it
  needs: Kiln makes each new gateway's key with it), and its TLDs in order,
  which are domains whose provider is the tunnel (`kiln_domain`; see
  [Domains](domains.md#domains)). A TLD can't equal, sit under, or contain a
  public domain, which it would answer for on the tailnet. It is no instance
  group.
- Creating it takes its name, its first TLD, its Tailscale login and its
  Brick, and makes no gateway. A tunnel from before that has no login (one
  made with a one-time key) keeps running, but connecting something on a
  Relay it has no gateway on asks for a login first.
- Deleting it tears down every gateway, which needs its login to log each
  out; then Hearth clears its split DNS and forgets the login.
- Hearth registers every TLD in its split DNS, pointing at all of its
  gateways, so names still resolve while one Relay is down. Every gateway
  serves the whole tunnel's records.
- A TLD is unique across Kiln. Two tunnels of different Tailscale accounts
  could share one; allowing that needs Hearth to know which account a
  tunnel is, and comes later.

### Connected instances

- A game server, a database or an App's service connects to any number of
  tunnels, each through its gateway on the instance's own Relay
  (`connectToTunnel`). Connecting to a tunnel with no gateway there makes
  one in the same operation: a key from the tunnel's login, the gateway
  from its Brick, the member on its network, its generated name, and every
  gateway's DNS and Tailscale's split DNS rewritten. If making the gateway
  fails, the connect fails with why and the gateway is taken away again.
  Disconnecting the last thing on a Relay takes its gateway away, and logs
  its device out of Tailscale. A gateway that has connected nothing yet,
  as a network's node of before may not have, stays.
- In each tunnel a connected instance has one name, generated once from its
  name (lowercase; spaces become hyphens; anything but letters, digits and
  hyphens dropped; repeated hyphens collapsed and trimmed; at most 63
  characters; `-2`, `-3` when taken; the kind and the ID's first characters
  when nothing is left) under the tunnel's first TLD. It can be renamed,
  never removed. It can have aliases besides, at any depth, under any of the
  tunnel's TLDs (`paper26.3.kiln`, `paper.26.3.test`). A name is unique in
  its tunnel.
- Hearth keeps every name (`tunnel_name`); a gateway knows only its
  tunnel's TLDs and its members' addresses, and serves the whole names
  Hearth sends it. A save of the tunnel applies its gateways first, then its
  members' names, then rewrites its DNS. Each gateway records whether it has
  the latest hosts file; one that couldn't take it, as when its Relay is
  away, shows **DNS pending**, and Hearth's DNS worker writes it again, after
  30 seconds then twice as long each time up to an hour. A write goes out
  only when Hearth has read every gateway's members, so no file leaves an
  away gateway's out; the cost is that one gateway away holds back a change
  for the whole tunnel, a removed alias included, until it's back. Keeping
  each gateway's last members in Hearth would lift that, if it matters. Built, with aliases added and removed through Hearth.
- An instance's Network tab has a Tunnels section shaped like its Domains
  table: each tunnel it is in, with its names, and connecting to another.

### One primary address

- An instance has one primary address (★), whichever it is: a join address,
  a domain or a tunnel name. It is what Kiln shows for the instance (lists,
  its header, the infra map, the copy button and the CLI) and, for a game
  server, the address it advertises. It changes nothing about routing: every
  name works, starred or not.
- Any of a game server's or an App's names in a tunnel can be its primary,
  in place of its join address or domain, from the names on its Network
  tab or its tunnel's page. A game server's is the name at the port it
  listens on in its container (`paper.kiln:25565`), since its gateway
  reaches the container itself. An App's header and the Apps list show it
  with the Tailscale mark, since only its tailnet reaches it; a game
  server's address doesn't carry the mark yet. A database has no primary
  address. While a tunnel name is the primary, no join address or domain
  steps in for it, even a game server's first; once the name is gone, the
  first active one does. Built.
- Hearth keeps it, one row per instance naming the address
  (`kiln_instance_primary_address`), so an instance can't have two. The
  Relay forgets it: the web-route star on its routes and in their labels
  goes. A game server's star is among its join addresses, an App's among
  its domains. Built.
- A primary address that's gone leaves the first active one standing in
  until another is chosen, as a failing one does. Stars carried over once:
  a game server's join address keeps its star, and each Relay lists the
  web-route stars it had until Hearth has taken them, for Apps without one.
  Backups no longer record the star; restoring one never applied its
  routes.

### Who may do what

- A tunnel has an owner, as any instance does. Its owner and platform
  administrators change it (its name, TLDs and login), delete it, and
  connect to it (`requireTunnelManager`). Its own permissions
  (`tunnel.read`, `tunnel.create`, `tunnel.manage`, `tunnel.delete`) come
  with the permission model (step 14), with sharing a tunnel with others
  who connect their own instances.
- Connecting an instance takes changing its network
  (`instance.network.write`, an App's `app.manage`, a database's
  `database.network.write`) and managing the tunnel. Kiln makes the
  gateway for it: there's no right of its own to put one on a Relay.
- What every kind of instance has (power, deploying, logs, terminal) a
  gateway takes as its tunnel's owner may, or as a grant on its Relay
  reaches everything there (`requireGatewayPermission`). Acting on a whole
  tunnel acts on each gateway the viewer may. Anyone who reads instances on
  a Relay sees the tunnels with a gateway there, with that gateway and what
  it connects on that Relay (`getTunnels`).
- In Hearth a tunnel holds `tunnel:<id>`, whole to create or delete it, and
  `#settings` to connect, rename, change its TLDs or login, or rewrite its
  DNS; acting on all its gateways holds `#gateways`, and one gateway
  `gateway:<id>`. On the Relay a gateway holds its own instance lane, and
  the lifecycle lanes of the members it connects or disconnects.

### Pages

On the components every instance's pages share. Built.

- **Infrastructure → Tunnels** (`/infra/tunnels`) lists tunnels, one row
  each on the table every kind's list uses: its state across its gateways,
  its TLDs, how many gateways (and on which Relays) and how many things it
  connects. The sidebar counts tunnels, and its instance picker lists them.
- **A tunnel's page** (`/tunnel/$id`):
  - **Info:** the Info page every instance has. Its profile (name with
    rename, Kiln ID, Brick); a Gateways table, one row per Relay with its
    state, Tailscale IP, what connects through it, and power, deploying
    again and its logs; a TLDs table, where one is added, made the one
    generated names go under, or removed, with the Tailscale login behind
    the table's key button; deleting it; and a rail counting what it
    connects and its gateways. No gateway is added here: gateways follow
    what's connected.
  - **Connected:** everything it connects, with its names. Connecting picks
    from every Relay; one with no gateway yet says it adds one, and the
    toast follows Tailscale logging it in.
  - **Logs:** each gateway's Tailscale and CoreDNS, labelled by Relay, and
    every gateway's deployments.
  - **Terminal:** a gateway's Tailscale container, picked when there are
    several. CoreDNS's image has no shell.

  Its header's power and redeploy act on every gateway and say which
  failed. No page for a gateway, and no `/tailnet` route.

- The one Add dialog has Tunnel, which browses the tunnel Bricks; beside the
  Brick, its name, first TLD and Tailscale login, and no Relay.
- An instance's Network tab lists the tunnels it's in, with its names, and
  connects it to any other: through the gateway on its Relay, or adding one,
  which needs the tunnel's Tailscale login.

### Moving off today's networks

- A network's ID became its tailnet's group ID, and then its tunnel's.
  Each of its Relay
  deployments became a gateway whose ID Hearth and the Relay each derive,
  as the old IDs were migrated (`migratedInstanceId` over the kind and
  `<network>:<relay>`); Hearth reserves each in its directory and refuses
  to migrate on a collision. The tunnel's physical key stays the
  network's, kept where the Relay keeps legacy keys: its containers,
  Docker network, Tailscale identity, state and subnet are kept, and its
  containers are recreated once with a tunnel's labels. A migration
  interrupted between any two steps finishes when the Relay next starts,
  with the identity, subnet, members and state intact. The network's owner
  owns each tunnel.
- `kiln_tailscale_network` became `kiln_tailnet` and then `kiln_tunnel`,
  and its deployments `kiln_tunnel`, then `kiln_tunnel_gateway`
  (migration 84, which also dropped each tailnet's instance group). Each
  member's hostname became its generated name, and the network's domain
  its first TLD. "Network" leaves the copy and the code
  for this: it means a Docker network.
- `relay.tailscale.stack.*` become `tunnel.*` requests, and the shared
  ones (`instance.action`, `instance.deploy`, `terminal.*`,
  `instance.deployment.read`, the Logs page's sources) take
  `kind: "tunnel"`.

### Deleted

- The one Tailscale per Relay that came before networks, which nothing
  shows: `kiln-tailscale`, `tailscale.json`, `relay.tailscale.{install,read,write}`,
  each game server's `tailscale` settings and labels, the connect address
  they override, and the infra map's badge.
- The Relay's private networking, which nothing in Hearth or the CLI calls
  and which took its names from those labels: `relay.networking.*`,
  `networking.json`, and the `kiln-coredns` and `kiln-limbo` containers. A
  Relay that still has it saved stops serving those names on its DNS
  port; no container's DNS settings point at it. The Relay removes
  whatever of either still runs as it starts.
- `TailscalePage`, the `network-stack` workspace and the console that
  merged every node's.

### Order

One stack, each part working on its own:

1. Delete what came before networks, and private networking.
2. One primary address per instance, kept by Hearth.
3. Tunnels as their own kind, and DNS reloading in place.
4. Names: several TLDs, generated names and aliases, and any number of
   tunnels per instance.
5. The first pages.
6. Tunnel names as primary addresses.
7. Tunnels from Bricks, and adding one from the Add dialog.
8. A tunnel is one instance and its Relays its gateways, made and taken
   away as things connect. Built.
9. The pages for it. Built.

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

- **`kind`**: game server, database, App, tunnel or group. Each has a
  section of its own.
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

A tunnel is made from a tunnel Brick whose `type` is one Kiln runs
(`tailscale`). The Brick pins its two images: `deploy` runs the Tailscale
container, and its `tunnel` section names the CoreDNS image that answers the
tunnel's names, on each of its gateways. It says nothing else: the login, routes, firewall and DNS
are Kiln's, made for those images, so only the tunnel Bricks of Kiln's own
catalog are offered and accepted, and the Relay refuses one of another type
or images. A tunnel records the Brick it was made from, with the images it
resolved to, and keeps it: redeploying pulls those images again. A tunnel
made before tunnels ran Bricks reads as Kiln's `tailscale` Brick, with the
images it already ran and no source, and nothing about its containers
changes. Built.

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

The Brick picker still guesses its "Steam" category from a tag or an image
name.

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
3. Remove unused Relay requests and checks for older Relays. Done: the
   Relay announces no features and Hearth checks none, browser capabilities
   are only v2, Relays pair only through their announcements, and responses
   carry every field the Relay sends. What stays is what an outdated Relay
   needs to connect and update, and Hearth's own feature list, which a Relay
   a release behind still reads.
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
9. Domains for every kind. Done: a database opened to the internet has a
   public name and port, its certificate's TLS required by a gate that
   holds the port ([Public databases](relay-runtime.md#public-databases)).
   Its name is generated under a vanity domain and can't be renamed yet;
   one that's open can't be moved, only closed first. An IP allowlist comes
   as a feature of every instance.
10. One instance page, with each kind's own tabs.
11. Tunnels as their own kind, each one instance reaching Relays through
    its gateways, and one primary address per instance. Done but for its
    pages; see [Tunnels](#tunnels).
12. One terminal path. Done: every shell, an instance's, the Relay's host's
    or one of Kiln's own containers', is one session the Relay keeps, opened
    with the six `terminal.*` requests that name their target, and shown by
    one stream and one page section. A shell in a game server, a database or
    an App takes `instance.terminal`. A database's Terminal opens a shell,
    not its signed-in client; signing in from it in one click is #936.
13. One log path. Every kind fills the same Logs page
    (`InstanceLogsPage`) with its containers and its deployments, and every
    deployment's log is kept by one store on the Relay, in one format, and
    read with `instance.deployment.read`. Reading any kind's logs takes
    `instance.logs.read`. Done.
14. One permission model. Permissions still work three ways by kind: an App
    can't be shared on its own, only through its Relay, and a game server's
    or a database's owner holds `all` in code, which no preset can narrow.
    The target: every instance can be granted on; ownership is a role (it
    transfers and can't be removed) and an owner's authority is an ordinary
    grant made with the instance from a preset its Relay names; and whether
    an instance is confined to itself (no host folders, privileged mode,
    Docker socket or host network) is the instance's own, so a confined App
    is granted on like a game server and only one that reaches the node
    takes the Relay's permissions. Owning a game server without its
    terminal is an exception in code until then.

15. One model for every name: domains with a DNS provider (a DNS service,
    a tunnel, or managed elsewhere) and every name an address under one.
    See [Domains](domains.md#where-this-is-going-one-model-for-every-name).

The CLI is reworked after this, and isn't changed along the way beyond what
keeps it working.
