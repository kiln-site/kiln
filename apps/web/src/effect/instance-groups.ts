import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect } from "effect"

import { brickInputValuesSchema } from "@workspace/contracts"
import { z } from "zod"

import { decryptWithKeyring, encryptWithKeyring } from "../../keyring.mjs"
import { Database, type DatabaseTransaction } from "@/effect/database"
import { CredentialError } from "@/effect/errors"
import { databaseTable } from "@/lib/database-config"
import { betterAuthSecrets } from "@/lib/environment"

// An instance group keeps instances together: a name, and members of any
// kind on any Relay. It is its own record, not a feature of one kind. An
// instance is in one group at most, and a group with no members left is
// gone.

/** The kinds of instance a group keeps, as the rest of Hearth names them. */
export type InstanceGroupMemberKind = "app" | "database" | "server"

export interface InstanceGroupMember {
  instanceId: string
  kind: InstanceGroupMemberKind
  /** What its group's Brick calls it, for a group a Brick made. */
  member?: string | null
  relayId: string
}

/** A member as a group lists it, by the name Hearth keeps for it. */
export interface NamedInstanceGroupMember extends InstanceGroupMember {
  /** Null for a game server, whose name its Relay keeps. */
  name: string | null
}

export interface InstanceGroup {
  id: string
  /** Game servers, then Apps, then databases. */
  members: ReadonlyArray<NamedInstanceGroupMember>
  name: string
}

interface GroupRow extends RowDataPacket {
  id: string
  name: string
}

interface MemberRow extends RowDataPacket {
  group_id: string
  instance_id: string
  instance_kind: InstanceGroupMemberKind
  member: string | null
  name: string | null
  relay_id: string
}

const GROUP_BRICK_PURPOSE = "kiln-instance-group-brick"

/**
 * What a group keeps of the Brick that made it, kept encrypted since an
 * answer can be a secret: its answers as they stood at install, a secret
 * Kiln made among them, and what each of its databases was made from. Its
 * Apps are made again from these when the Brick is revised; a revision
 * that would make a database from something else isn't one of an App's.
 */
const groupBrickSchema = z.strictObject({
  answers: brickInputValuesSchema,
  databases: z.record(
    z.string(),
    z.strictObject({
      /** Its database Brick, by its ID in the group Brick's catalog. */
      brick: z.string(),
      variables: brickInputValuesSchema,
    })
  ),
})
export type InstanceGroupBrick = z.infer<typeof groupBrickSchema>

const encryptGroupBrick = (brick: InstanceGroupBrick) =>
  Effect.try({
    try: () =>
      encryptWithKeyring(
        JSON.stringify(groupBrickSchema.parse(brick)),
        betterAuthSecrets(),
        GROUP_BRICK_PURPOSE
      ),
    catch: (cause) =>
      CredentialError.make({
        operation: "encrypt_instance_group_brick",
        cause,
      }),
  })

const decryptGroupBrick = (ciphertext: string) =>
  Effect.try({
    try: () =>
      groupBrickSchema.parse(
        JSON.parse(
          decryptWithKeyring(
            ciphertext,
            betterAuthSecrets(),
            GROUP_BRICK_PURPOSE
          ).plaintext
        )
      ),
    catch: (cause) =>
      CredentialError.make({
        operation: "decrypt_instance_group_brick",
        cause,
      }),
  })

/**
 * Changes what a group keeps of the Brick that made it, against what is
 * kept now, as a newer revision leaves it: the group is held from reading
 * what it keeps until what `change` keeps is saved, so each of its Apps
 * taking a revision starts from what the one before it left, such as a
 * secret made for it. Gives what `change` made, or null for a group no
 * Brick made.
 */
export const changeInstanceGroupBrickEffect = Effect.fn(
  "instanceGroups.changeBrick"
)(function* <A, E, R>(
  groupId: string,
  change: (
    kept: InstanceGroupBrick
  ) => Effect.Effect<{ keep: InstanceGroupBrick; made: A }, E, R>
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  return yield* database.transaction(
    "instance_group_brick_change",
    (transaction) =>
      Effect.gen(function* () {
        const [row] = yield* transaction.queryRows<
          RowDataPacket & {
            brick_ciphertext: string | null
            brick_source: string | null
          }
        >(
          `SELECT brick_source, brick_ciphertext
             FROM ${databaseTable("instance_group")}
            WHERE id = ?
              FOR UPDATE`,
          [groupId]
        )
        const ciphertext = row?.brick_ciphertext
        if (!row?.brick_source || !ciphertext) return null
        const { keep, made } = yield* change(
          yield* decryptGroupBrick(ciphertext)
        )
        yield* transaction.execute(
          `UPDATE ${databaseTable("instance_group")}
              SET brick_ciphertext = ?, updated_at = ?
            WHERE id = ?`,
          [yield* encryptGroupBrick(keep), now, groupId]
        )
        return made
      })
  )
})

export const createInstanceGroupEffect = Effect.fn("instanceGroups.create")(
  function* (group: {
    /** The Brick that makes it, and what the group keeps of it. */
    brick?: InstanceGroupBrick & { source: string }
    createdBy: string
    id: string
    name: string
  }) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const kept = group.brick
      ? yield* encryptGroupBrick({
          answers: group.brick.answers,
          databases: group.brick.databases,
        })
      : null
    // Trying the same create again makes the same group, once.
    yield* database.execute(
      "instance_group_create",
      `INSERT IGNORE INTO ${databaseTable("instance_group")}
         (id, name, brick_source, brick_ciphertext, created_by, created_at,
          updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        group.id,
        group.name,
        group.brick?.source ?? null,
        kept,
        group.createdBy,
        now,
        now,
      ]
    )
  }
)

/** Puts an instance in a group, which takes it out of any other. */
export const addInstanceGroupMemberEffect = Effect.fn(
  "instanceGroups.addMember"
)(function* (groupId: string, member: InstanceGroupMember) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "instance_group_member_add",
    `INSERT INTO ${databaseTable("instance_group_member")}
       (instance_id, group_id, instance_kind, relay_id, member, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       group_id = VALUES(group_id),
       instance_kind = VALUES(instance_kind),
       relay_id = VALUES(relay_id),
       member = VALUES(member)`,
    [
      member.instanceId,
      groupId,
      member.kind,
      member.relayId,
      member.member ?? null,
      now,
    ]
  )
})

// Members with the names Hearth keeps for them, of one group or of all.
const memberRows = (where: string) =>
  `SELECT member.instance_id, member.group_id, member.instance_kind,
          member.relay_id, member.member,
          COALESCE(app.name, managed.name) AS name
     FROM ${databaseTable("instance_group_member")} member
     LEFT JOIN ${databaseTable("app")} app
       ON member.instance_kind = 'app' AND app.app_id = member.instance_id
     LEFT JOIN ${databaseTable("database")} managed
       ON member.instance_kind = 'database'
      AND managed.database_id = member.instance_id
    ${where}
    ORDER BY member.instance_kind ASC, member.instance_id ASC`

const named = (row: MemberRow): NamedInstanceGroupMember => ({
  instanceId: row.instance_id,
  kind: row.instance_kind,
  member: row.member,
  name: row.name,
  relayId: row.relay_id,
})

const membersOf = Effect.fn("instanceGroups.members")(function* (
  groupId: string
) {
  const database = yield* Database
  const rows = yield* database.queryRows<MemberRow>(
    "instance_group_members",
    memberRows("WHERE member.group_id = ?"),
    [groupId]
  )
  return rows.map(named)
})

/** Every group, each with its members, by name. */
export const listInstanceGroupsEffect = Effect.fn("instanceGroups.list")(
  function* () {
    const database = yield* Database
    const [groups, members] = yield* Effect.all([
      database.queryRows<GroupRow>(
        "instance_group_list",
        `SELECT id, name FROM ${databaseTable("instance_group")}
          ORDER BY name ASC, id ASC`
      ),
      database.queryRows<MemberRow>(
        "instance_group_list_members",
        memberRows("")
      ),
    ])
    return groups.map(
      (group): InstanceGroup => ({
        id: group.id,
        members: members
          .filter((member) => member.group_id === group.id)
          .map(named),
        name: group.name,
      })
    )
  }
)

export const loadInstanceGroupEffect = Effect.fn("instanceGroups.load")(
  function* (groupId: string) {
    const database = yield* Database
    const rows = yield* database.queryRows<GroupRow>(
      "instance_group",
      `SELECT id, name FROM ${databaseTable("instance_group")} WHERE id = ?`,
      [groupId]
    )
    const group = rows.at(0)
    if (!group) return null
    return {
      id: group.id,
      members: yield* membersOf(group.id),
      name: group.name,
    } satisfies InstanceGroup
  }
)

/** The group an instance is in, with everything else in it, or null. */
export const instanceGroupOfEffect = Effect.fn("instanceGroups.of")(function* (
  instanceId: string
) {
  const database = yield* Database
  const rows = yield* database.queryRows<MemberRow>(
    "instance_group_of",
    `SELECT group_id FROM ${databaseTable("instance_group_member")}
      WHERE instance_id = ?`,
    [instanceId]
  )
  const membership = rows.at(0)
  return membership ? yield* loadInstanceGroupEffect(membership.group_id) : null
})

// A group is its members: without any, nothing keeps it. Only a group that
// just lost a member is looked at: one being installed has none yet.
const dropIfEmpty = (transaction: DatabaseTransaction, groupId: string) =>
  transaction.execute(
    `DELETE FROM ${databaseTable("instance_group")}
      WHERE id = ?
        AND NOT EXISTS (
          SELECT 1 FROM ${databaseTable("instance_group_member")}
           WHERE group_id = ?
        )`,
    [groupId, groupId]
  )

/**
 * Takes an instance out of its group, as when it is deleted. Safe to run
 * again, and for an instance in no group.
 */
export const removeInstanceGroupMemberEffect = Effect.fn(
  "instanceGroups.removeMember"
)(function* (instanceId: string) {
  const database = yield* Database
  yield* database.transaction("instanceGroups.removeMember", (transaction) =>
    Effect.gen(function* () {
      const [membership] = yield* transaction.queryRows<MemberRow>(
        `SELECT group_id FROM ${databaseTable("instance_group_member")}
          WHERE instance_id = ?`,
        [instanceId]
      )
      if (!membership) return
      yield* transaction.execute(
        `DELETE FROM ${databaseTable("instance_group_member")}
          WHERE instance_id = ?`,
        [instanceId]
      )
      yield* dropIfEmpty(transaction, membership.group_id)
    })
  )
})

/** Forgets a group. Its members stay as they are, in no group. */
export const deleteInstanceGroupEffect = Effect.fn("instanceGroups.delete")(
  function* (groupId: string) {
    const database = yield* Database
    yield* database.transaction("instanceGroups.delete", (transaction) =>
      Effect.gen(function* () {
        yield* transaction.execute(
          `DELETE FROM ${databaseTable("instance_group_member")}
            WHERE group_id = ?`,
          [groupId]
        )
        yield* transaction.execute(
          `DELETE FROM ${databaseTable("instance_group")} WHERE id = ?`,
          [groupId]
        )
      })
    )
  }
)

/**
 * The statements that take a removed Relay's instances out of their groups,
 * for the transaction that removes the Relay.
 */
export const removeRelayFromInstanceGroups = (
  transaction: DatabaseTransaction,
  relayId: string
) =>
  Effect.gen(function* () {
    const left = yield* transaction.queryRows<MemberRow>(
      `SELECT DISTINCT group_id
         FROM ${databaseTable("instance_group_member")}
        WHERE relay_id = ?`,
      [relayId]
    )
    if (left.length === 0) return
    yield* transaction.execute(
      `DELETE FROM ${databaseTable("instance_group_member")}
        WHERE relay_id = ?`,
      [relayId]
    )
    for (const { group_id: groupId } of left) {
      yield* dropIfEmpty(transaction, groupId)
    }
  })
