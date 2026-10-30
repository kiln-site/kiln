# One lifecycle for every resource (plan)

Status: built and merged as a stack of 17 pull requests (#629–#645, listed
under [Stacks](#stacks)), and running in production. Kiln began with game servers; Apps, databases, and volumes
came later, and several features were never brought over or were built a
second time beside the first. This plan makes database networks, Tailscale,
deletion, backups, and automations work the same way for every resource,
and records what stays different on purpose. Its long changes run as
[Hearth operations](hearth-operations.md).

## Words used here

- **Resource**: a game server (`instance` in code), an App, a database, or a
  volume, always on one Relay. Code names it with
  `ResourceRef = {kind, relayId, id}` in `packages/contracts`, using the code
  kinds `instance | app | database | volume`. Relays are hosts, not
  resources; the platform backup stays a backup subject of its own.
- **Member**: what joins a network. A game server, an App's service, or a
  database. Apps join per service, so a member names the service too.

## Decisions

Same release everywhere: Hearth and every Relay run one version, so the
protocol changes freely. Stored data still migrates: Hearth's MySQL, the
Relay's SQLite and files, and Docker labels on running containers.

**Shared contract, kind-specific work.** Each feature has one contract, one
entry point, one permission check, one place in the UI, and one operation
that orders it. What a kind does underneath stays its own where it truly
differs: a game server's folder is archived, a database is dumped by its
engine, a volume is archived through Docker.

### Database networks

- Any resource on the Relay can connect to a database from the database's
  Network page: game servers, Apps (all their services), and other databases.
  The App's Network page shows and changes the same connections.
- The Relay is the one authority for connections on it. Its
  `relay_database_connections` store names the member by kind. A connection
  whose network or container is missing stays saved and is applied when the
  member is next created or deployed.
- Apps' `config.databaseIds` moves into it through a one-time import that
  Hearth sends each Relay and records once the Relay acknowledges it.
  Hearth keeps the field until then and drops it after; the cutover is one
  layer, so Hearth and the Relay never both write connections.
- Every member gets an alias on the database network: the App's service
  alias as today, and `<kind>-<id>` for game servers and databases.
- Connecting needs `database.network.write` on the database and the member's
  own network permission (`instance.network.write`, `app.manage`, or
  `database.network.write`). Changes lock the database and the member.
- Deleting either side removes its connections on both.

### Tailscale

- Any member can join a Tailscale network: game servers and App services as
  today, and databases. Member IDs become typed (`instance:<id>`,
  `app:<id>:<service>`, `database:<id>`), and the bindings stored on Relays
  and in Hearth migrate in the same layer.
- Membership is set from each resource's Network page, with one shared
  component, and from Infra → Tailscale.
- Applying a network locks the members it changes, not only the network.
- Relays are hosts of a network's node today; a Relay joining as a member is
  later work.

### Deletion

- One durable operation, `resource.delete`, deletes any resource. Its steps:
  check access, freeze the resource on the Relay, take an optional final
  backup, prepare Tailscale, delete on the Relay, clean up in Hearth, then
  finish. As everywhere in the lanes, a step cut off by a restart runs again,
  so each step is safe to repeat; a finished step doesn't run again.
- Freezing marks the resource as being deleted in the Relay's own state and
  quiets it: a game server or App is stopped (an App's restart policies set
  to `no`), and a database stays running for its final dump with its
  terminal sessions ended. From then on the Relay refuses every other
  change to it (power, console, files, SFTP, schedules, deploys, new
  terminals), and quiets it again after a restart, so nothing Kiln starts
  writes between the final backup and the deletion. A database's final
  backup is a live dump: work a terminal client already sent may finish,
  and game servers and Apps connected to it can still write until it's
  deleted, so what's written during or after the dump may not be in it.
  The deletion dialog says so. An exact last-state guarantee would need an
  engine-level write fence, a separate design.
- Cancelling a deletion before the Relay deletes anything unfreezes it and
  puts back what quieting changed (an App's restart policies); a stopped
  game server or App stays stopped, and ended terminal sessions stay ended.
  Freezing an App also drops any restart an earlier stopped backup still
  owed it, so a cancelled deletion leaves it stopped across Relay restarts.
- A deletion that fails after the Relay took its resource off a Tailscale
  network puts it back, unless an apply gave its hostname to another member
  meanwhile; then it stays off, and finishing the deletion removes it.
- Access is checked when the deletion is asked for and before the freeze.
  Once the Relay has deleted, cleanup always finishes, even if the person
  has lost access since.
- The final backup is an ordinary backup task. The operation stores its ID
  before queuing it and follows it by that ID; a failed, cancelled, or
  missing task stops the deletion with the resource still frozen, for the
  person to retry or delete without one. Retention never removes final
  backups. The operation holds no lock the backup needs.
- One cleanup for every kind: directory row, access grants with an
  authorization revision bump, icons, favorites, schedule targets, GitHub sync
  rows, domains and web hostnames, database connections, Tailscale DNS.
  Today each kind forgets some of these. Cleanup removes references to the
  resource; its backups stay, and are deleted only as backups are.
- The same confirmation for every kind: type the name and enter your
  account password, the check game server deletion already uses. The CLI's
  deletions ask the same. Re-authenticating with a passkey instead is later
  work.
- A final backup is offered for every kind that can be backed up, on by
  default: game servers, databases, Apps (their folder and the volumes their
  Compose project owns). If it fails, nothing is deleted.
- The two final-delete tables become one, keyed by resource. Rows still
  backing up or deleting are resumed as `resource.delete` operations with
  their backup IDs; failed rows are kept as failed; completed rows are not
  revived.
- A volume can't be deleted while any container mounts it or any App's
  configuration names it, running or not. An App's deletion removes only the
  volumes its own Compose project owns.
- Relay removal stays its own operation, built in phase 5, and reuses the
  same cleanup for the resources it held.

### Backups

- Backup targets: game servers (their folder, full or incremental),
  databases (their engine's dump), Apps (their folder), volumes (archived
  through Docker), and the platform.
- Volumes have a stable identity before anything backs them up. A volume
  Kiln made is named by its Kiln ID. A volume an App's Compose project
  declares is owned by that App and named by the App and the volume's name
  in Compose, which survives redeploys. Anonymous volumes and host paths
  outside the App's folder aren't backed up; in the App's Volumes table on
  its Info page, only volumes that are backed up get a Backups button. The
  Relay's own data volume is the platform backup's.
- Ownership and use are separate: an App owns its Compose volumes; a Kiln
  volume is owned by no App, and any App's configuration may use it.
- The backups page filters volumes by App, through ownership or use. Backing
  up an App backs up its folder and the volumes it owns, each as its own
  backup, started together; the App's page shows whether all succeeded.
  It covers the volumes the App owns when the backups start: a deploy that
  added one before then is included, or the whole backup fails. A batch
  missing a part fails whole instead of running in pieces. A live backup
  doesn't hold up the App's deploys or power; a stopped one holds the App
  until it's started again.
- A backup is taken live by default, as a game server's folder is, and the
  backup says so. It can instead stop the resource for the backup and start
  it again after, for data a live copy can't capture safely, such as a
  database's files in a volume. A final backup is taken of the frozen
  resource; a database's is a live dump (see Deletion).
- Restoring a volume needs every container mounting it stopped, checked on
  the Relay; restoring an App's folder needs the App stopped.
- Permissions: backup contents are the resource's data, so backing up or
  downloading needs the same authority as reading it. An App's folder and
  owned volumes follow the App's permissions; a Kiln volume, shared by
  design, needs `backup.*` on the Relay. Restoring needs authority over every
  resource that uses what's restored.
- Moving backups onto durable operations stays in phase 5. This plan only
  adds the volume target and fixes the scheduled-backup checks that manual
  backups already run.

### Automations

- Schedules can target Apps. An App's actions: power, a command in one of its
  services, and a backup of its volumes. A database's command runs in its
  container's shell. A game server's command still goes to its console.
- Commands run as a one-off `exec` in the container: `sh -c` in the chosen
  App service or the database's container, a timeout, bounded output, and
  the exit status in the run's result. An App's command names its service;
  one with a single service preselects it. It runs in the resource's
  current container, which a limit change or redeploy may have replaced; a
  container without `sh`, or a service that no longer exists, fails that
  step. Commands and kill on databases and Apps run only on targets a step
  names explicitly, so schedules saved before this don't gain them. A command that may
  have run when Kiln lost track of it is reported as unknown, never retried.
  Commands are scheduled only; running one by hand is what the terminal is
  for.
- Power works the same for every kind, with the same guard that skips a step
  when someone changed power during the run.

### Other split decisions, fixed here

- Deleting a database bumps authorization revisions, as deleting a game
  server does.
- Deleting an App removes the database IDs, GitHub sync rows, and favorites
  that point at it.
- Live resource stats for Apps and databases, as game servers have.

### Later, on purpose

- Sharing Apps with other people (App grants and invitations): App owners
  can't configure Compose or open a shell because that reaches the node, so
  delegation needs that boundary designed first.
- CLI commands for Apps and databases.
- SFTP for App folders and volumes.
- Moves for Apps and databases; game server moves come in phase 5.
- The older per-Relay Tailscale node. It has no UI left, but bricks still
  configure it at startup. Removing it needs an inventory of the servers that
  use it and a migration onto Tailscale networks that keeps them reachable.
- Moving backups themselves onto durable operations (phase 5).

## Stacks

Each layer is one reviewable PR with its own tests, a sanity check, and a
review loop. A layer cuts over every caller of what it changes, so old and
new never both drive the same work.

Bottom to top, one branch and pull request each:

**Database networks and Tailscale**

1. `feat/unify-database-connections`: the Relay's store names every member
   kind; Hearth hands over Apps' `databaseIds` once, acknowledged.
2. `feat/unify-database-network-page`: the database Network page for game
   servers, Apps, and other databases, with permissions on both ends.
3. `feat/unify-tailscale-members`: typed member IDs, migrated bindings,
   member locks.
4. `feat/unify-tailscale-databases`: databases as members, and one
   membership component.

**Backups and deletion**

5. `feat/unify-volume-identity`: Kiln and Compose volumes named stably,
   ownership and use, references protecting a volume from deletion.
6. `feat/unify-volume-backups`: Relay backups of volumes and App folders,
   live or stopped, with restore journals that fence an unfinished swap.
7. `feat/unify-backup-targets`: the App and volume targets in Hearth's
   backup tables, with authorization.
8. `feat/unify-scheduled-backup-checks`: scheduled backups checked before
   they run, as manual ones are.
9. `feat/unify-deletion-cleanup`: one cleanup for every kind.
10. `feat/unify-deletion-freeze`: the Relay's freeze.
11. `feat/unify-deletion-operation`: `resource.delete` for game servers and
    databases, carrying over the final-delete tables.
12. `feat/unify-delete-confirmation`: name and password for every kind, in
    the browser and the CLI.
13. `feat/unify-delete-apps-volumes`: Apps and volumes on
    `resource.delete`, with their final backups.
14. `feat/unify-backups-ui`: App and volume backups on the Backups page,
    reached from App Info's rail and its Volumes table, live or stopped.

**Automations and stats**

15. `feat/unify-container-commands`: one-off commands in an App service or
    a database, and one power path for every kind.
16. `feat/unify-app-schedules`: Apps as schedule targets, App and database
    commands, scheduled App backups.
17. `feat/unify-live-stats`: live stats for Apps and databases.

Hearth and every Relay must run the same release: the protocol changed
freely. The Relay's state migrations were renumbered while the layers were
combined, so a development Relay that ran an earlier build of them needs
its state reset.

Tests protect what the [testing rules](../AGENTS.md#testing) name:
migrations of stored state (connections, bindings, final-delete rows,
schedule targets), authorization on both ends of a connection and over
everything a restore touches, deletion resuming after a restart without
deleting twice or leaving rows behind, a failed final backup deleting
nothing, nothing changing a frozen resource, restores refused while a
volume is mounted, and commands whose outcome is unknown never running
twice.
