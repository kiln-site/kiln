# Moving and duplicating game servers

A game server's Info page has **Move or duplicate**, above the Danger zone.
Both make a new game server with its own ID from the old one:

- **Duplicate** copies it to any Relay the person may create game servers
  on, including its own, and keeps the old server as it was.
- **Move** copies it to another Relay, stops the old server and leaves it
  stopped, and hands its place to the copy. Once the move finishes, its
  notification offers to delete the old server, with the usual confirmation.

Copying needs the old server's `instance.files.read` and
`instance.configuration.read`, and `instance.create` on the Relay the copy
goes to. Each option needs its own permission on the old server, checked
when the copy starts.

## What comes along

| Option             | Duplicate | Move     | Notes                                                                                                                                                                                                                                       |
| ------------------ | --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files and settings | Always    | Always   | Its whole folder, the exact Brick it was built from, startup settings, and limits. Ports are allocated afresh on the new Relay.                                                                                                             |
| People with access | Optional  | Optional | The same grants, permissions, and presets (presets are copied to the new server). Pending invitations aren't. Needs `access.read`.                                                                                                          |
| Activity history   | Optional  | Optional | The new server's activity shows the old server's history up to when the copy finished, to whoever can see the new server but not the old one. It stays on the old Relay, so removing that Relay removes it.                                 |
| Managed domains    | —         | Optional | With Cloudflare connected, domains move to the new server and their records point at the new Relay. Without it, Kiln manages no DNS and the dialog says to repoint any domain of your own.                                                  |
| Web routes         | Stay      | Optional | Routes move to the new server; their hostnames must then point at the new Relay before HTTPS works.                                                                                                                                         |
| Backups            | Optional  | Optional | Links the old server's full backups to the new one, sharing their archives ([Linked backups](backups.md#linked-backups)). Backups in S3 link anywhere; backups kept on the Relay only to a copy on the same Relay. Needs `backup.download`. |
| Backup first       | Optional  | Optional | A full backup to a chosen destination, finished before anything changes. Needs `backup.create`.                                                                                                                                             |

A duplicate can stop the old server while its files copy, then start it
again; a move always stops it. Stopping needs `instance.power.stop`, and a
duplicate that stops it also `instance.power.start`, whether or not it runs
when the copy starts. A copy whose owner isn't the person moving
it passes to the old server's owner when the move finishes.

## How it runs

The copy runs in Hearth's background as a row in `server_migration`
(`apps/web/src/lib/server-migrations.server.ts`), through these steps:

1. **backup**: optional full backup, waited on until it's available.
2. **stop**: stops the old server, noting whether it ran.
3. **create**: provisions the new server, stopped, from the old one's Brick
   snapshot, variables, and limits (`lib/server-provisioning.server.ts`).
4. **provision**: waits for the new server to be created.
5. **copy**: copies the old server's folder into the new one's, Relay to
   Relay ([Relay transfers](relay-transfers.md#between-relays)).
6. **finish**: hands over ownership, access, domains, routes, and backups
   as chosen, each once, and starts a duplicated server's original again.

Every step is safe to repeat. A worker holds a migration under a two-minute
lease it renews while it works; one whose worker stopped, such as when
Hearth restarted, is taken over by the `ServerMigrations` polling worker
once its lease lapses, and carries on from its step.

The person who started it sees a progress toast (`ServerMigrationToasts`)
they can close or cancel from. However it ends, they get a
`server.migration` notification, so a closed toast or tab misses nothing.
A copy that fails or is cancelled before its last step is deleted and the
old server started again if the copy stopped it; one that fails while
handing things over keeps the new server, which may hold what moved.
