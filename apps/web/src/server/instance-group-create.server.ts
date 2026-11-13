import {
  appEnvironmentWith,
  groupConnectionEnvironment,
  type BrickVariableValue,
  type GroupConnection,
} from "@workspace/contracts"
import { Effect } from "effect"

import {
  addInstanceGroupMemberEffect,
  createInstanceGroupEffect,
  deleteInstanceGroupEffect,
  loadInstanceGroupEffect,
  type InstanceGroupMember,
} from "@/effect/instance-groups"
import { reserveInstanceIdEffect } from "@/effect/instance-ids"
import { appNameExistsEffect, loadAppConfigEffect } from "@/effect/managed-apps"
import {
  loadManagedDatabaseCredentialEffect,
  managedDatabaseNameExistsEffect,
} from "@/effect/managed-databases"
import { promiseEffect, recoverPromise } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import { requireRelayPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  exclusive,
  instanceGroupKey,
  relayKey,
  resourceKey,
  shared,
} from "@/operations/lanes"
import {
  operation,
  runOperationPromise,
  signedIn,
} from "@/operations/operation"
import {
  brickVolumeLocks,
  brickVolumes,
  type BrickVolume,
} from "@/server/app-brick-volumes.server"
import { publishedBy } from "@/server/app-bricks.server"
import { addressNewApp, provisionApp } from "@/server/app-create.server"
import { askAppDeploy } from "@/server/app-deploy-ask.server"
import { createDatabase } from "@/server/database-create.server"
import { publishGroupChange } from "@/server/instance-group-access.server"
import {
  groupDatabaseConnection,
  installedGroupBrick,
  type InstalledGroupBrick,
} from "@/server/group-bricks.server"
import { requiredRelay } from "@/server/managed-database-access"

export interface CreateInstanceGroupInput {
  /** The group Brick it is installed from, by its source. */
  brick: string
  // The same for every try of one create, so a retry gets the same IDs.
  idempotencyKey: string
  /** The group's name, and its members' unless the Brick names them. */
  name: string
  /** Every member goes on this Relay. */
  relayId: string
  /** Its Brick's answers. */
  variables?: Record<string, BrickVariableValue>
}

// What it makes, each with the ID it was given and the name it takes.
interface GroupPlan {
  answers: InstalledGroupBrick["answers"]
  brick: InstalledGroupBrick["brick"]
  apps: Array<
    InstalledGroupBrick["apps"][number] & {
      id: string
      /** A volume for each folder it keeps. */
      keeps: Array<BrickVolume>
      name: string
    }
  >
  databases: Array<
    InstalledGroupBrick["databases"][number] & { id: string; name: string }
  >
  id: string
}

// A member takes the group's name while it is the only one of its kind,
// and the name its Brick calls it after the group's otherwise.
const memberName = (
  group: string,
  member: { key: string; name?: string },
  alone: boolean
) => (member.name ?? (alone ? group : `${group} ${member.key}`)).slice(0, 120)

// Settled before the operation, as an App's IDs are: what it makes decides
// its lanes and who may run it.
const planGroupEffect = Effect.fn("instanceGroups.create.plan")(function* (
  input: CreateInstanceGroupInput,
  userId: string
) {
  const installed = yield* promiseEffect(() =>
    installedGroupBrick(input.brick, input.variables ?? {})
  )
  const requestKey = `instance-group.create:${userId}:${input.idempotencyKey}`
  const id = yield* reserveInstanceIdEffect("group", requestKey)
  const databases = yield* Effect.forEach(installed.databases, (database) =>
    Effect.map(
      reserveInstanceIdEffect("database", `${requestKey}:${database.key}`),
      (reserved) => ({
        ...database,
        id: reserved,
        name: memberName(
          input.name,
          database,
          installed.databases.length === 1
        ),
      })
    )
  )
  const apps = yield* Effect.forEach(installed.apps, (app) =>
    Effect.map(
      reserveInstanceIdEffect("app", `${requestKey}:${app.key}`),
      (reserved) => {
        const name = memberName(input.name, app, installed.apps.length === 1)
        return {
          ...app,
          id: reserved,
          keeps: brickVolumes({ id: reserved, name }, app.volumes),
          name,
        }
      }
    )
  )
  return {
    answers: installed.answers,
    apps,
    brick: installed.brick,
    databases,
    id,
  } satisfies GroupPlan
})

// Holds the group it makes and every member, by the IDs they were given,
// and their Relay shared, so it isn't removed meanwhile. Making a member
// takes the permission that making it alone does.
const createInstanceGroup = operation<
  CreateInstanceGroupInput & { plan: GroupPlan }
>()({
  name: "instance-group.create",
  doing: "Installing this group",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.tap((person) =>
        promiseEffect(async () => {
          const { plan, relayId } = input
          if (plan.apps.length > 0) {
            await requireRelayPermission({
              permission: "app.create",
              relayId,
              user: person,
            })
          }
          // Publishing a port on the Relay takes what publishing one in an
          // App's settings does.
          if (plan.apps.some((app) => (app.ports?.length ?? 0) > 0)) {
            await requireRelayPermission({
              permission: "app.manage",
              relayId,
              user: person,
            })
          }
          if (plan.databases.length > 0) {
            await requireRelayPermission({
              permission: "database.create",
              relayId,
              user: person,
            })
          }
        })
      )
    ),
  locks: ({ input }) => [
    exclusive(instanceGroupKey(input.plan.id)),
    shared(relayKey(input.relayId)),
    ...input.plan.databases.map((database) =>
      exclusive(resourceKey("database", input.relayId, database.id))
    ),
    ...input.plan.apps.flatMap((app) => [
      exclusive(resourceKey("app", input.relayId, app.id)),
      ...brickVolumeLocks(input.relayId, app.keeps),
    ]),
  ],
  run: ({ context: user, input }) =>
    promiseEffect(() => createInstanceGroupHandler(user, input)),
  audit: ({ input }) => ({
    id: input.plan.id,
    kind: "instance-group",
    relayId: input.relayId,
  }),
})

async function createInstanceGroupHandler(
  user: AuthenticatedUser,
  data: CreateInstanceGroupInput & { plan: GroupPlan }
) {
  const { plan } = data
  const relay = await requiredRelay(data.relayId)
  // Before anything is made: a name already taken leaves nothing behind.
  for (const database of plan.databases) {
    const taken = await runAppEffect(
      "managedDatabases.name.preflight",
      managedDatabaseNameExistsEffect(relay.id, database.name)
    )
    if (taken) {
      throw new Error(
        `A database named "${database.name}" already exists on ${relay.name}`
      )
    }
  }
  for (const app of plan.apps) {
    const taken = await runAppEffect(
      "apps.name.preflight",
      appNameExistsEffect(relay.id, app.name)
    )
    if (taken) {
      throw new Error(
        `An app named "${app.name}" already exists on ${relay.name}`
      )
    }
  }
  await runAppEffect(
    "instanceGroups.create",
    createInstanceGroupEffect({
      brick: {
        answers: plan.answers,
        databases: Object.fromEntries(
          plan.databases.map((database) => [
            database.key,
            { brick: database.brickId, variables: database.variables },
          ])
        ),
        source: plan.brick.source,
      },
      createdBy: user.id,
      id: plan.id,
      name: data.name,
    })
  )
  // A member that can't be made ends it there. What was made before it
  // stays, in the group, for whoever installs it to keep or delete.
  await Effect.runPromise(
    promiseEffect(() => makeMembers(user, relay, plan)).pipe(
      Effect.tapError(() => forgetEmptyGroup(plan.id))
    )
  )
  publishGroupChange({ members: [{ relayId: relay.id }] })
  return {
    apps: plan.apps.map(({ id, name, web }) => ({ id, name, web })),
    databases: plan.databases.map(({ id, name }) => ({ id, name })),
    id: plan.id,
    relayId: relay.id,
  }
}

// The databases come first: an App's first deployment already has the
// variables it reaches them by.
async function makeMembers(
  user: AuthenticatedUser,
  relay: Awaited<ReturnType<typeof requiredRelay>>,
  plan: GroupPlan
) {
  const connections: Record<string, GroupConnection> = {}
  const ids: Record<string, string> = {}
  for (const database of plan.databases) {
    await joining(
      plan.id,
      {
        instanceId: database.id,
        kind: "database",
        member: database.key,
        relayId: relay.id,
      },
      () =>
        runOperationPromise(
          createDatabase,
          {
            brick: database.brick,
            id: database.id,
            name: database.name,
            relayId: relay.id,
            variables: database.variables,
          },
          { user }
        ),
      () =>
        runAppEffect(
          "managedDatabases.credential.internal",
          loadManagedDatabaseCredentialEffect(relay.id, database.id)
        ).then((kept) => kept !== null)
    )
    ids[database.key] = database.id
    connections[database.key] = await groupDatabaseConnection(
      relay.id,
      database.id
    )
  }
  for (const app of plan.apps) {
    const connected = groupConnectionEnvironment(app, connections, plan.answers)
    if ("problem" in connected) throw new Error(connected.problem)
    // What the Brick sets itself, then what reaches its databases.
    const variables = { ...app.environment, ...connected.environment }
    await joining(
      plan.id,
      { instanceId: app.id, kind: "app", member: app.key, relayId: relay.id },
      () =>
        provisionApp(user, relay, {
          // It follows the group's Brick, as the App of it that it is. Its
          // answers are the group's.
          brick: {
            answers: {},
            connect: Object.keys(app.connect),
            environment: Object.keys(variables),
            member: app.key,
            name: plan.brick.name,
            ...publishedBy(app.ports),
            revision: plan.brick.revision,
            source: plan.brick.source,
            volumes: [...app.volumes],
          },
          databaseIds: Object.keys(app.connect).flatMap(
            (key) => ids[key] ?? []
          ),
          deploys: {
            ...(app.command === undefined ? {} : { command: app.command }),
            environment: variables,
            image: app.image,
            ...(app.ports === undefined ? {} : { ports: app.ports }),
            ...(app.ready === undefined ? {} : { ready: app.ready }),
            type: "image",
            volumes: app.volumes,
          },
          environment: appEnvironmentWith("", [], variables),
          id: app.id,
          name: app.name,
          volumes: app.keeps,
        }),
      () =>
        runAppEffect(
          "apps.config.internal",
          loadAppConfigEffect(relay.id, app.id)
        ).then((kept) => kept !== null)
    )
  }
}

// Makes a member and puts it in the group. One that couldn't be made but
// whose record Hearth kept, because its Relay never said it had let go of
// it, joins the group all the same: it may be running, and deleting the
// group has to reach it.
async function joining(
  groupId: string,
  member: InstanceGroupMember,
  make: () => Promise<unknown>,
  /** Whether Hearth still has its record. */
  kept: () => Promise<boolean>
) {
  const failed = await recoverPromise(
    () => make().then(() => null),
    (cause) => ({ cause })
  )
  if (failed === null || (await kept())) {
    await runAppEffect(
      "instanceGroups.addMember",
      addInstanceGroupMemberEffect(groupId, member)
    )
  }
  if (failed !== null) throw failed.cause
}

// A group nothing was made for isn't one.
const forgetEmptyGroup = (groupId: string) =>
  promiseEffect(() =>
    runAppEffect(
      "instanceGroups.forgetEmpty",
      Effect.gen(function* () {
        const group = yield* loadInstanceGroupEffect(groupId)
        if (group && group.members.length === 0) {
          yield* deleteInstanceGroupEffect(groupId)
        }
      })
    )
  ).pipe(Effect.catch(() => Effect.void))

/**
 * Installs a group Brick for someone: its databases, then its Apps
 * connected to them, kept together as a group. Each App is then asked for
 * its first deployment, a deploy of its own which whoever installed the
 * group may not be allowed: the group exists either way, and says why an
 * App wasn't deployed.
 */
export async function createInstanceGroupFor(
  user: AuthenticatedUser,
  data: CreateInstanceGroupInput
) {
  const plan = await runAppEffect(
    "instanceGroups.create.plan",
    planGroupEffect(data, user.id)
  )
  const created = await runOperationPromise(
    createInstanceGroup,
    { ...data, plan },
    { user }
  )
  // Each App gets its address, routed to its website when the Brick says
  // where that answers, before its first deployment.
  await Promise.all(
    created.apps.map((app) =>
      addressNewApp(user, { ...app, relayId: created.relayId })
    )
  )
  let deployError: string | null = null
  for (const app of created.apps) {
    const error = await recoverPromise(
      () =>
        runOperationPromise(
          askAppDeploy,
          {
            appId: app.id,
            awaitProvisioning: true,
            relayId: created.relayId,
            trigger: "manual",
          },
          { user }
        ).then(() => null),
      (cause) => (cause instanceof Error ? cause.message : String(cause))
    )
    deployError ??= error
  }
  return { ...created, deployError }
}
