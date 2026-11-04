import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import { appIdFromFileRoot, isRelayFileRoot } from "@workspace/contracts"

import { showToast } from "@workspace/ui/components/sonner"

import { recoverPromise } from "@/effect/promise"
import {
  base64ToBlob,
  blobToBase64,
  prepareIconImage,
} from "@/lib/icon-image"
import { ICON_SOURCE_MAX_BYTES, type InstanceIconSubject } from "@/lib/icons"
import { changeIcon } from "@/lib/icon-changes"
import { iconIndexQueryOptions } from "@/lib/query-options"
import { readRelayFile, RelayTransferError } from "@/lib/relay-file-transfer"
import {
  linkIconFile,
  readPictureSourceFile,
  saveCustomIcon,
} from "@/server/icons"

// Using an image in someone's files as an icon, from the Files page. A game
// server's or app's own file becomes its icon by link, so the icon follows
// the file as it changes. A picture is the person's own, so it's copied:
// shrunk and converted in the browser like an upload.

const IMAGE_PATH = /\.(?:gif|ico|jpe?g|png|svg|webp)$/iu

export function isIconImagePath(path: string): boolean {
  return IMAGE_PATH.test(path)
}

/** The game server or app whose files these are; null for a Relay's host. */
export function fileRootIconSubject(root: {
  id: string
  relayId: string
}): (InstanceIconSubject & { kind: "app" | "server" }) | null {
  if (isRelayFileRoot(root.id)) return null
  const appId = appIdFromFileRoot(root.id)
  return appId
    ? { kind: "app", relayId: root.relayId, id: appId }
    : { kind: "server", relayId: root.relayId, id: root.id }
}

function fileName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback
}

export function useFileIconActions(root: { id: string; relayId: string }) {
  const queryClient = useQueryClient()
  const subject = fileRootIconSubject(root)

  const setInstanceIcon = React.useCallback(
    async (path: string) => {
      if (!subject) return
      const noun = subject.kind === "app" ? "App" : "Game server"
      const outcome = await recoverPromise(
        async () => {
          await changeIcon(queryClient, subject, () =>
            linkIconFile({ data: { path, subject } })
          )
          return null
        },
        (cause) => errorMessage(cause, `Could not set the ${noun.toLowerCase()} icon`)
      )
      showToast(
        outcome
          ? { message: outcome, type: "error" }
          : {
              message: `${noun} icon now follows ${fileName(path)}`,
              type: "success",
            }
      )
    },
    [queryClient, subject]
  )

  const setPicture = React.useCallback(
    async (path: string) => {
      const outcome = await recoverPromise(
        async () => {
          const index = await queryClient.ensureQueryData(
            iconIndexQueryOptions()
          )
          const source = await readPictureFile(root, path)
          const picture = await prepareIconImage(source, "cover")
          URL.revokeObjectURL(picture.previewUrl)
          const self = { kind: "user" as const, id: index.selfId }
          const contentBase64 = await blobToBase64(picture.blob)
          await changeIcon(queryClient, self, () =>
            saveCustomIcon({
              data: { contentBase64, origin: { type: "upload" }, subject: self },
            })
          )
          return null
        },
        (cause) => errorMessage(cause, "Could not set your picture")
      )
      showToast(
        outcome
          ? { message: outcome, type: "error" }
          : { message: "Picture updated", type: "success" }
      )
    },
    [queryClient, root]
  )

  return { subject, setInstanceIcon, setPicture }
}

// Straight from the Relay when the page can reach it, else through Hearth.
async function readPictureFile(
  root: { id: string; relayId: string },
  path: string
): Promise<Blob> {
  const direct = await recoverPromise(
    () =>
      readRelayFile({
        instanceId: root.id,
        maxBytes: ICON_SOURCE_MAX_BYTES,
        path,
        relayId: root.relayId,
      }),
    (cause) => cause
  )
  if (direct instanceof Blob) return direct
  if (!(direct instanceof RelayTransferError) || direct.reason !== "unavailable") {
    throw direct
  }
  const read = await readPictureSourceFile({
    data: { path, relayId: root.relayId, rootId: root.id },
  })
  return base64ToBlob(read.contentBase64, read.contentType)
}
