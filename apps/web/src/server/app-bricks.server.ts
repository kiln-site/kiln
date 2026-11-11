import {
  appBrickDeploy,
  appBrickProblem,
  type AppBrickDeploy,
  type Brick,
  type BrickVariableValue,
} from "@workspace/contracts"

import { defaultBrickCatalog } from "@/server/brick-catalogs.server"

// The Bricks an App is installed from: the App Bricks of Kiln's own catalog
// that use only what Kiln runs for an App so far. Another catalog's aren't
// offered or accepted yet: an App doesn't record which Brick it came from,
// so one from elsewhere would be read as Kiln's own from then on. For the
// same reason Kiln's catalog has one for each thing an App deploys and no
// more, until an App records its Brick.

/** Every App Brick an App may be installed from. */
export async function appBricks(): Promise<Array<Brick>> {
  const catalog = await defaultBrickCatalog()
  return (catalog?.bricks ?? []).filter(
    (brick) => appBrickProblem(brick) === null
  )
}

/**
 * What someone adding an App picks from: the App Bricks, and the groups
 * that make an App with what it needs beside it.
 */
export async function offeredAppBricks(): Promise<Array<Brick>> {
  const { groupBricks } = await import("@/server/group-bricks.server")
  const [apps, groups] = await Promise.all([appBricks(), groupBricks()])
  return [
    ...apps,
    ...groups.filter((group) =>
      Object.values(group.group?.members ?? {}).some(
        (member) => "kind" in member && member.kind === "app"
      )
    ),
  ]
}

/** What the App Brick at a source deploys with these answers. */
export async function installedAppBrick(
  source: string,
  answers: Readonly<Record<string, BrickVariableValue>>
): Promise<AppBrickDeploy> {
  const brick = (await appBricks()).find(
    (candidate) => candidate.source === source
  )
  if (!brick) throw new Error("This isn't one of Kiln's App Bricks")
  const { iconSvg: _iconSvg, source: _source, ...recipe } = brick
  const installed = appBrickDeploy(recipe, answers)
  if ("problem" in installed) throw new Error(installed.problem)
  return installed.deploy
}
