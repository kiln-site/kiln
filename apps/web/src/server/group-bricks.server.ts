import {
  brickInstallAnswers,
  brickRevision,
  databaseConnectionUrl,
  groupBrickInstall,
  groupBrickProblem,
  type Brick,
  type BrickVariableValue,
  type GroupBrickApp,
  type GroupConnection,
} from "@workspace/contracts"

import { makeBrickSecret } from "@/server/app-bricks.server"
import { databaseBricks } from "@/server/database-bricks.server"
import { requiredCredential } from "@/server/managed-database-access"
import { visibleBricks } from "@/server/visible-bricks.server"

// The group Bricks Kiln installs: those, of every catalog whoever installs
// one sees, that do only what Kiln does for a group so far. Each of its
// databases is made from one of Kiln's own database Bricks, whichever
// catalog the group is in: another catalog's database Bricks aren't run.

/** Every group Brick this person may install a group from. */
export async function groupBricks(userId: string): Promise<Array<Brick>> {
  return (await visibleBricks(userId)).flatMap(({ brick }) =>
    groupBrickProblem(brick) === null ? [brick] : []
  )
}

/** What a group Brick makes, with each database's Brick found. */
export interface InstalledGroupBrick {
  answers: Record<string, BrickVariableValue>
  /** The Brick itself, as what it makes keeps it. */
  brick: { name: string; revision: number; source: string }
  apps: Array<GroupBrickApp>
  databases: Array<{
    /** Its database Brick, by its source. */
    brick: string
    /** And by its ID in Kiln's own catalog, as the group keeps it. */
    brickId: string
    key: string
    variables: Record<string, BrickVariableValue>
  }>
}

/** What the group Brick at a source makes with these answers. */
export async function installedGroupBrick(
  source: string,
  answers: Readonly<Record<string, BrickVariableValue>>,
  userId: string
): Promise<InstalledGroupBrick> {
  const brick = (await groupBricks(userId)).find(
    (candidate) => candidate.source === source
  )
  if (!brick) throw new Error("This isn't a group Brick in your catalogs")
  const { iconSvg: _iconSvg, source: _source, ...recipe } = brick
  const installed = groupBrickInstall(
    recipe,
    brickInstallAnswers(recipe, answers, makeBrickSecret)
  )
  if ("problem" in installed) throw new Error(installed.problem)
  const offered = await databaseBricks()
  const databases = installed.install.databases.map((database) => {
    const found = offered.find(
      (candidate) => candidate.metadata.id === database.brick
    )
    if (!found) {
      throw new Error(
        `${database.key} isn't one of Kiln's database Bricks (${database.brick})`
      )
    }
    return { ...database, brick: found.source, brickId: database.brick }
  })
  return {
    ...installed.install,
    brick: {
      name: recipe.metadata.name,
      revision: brickRevision(recipe),
      source,
    },
    databases,
  }
}

/**
 * What reaching a database gives an App connected to it, as it is now: its
 * address on its Relay, and the login Hearth keeps for it.
 */
export async function groupDatabaseConnection(
  relayId: string,
  databaseId: string
): Promise<GroupConnection> {
  const credential = await requiredCredential(relayId, databaseId)
  const host = `database-${credential.databaseId}`
  return {
    connection: databaseConnectionUrl({
      databaseName: credential.databaseName,
      engine: credential.engine,
      host,
      password: encodeURIComponent(credential.password),
      port: credential.internalPort,
      username: credential.username,
    }),
    host,
    name: credential.databaseName,
    password: credential.password,
    port: String(credential.internalPort),
    username: credential.username,
  }
}
