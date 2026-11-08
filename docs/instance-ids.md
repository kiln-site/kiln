# Instance IDs

Every instance — a Relay, game server, App, database, or Tailscale network —
has one ID: 12 lowercase hexadecimal characters, such as `a7c39f204bd1`.

- It's the whole ID. There are no short IDs, prefix matches, or route IDs
  built from a Relay's ID and an instance's; URLs, the CLI, APIs, permissions,
  lock keys, and every record use the same 12 characters.
- It's unique across every kind and every Relay, live or deleted. Hearth's
  instance directory (`kiln_instance_id`) reserves each one with
  `reserveInstanceIdEffect` (`apps/web/src/effect/instance-ids.ts`), which
  retries a collision and, given a request key such as a create's idempotency
  key, returns the same ID however often that request is retried. An ID
  something else chose, such as a Relay's own, is claimed with
  `claimInstanceIdEffect`. Deleted instances keep their reservation, so an old
  reference never comes to mean a new instance.
- What kind of instance it is comes from the instance, never from the ID.
  Keys that mix kinds name the kind: `app:<id>`, `database:<id>`,
  `relay:<id>` (a Relay's host files), and a game server's bare ID.
- A Relay's ID is an instance ID like any other, generated when its identity
  is first created and kept in `network/identity/identity.json`. Its Ed25519
  public-key fingerprint only authenticates it: pairing, signed challenges,
  and Hearth's `relay.fingerprint` column. The Relay signs its ID into its
  pairing response and join announcement.

The contracts are in `packages/contracts/src/instance-id.ts`
(`instanceIdSchema`, `InstanceId`, `newInstanceId`).

Other records keep their own formats: Kiln volume IDs (40 hex characters),
operations, backups, deployments, schedules and their steps (UUIDs), schedule
runs (deterministic hashes), and users.

## The migration from the old IDs

Before, game servers, Apps, databases, and Tailscale networks had 40-character
hexadecimal IDs, a game server's unique only on its Relay, and a Relay's ID
was its fingerprint. Each old ID becomes the first 12 hex characters of a
SHA-256 over its kind and old identity (`migratedInstanceId` in
`packages/contracts/src/instance-id-migration.ts`), so Hearth and every Relay
compute the same new ID on their own.

- Hearth's migration `0058_instance_ids` reserves the new IDs beside the old
  ones (refusing to continue if two coincided), rewrites every old ID in every
  table in one transaction — ID columns, JSON, lock keys, file roots,
  settings, notifications, encrypted App configurations — and shrinks the ID
  columns. Signed pairing records, key material, and the object paths of
  backups already in storage keep what they say.
- An old ID found both as a game server and as a Tailscale network, App, or
  database is the latter, on Hearth and the Relay alike: a Tailscale
  network's container carries a game server's label with the network's ID.
- Each Relay migrates its own state when it starts: its identity file, every
  SQLite record, and the state files that name instances. Docker labels can't
  be changed and volumes can't be renamed, so a migrated instance keeps its
  containers, volumes, networks, Compose project, directories, and backup
  repositories under their old names: the Relay records the old ID as the
  instance's physical key and translates old IDs it reads from labels. A
  container recreated later carries the new ID in its labels. Hostname
  aliases answer to both the old and the new name.
