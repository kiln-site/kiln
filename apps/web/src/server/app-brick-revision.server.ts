import {
  appBrickDeploy,
  appBrickProblem,
  appBrickPublishes,
  appEnvironmentVariables,
  appEnvironmentWith,
  brickInstallAnswers,
  brickInputs,
  groupBrickInstall,
  groupBrickProblem,
  groupConnectionEnvironment,
  type AppBrickDeploy,
  type BrickInputValue,
  type BrickRecipe,
  type GroupConnection,
} from "@workspace/contracts"
import { Effect } from "effect"

import {
  changeInstanceGroupBrickEffect,
  instanceGroupOfEffect,
} from "@/effect/instance-groups"
import {
  changeAppEffect,
  loadAppConfigEffect,
  type AppBrickRecord,
} from "@/effect/managed-apps"
import { runAppEffect } from "@/effect/runtime"
import type { PersistedRelay } from "@/lib/relay-registry"
import { publishAppChange } from "@/server/app-access"
import { makeBrickSecret } from "@/server/app-bricks.server"
import { groupDatabaseConnection } from "@/server/group-bricks.server"

// An App follows its Brick by being made from it again: a newer revision,
// with the answers it already has, decides again what the Brick set, and
// leaves the rest of the App as its owner has it.

/** A Brick at its newest revision, as a catalog has it now. */
export interface NewestBrick {
  definition: BrickRecipe
  name: string
  revision: number
  source: string
}

// What a revision sets: the App's image, how it starts, its variables, how
// it is checked, and what the App keeps of the Brick from then on. Never
// the ports it publishes, which are its owner's once it is installed, as
// its routes are: a revision that publishes other ports of its container
// is refused (`samePorts`).
interface Revised {
  /** Its start command, or none: its image's own. */
  command: string | undefined
  environment: Record<string, string>
  /**
   * What it runs: an image, or a Dockerfile or Compose file, with the file
   * itself when the Brick carries it. A file in the App's own source is
   * left where it is.
   */
  runs:
    | { image: string; type: "image" }
    | { content: string | undefined; type: "compose" | "dockerfile" }
  /** The command it is ready by, or none: its health check either way. */
  ready: string | undefined
  record: AppBrickRecord
}

// A revision changes what an App runs, never which folders it keeps: a
// folder it newly kept would have no volume, and one it dropped would
// leave its volume mounted for nothing.
function sameFolders(
  newest: NewestBrick,
  kept: ReadonlyArray<string>,
  keeps: ReadonlyArray<string>
) {
  // As lists: a folder's name isn't held to what a member's key is.
  if (JSON.stringify([...kept].sort()) !== JSON.stringify([...keeps].sort())) {
    throw refused(
      newest,
      "it keeps other folders than this App was installed with. Install it again to take it."
    )
  }
  return [...kept]
}

// Nor which ports of its container it publishes on its Relay. Where each
// is published is its owner's, and a revision never changes that, so one
// that listened on another port would leave the old one published to
// nothing; and one that newly published a port would open it unasked.
function samePorts(
  newest: NewestBrick,
  published: ReadonlyArray<string> | undefined,
  publishes: AppBrickDeploy["ports"]
) {
  if (!sameKeys(published ?? [], appBrickPublishes(publishes))) {
    throw refused(
      newest,
      "it publishes other ports than this App was installed with. Install it again to take it."
    )
  }
  return published === undefined ? {} : { ports: [...published] }
}

// A revision's answers: those the App already has that it still asks for,
// kept as they are, and for an input it newly asks, what that comes to
// now, its default or a secret made for it. An answer to an input it
// dropped is forgotten.
function answersFor(
  recipe: BrickRecipe,
  kept: Readonly<Record<string, BrickInputValue>>
) {
  const asked = new Set(brickInputs(recipe).map((input) => input.key))
  return brickInstallAnswers(
    recipe,
    Object.fromEntries(Object.entries(kept).filter(([key]) => asked.has(key))),
    makeBrickSecret
  )
}

const sameKeys = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  [...left].sort().join("\n") === [...right].sort().join("\n")

const refused = (newest: NewestBrick, why: string) =>
  new Error(
    `Revision ${newest.revision} of ${newest.name} can't be installed: ${why}`
  )

// An App made from an App Brick of its own.
function revisedAlone(brick: AppBrickRecord, newest: NewestBrick): Revised {
  const problem = appBrickProblem(newest.definition)
  if (problem !== null) throw refused(newest, problem)
  const answers = answersFor(newest.definition, brick.answers)
  const installed = appBrickDeploy(newest.definition, answers)
  if ("problem" in installed) throw refused(newest, installed.problem)
  const { deploy } = installed
  // A file it carried stays one it carries, and one in the App's own
  // source stays there: the other way round, the App would be left with a
  // file nothing updates, or with two.
  const written = deploy.type !== "image" && deploy.content !== undefined
  if (written !== (brick.written === true)) {
    throw refused(
      newest,
      written
        ? "it carries its file now, and this App has its own. Install it again to take it."
        : "it no longer carries the file this App runs. Install it again to take it."
    )
  }
  return {
    command: deploy.command,
    environment: deploy.environment,
    ready: deploy.ready,
    runs:
      deploy.type === "image"
        ? { image: deploy.image, type: "image" }
        : { content: deploy.content, type: deploy.type },
    record: {
      answers,
      environment: Object.keys(deploy.environment),
      name: newest.name,
      ...samePorts(newest, brick.ports, deploy.ports),
      revision: newest.revision,
      source: newest.source,
      volumes: sameFolders(newest, brick.volumes, deploy.volumes),
      ...(written ? { written: true } : {}),
    },
  }
}

// An App that is one of a group Brick's: made again from the group's
// answers, and given again the addresses of the databases it is connected
// to.
async function revisedInGroup(
  relay: PersistedRelay,
  appId: string,
  follows: AppBrickRecord & { member: string },
  newest: NewestBrick
): Promise<Revised> {
  const group = await runAppEffect(
    "instanceGroups.of",
    instanceGroupOfEffect(appId)
  )
  const gone = () =>
    refused(newest, "it is no longer in the group its Brick made")
  if (!group) throw gone()
  const problem = groupBrickProblem(newest.definition)
  if (problem !== null) throw refused(newest, problem)
  // How each of the group's databases is reached now, read before the
  // group's answers are held.
  const connections: Record<string, GroupConnection> = {}
  for (const instance of group.members) {
    if (instance.kind === "database" && instance.member) {
      connections[instance.member] = await groupDatabaseConnection(
        relay.id,
        instance.instanceId
      )
    }
  }
  // Decided against the answers the group has by then, and kept with them
  // as one step: another of its Apps taking the revision meanwhile gets the
  // secret this one made, not one of its own.
  const revised = await runAppEffect(
    "instanceGroups.changeBrick",
    changeInstanceGroupBrickEffect(group.id, (kept) =>
      Effect.try({
        try: () => {
          const answers = answersFor(newest.definition, kept.answers)
          const installed = groupBrickInstall(newest.definition, answers)
          if ("problem" in installed) throw refused(newest, installed.problem)
          const { apps, databases } = installed.install
          // An update changes what its members run, never which members
          // there are.
          if (
            !sameKeys(
              [...apps, ...databases].map(({ key }) => key),
              group.members.map((instance) => instance.member ?? "")
            )
          ) {
            throw refused(
              newest,
              "it makes other members than this group has. Install it again to take it."
            )
          }
          // Nor what a database is: one made from another Brick, or with
          // other answers, such as another version, would be another
          // database.
          const same = (left: unknown, right: unknown) =>
            JSON.stringify(left, Object.keys(Object(left)).sort()) ===
            JSON.stringify(right, Object.keys(Object(right)).sort())
          const changed = databases.find((database) => {
            const was = kept.databases[database.key]
            return (
              !was ||
              was.brick !== database.brick ||
              !same(was.variables, database.variables)
            )
          })
          if (changed) {
            throw refused(
              newest,
              `it makes ${changed.key} another way than this group's was made. Install it again to take it.`
            )
          }
          const app = apps.find(({ key }) => key === follows.member)
          if (!app) throw refused(newest, `it no longer has ${follows.member}`)
          // Nor which databases an App reaches: it would be written the
          // address of one it was never connected to.
          if (!sameKeys(Object.keys(app.connect), follows.connect ?? [])) {
            throw refused(
              newest,
              "it connects this App to other databases than it was installed with. Install it again to take it."
            )
          }
          const connected = groupConnectionEnvironment(
            app,
            connections,
            answers
          )
          if ("problem" in connected) throw refused(newest, connected.problem)
          const environment = { ...app.environment, ...connected.environment }
          return {
            // What this revision's answers came to is the group's from now
            // on, whatever becomes of this App's update: a default it
            // resolved, a secret it made.
            keep: { answers, databases: kept.databases },
            made: {
              command: app.command,
              environment,
              ready: app.ready,
              runs: app.runs,
              record: {
                answers: {},
                connect: follows.connect ?? [],
                environment: Object.keys(environment),
                member: follows.member,
                name: newest.name,
                ...samePorts(newest, follows.ports, app.ports),
                revision: newest.revision,
                source: newest.source,
                volumes: sameFolders(newest, follows.volumes, app.volumes),
                ...(app.runs.type === "image" ? {} : { written: true }),
              },
            } satisfies Revised,
          }
        },
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      })
    )
  )
  if (revised === null) throw gone()
  return revised
}

/**
 * Makes an App again from a newer revision of the Brick it follows, and
 * asks for the deployment that puts it to work. What the Brick set is the
 * revision's: its image or the file its Brick carries, its start command,
 * its health check, and its variables in place of those the Brick set
 * before. Every other line of its environment, and everything else about
 * it, stays. Whoever calls it holds the App's configuration.
 */
export async function installAppBrickRevision(
  relay: PersistedRelay,
  appId: string,
  newest: NewestBrick,
  by: { userId: string | null }
) {
  const app = await runAppEffect(
    "apps.config.internal",
    loadAppConfigEffect(relay.id, appId)
  )
  const follows = app?.brick
  if (!follows) throw new Error("This App follows no Brick")
  const { member } = follows
  const revised =
    member === undefined
      ? revisedAlone(follows, newest)
      : await revisedInGroup(relay, appId, { ...follows, member }, newest)
  await runAppEffect(
    "apps.brick.revise",
    changeAppEffect(relay.id, appId, ({ brick, config }) => {
      // Detached since: nothing of its is the Brick's any more.
      if (brick === null) {
        return Effect.fail(new Error("This App follows no Brick"))
      }
      // A variable the revision newly sets that its owner already set
      // themselves is theirs: the revision doesn't take it over.
      const own = appEnvironmentVariables(config.environment)
      const taken = Object.keys(revised.environment).find(
        (name) => !brick.environment.includes(name) && Object.hasOwn(own, name)
      )
      if (taken !== undefined) {
        return Effect.fail(
          refused(
            newest,
            `it sets ${taken}, which this App already sets itself. Remove ${taken} from the App's environment to take it.`
          )
        )
      }
      // What it deploys stays what it was installed as: an image doesn't
      // become a Compose project under an App set up for one.
      if (revised.runs.type !== config.sourceType) {
        return Effect.fail(
          refused(
            newest,
            "it deploys another way than this App was installed with. Install it again to take it."
          )
        )
      }
      // Its health check is the revision's, one it gives or none.
      const { healthcheck: _checked, ...rest } = config
      return Effect.succeed({
        brick: revised.record,
        config: {
          ...rest,
          command: revised.command ?? "",
          environment: appEnvironmentWith(
            config.environment,
            brick.environment,
            revised.environment
          ),
          ...(revised.ready === undefined
            ? {}
            : { healthcheck: { command: revised.ready } }),
          // Its image, or the file its Brick carries.
          ...(revised.runs.type === "image"
            ? { image: revised.runs.image }
            : revised.runs.content === undefined
              ? {}
              : { [revised.runs.type]: revised.runs.content }),
        },
      })
    })
  )
  publishAppChange(relay.id, false)
  const { askAppDeploymentEffect } =
    await import("@/lib/app-deployments.server")
  await runAppEffect(
    "apps.deploy",
    askAppDeploymentEffect({
      appId,
      brick: true,
      relayId: relay.id,
      trigger: "update",
      userId: by.userId,
    })
  )
}
