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

import {
  visibleBricks,
  type VisibleBrick,
} from "@/server/visible-bricks.server"

// The Bricks an App is installed from: the App Bricks, of every catalog
// whoever installs it sees, that use only what Kiln runs for an App so far.
// Kiln's own catalog has one for each thing an App deploys, which make an
// App that is its owner's in every part; any other Brick is followed.

/** A secret Kiln makes for a Brick that asks for one, as a Relay does. */
export const makeBrickSecret = () => randomBytes(24).toString("base64url")

async function offeredApps(userId: string): Promise<Array<VisibleBrick>> {
  return (await visibleBricks(userId)).filter(
    ({ brick }) => appBrickProblem(brick) === null
  )
}

// The App Brick at a source, of those this person may install from.
async function requiredAppBrick(
  source: string,
  userId: string
): Promise<VisibleBrick> {
  const found = (await offeredApps(userId)).find(
    ({ brick }) => brick.source === source
  )
  if (!found) throw new Error("This isn't an App Brick in your catalogs")
  return found
}

/**
 * What someone adding an App picks from: the App Bricks, and the groups
 * that make an App with what it needs beside it.
 */
export async function offeredAppBricks(userId: string): Promise<Array<Brick>> {
  const { groupBricks } = await import("@/server/group-bricks.server")
  const [apps, groups] = await Promise.all([offeredApps(userId), groupBricks()])
  return [
    ...apps.map(({ brick }) => brick),
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
  source: string,
  userId: string
): Promise<ReadonlyArray<string>> {
  return appBrickVolumes((await requiredAppBrick(source, userId)).brick)
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
  answers: Readonly<Record<string, BrickVariableValue>>,
  userId: string
): Promise<{ deploys: AppBrickDeploy; follows: AppBrickRecord | undefined }> {
  const { brick, own } = await requiredAppBrick(source, userId)
  const { iconSvg: _iconSvg, source: _source, ...recipe } = brick
  const answered = brickInstallAnswers(recipe, answers, makeBrickSecret)
  const installed = appBrickDeploy(recipe, answered)
  if ("problem" in installed) throw new Error(installed.problem)
  return {
    deploys: installed.deploy,
    // By its ID in Kiln's own catalog: another catalog's Brick by that ID
    // is someone's Brick, followed like any other.
    follows:
      own && genericAppBrickIds.has(recipe.metadata.id)
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
