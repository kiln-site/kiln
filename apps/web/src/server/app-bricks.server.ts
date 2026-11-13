import { randomBytes } from "node:crypto"

import {
  appBrickDeploy,
  appBrickProblem,
  appBrickPublishes,
  appBrickVolumes,
  brickInstallAnswers,
  brickRevision,
  genericAppBrickIds,
  type AppBrickDeploy,
  type Brick,
  type BrickVariableValue,
} from "@workspace/contracts"

import type { AppBrickRecord } from "@/effect/managed-apps"

import { defaultBrickCatalog } from "@/server/brick-catalogs.server"

// The Bricks an App is installed from: the App Bricks of Kiln's own catalog
// that use only what Kiln runs for an App so far. Another catalog's aren't
// offered or accepted yet: an App doesn't record which Brick it came from,
// so one from elsewhere would be read as Kiln's own from then on. For the
// same reason Kiln's catalog has one for each thing an App deploys and no
// more, until an App records its Brick.

/** A secret Kiln makes for a Brick that asks for one, as a Relay does. */
export const makeBrickSecret = () => randomBytes(24).toString("base64url")

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

/**
 * The folders the App Brick at a source keeps, which no answer changes: an
 * install makes a volume for each, settled before it runs.
 */
export async function appBrickFolders(
  source: string
): Promise<ReadonlyArray<string>> {
  const brick = (await appBricks()).find(
    (candidate) => candidate.source === source
  )
  if (!brick) throw new Error("This isn't one of Kiln's App Bricks")
  return appBrickVolumes(brick)
}

/** What an App keeps of the ports its Brick published, when it has any. */
export function publishedBy(ports: AppBrickDeploy["ports"]) {
  const publishes = appBrickPublishes(ports)
  return publishes.length > 0 ? { ports: publishes } : {}
}

/**
 * What the App Brick at a source deploys with these answers, and what an
 * App made from it keeps of it: nothing for one of Kiln's generic Bricks.
 */
export async function installedAppBrick(
  source: string,
  answers: Readonly<Record<string, BrickVariableValue>>
): Promise<{ deploys: AppBrickDeploy; follows: AppBrickRecord | undefined }> {
  const brick = (await appBricks()).find(
    (candidate) => candidate.source === source
  )
  if (!brick) throw new Error("This isn't one of Kiln's App Bricks")
  const { iconSvg: _iconSvg, source: _source, ...recipe } = brick
  const answered = brickInstallAnswers(recipe, answers, makeBrickSecret)
  const installed = appBrickDeploy(recipe, answered)
  if ("problem" in installed) throw new Error(installed.problem)
  return {
    deploys: installed.deploy,
    follows: genericAppBrickIds.has(recipe.metadata.id)
      ? undefined
      : {
          answers: answered,
          environment: Object.keys(installed.deploy.environment),
          name: recipe.metadata.name,
          ...publishedBy(installed.deploy.ports),
          revision: brickRevision(recipe),
          source,
          volumes: [...installed.deploy.volumes],
          ...(installed.deploy.type !== "image" &&
          installed.deploy.content !== undefined
            ? { written: true }
            : {}),
        },
  }
}
