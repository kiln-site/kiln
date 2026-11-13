import { randomBytes } from "node:crypto"

import {
  appBrickDeploy,
  appBrickProblem,
  appBrickPublishes,
  appBrickVolumes,
  brickInstallAnswers,
  brickRevision,
  genericAppBrickIds,
  groupBrickProblem,
  type AppBrickDeploy,
  type Brick,
  type BrickVariableValue,
} from "@workspace/contracts"

import type { AppBrickRecord } from "@/effect/managed-apps"

import { hasPlatformPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { hydrateBrickIcon } from "@/lib/brick-catalog-source.server"
import {
  customBricksOf,
  installableBricks,
  visibleBricks,
  type VisibleBrick,
} from "@/server/visible-bricks.server"

// The Bricks an App is installed from: the App Bricks, of every catalog
// whoever installs it sees and of the links they saved themselves, that use
// only what Kiln runs for an App so far.
// Kiln's own catalog has one for each thing an App deploys, which make an
// App that is its owner's in every part; any other Brick is followed.

/** A secret Kiln makes for a Brick that asks for one, as a Relay does. */
export const makeBrickSecret = () => randomBytes(24).toString("base64url")

// The App Brick at a source, of those this person may install from.
async function requiredAppBrick(
  source: string,
  user: AuthenticatedUser
): Promise<VisibleBrick> {
  const found = (await installableBricks(user)).find(
    ({ brick }) => brick.source === source && appBrickProblem(brick) === null
  )
  if (!found) throw new Error("This isn't an App Brick in your catalogs")
  return found
}

// Whether adding an App offers a Brick: an App's, or a group's that makes
// an App with what it needs beside it.
const offeredForApps = (brick: Brick) =>
  appBrickProblem(brick) === null ||
  (groupBrickProblem(brick) === null &&
    Object.values(brick.group?.members ?? {}).some(
      (member) => "kind" in member && member.kind === "app"
    ))

/**
 * What someone adding an App picks from: the Bricks of the catalogs they
 * see, the ones they saved from links of their own, and whether they may
 * save another.
 */
export async function offeredAppBricks(user: AuthenticatedUser) {
  const [listed, custom] = await Promise.all([
    visibleBricks(user.id),
    customBricksOf(user),
  ])
  return {
    bricks: listed.map(({ brick }) => brick).filter(offeredForApps),
    canAddCustomBrick: hasPlatformPermission(
      user,
      "platform.bricks.add-custom"
    ),
    customBricks: await Promise.all(
      custom.filter(offeredForApps).map((brick) => hydrateBrickIcon(brick))
    ),
  }
}

/**
 * The folders the App Brick at a source keeps, which no answer changes: an
 * install makes a volume for each, settled before it runs.
 */
export async function appBrickFolders(
  source: string,
  user: AuthenticatedUser
): Promise<ReadonlyArray<string>> {
  return appBrickVolumes((await requiredAppBrick(source, user)).brick)
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
  user: AuthenticatedUser
): Promise<{ deploys: AppBrickDeploy; follows: AppBrickRecord | undefined }> {
  const { brick, own } = await requiredAppBrick(source, user)
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
