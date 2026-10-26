import { createServerFn } from "@tanstack/react-start"
import { appServiceNameSchema, sniffIconImage } from "@workspace/contracts"
import { Effect } from "effect"
import { z } from "zod"

import {
  getIconDetailsEffect,
  removeIconsEffect,
  saveIconEffect,
} from "@/effect/icons"
import { runAppEffect } from "@/effect/runtime"
import {
  detectInstanceIconEffect,
  publishIconChange,
  readRelayIconEffect,
} from "@/lib/icon-detection.server"
import {
  ICON_SOURCE_MAX_BYTES,
  iconOriginSchema,
  iconSubjectSchema,
} from "@/lib/icons"
import { validateUploadedIcon } from "@/lib/icon-validation"
import { fetchPublicHttps } from "@/lib/public-https.server"
import { assertRequestRateLimit } from "@/lib/request-rate-limit"
import { requireEligibleResourceUser } from "@/server/auth"
import {
  authorizedIconSubject,
  iconIndexFor,
  requireIconFileAccess,
} from "@/server/icons.server"

// Icons for game servers, apps, databases, and accounts. Browsers prepare
// what people choose (square, small, WebP) and save it here; Hearth checks
// it again, keeps it, and serves it from /api/icons.

const subjectInput = z.strictObject({ subject: iconSubjectSchema })

/** The shown icon of everything the user may see, as digests by subject. */
export const getIconIndex = createServerFn({ method: "GET" }).handler(
  async () => iconIndexFor(await requireEligibleResourceUser())
)

/** A subject's custom and detected icons and where each came from. */
export const getIconDetails = createServerFn({ method: "GET" })
  .validator(subjectInput)
  .handler(async ({ data }) => {
    await authorizedIconSubject(data.subject, "read")
    return runAppEffect("icons.details", getIconDetailsEffect(data.subject))
  })

export const saveCustomIcon = createServerFn({ method: "POST" })
  .validator(
    subjectInput.extend({
      // A prepared icon is at most 256 KiB.
      contentBase64: z.base64().max(Math.ceil((256 * 1024) / 3) * 4),
      origin: iconOriginSchema.refine((origin) => origin.type !== "site", {
        message: "Choose where the icon came from",
      }),
    })
  )
  .handler(async ({ data }) => {
    await authorizedIconSubject(data.subject, "edit")
    const image = Buffer.from(data.contentBase64, "base64")
    const contentType = validateUploadedIcon(image)
    const changed = await runAppEffect(
      "icons.saveCustom",
      saveIconEffect(data.subject, "custom", {
        contentType,
        image,
        origin: data.origin,
      })
    )
    if (changed) publishIconChange(data.subject)
  })

export const removeCustomIcon = createServerFn({ method: "POST" })
  .validator(subjectInput)
  .handler(async ({ data }) => {
    await authorizedIconSubject(data.subject, "edit")
    const removed = await runAppEffect(
      "icons.removeCustom",
      removeIconsEffect(data.subject, "custom")
    )
    if (removed) publishIconChange(data.subject)
  })

/** Looks for a game server's or app's icon again, now. */
export const detectIcon = createServerFn({ method: "POST" })
  .validator(subjectInput)
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedIconSubject(data.subject, "edit")
    if (data.subject.kind !== "server" && data.subject.kind !== "app") {
      throw new Error("Kiln finds icons only for game servers and apps")
    }
    if (!relay) throw new Error("Relay not found")
    assertRequestRateLimit(`icons.detect:${user.id}`, 20, 60_000)
    const subject = data.subject
    await runAppEffect("icons.detect", detectInstanceIconEffect(relay, subject))
    return runAppEffect("icons.details", getIconDetailsEffect(subject))
  })

/**
 * An image from the web, for the browser to shrink into an icon, since it
 * can't read most sites' images itself. Only public HTTPS addresses.
 */
export const fetchIconSource = createServerFn({ method: "POST" })
  .validator(
    z.strictObject({
      url: z
        .url()
        .max(2_048)
        .refine((value) => value.startsWith("https://"), {
          message: "Enter an HTTPS address",
        }),
    })
  )
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    assertRequestRateLimit(`icons.fetch:${user.id}`, 30, 60_000)
    const response = await fetchPublicHttps(data.url, {
      accept: "image/*",
      maxBytes: ICON_SOURCE_MAX_BYTES,
    })
    const contentType = sniffIconImage(response.body)
    if (!contentType) throw new Error("That address isn't an image")
    return { contentBase64: response.body.toString("base64"), contentType }
  })

/**
 * An image from a game server's or app's files, or from inside one of an
 * app's containers, for the browser to shrink into an icon.
 */
export const readIconSourceFile = createServerFn({ method: "POST" })
  .validator(
    z.strictObject({
      path: z.string().min(1).max(1_024),
      service: appServiceNameSchema.optional(),
      subject: iconSubjectSchema,
    })
  )
  .handler(async ({ data }) => {
    const subject = data.subject
    if (subject.kind !== "server" && subject.kind !== "app") {
      throw new Error("Only game servers and apps have files to copy from")
    }
    const { relay, user } = await authorizedIconSubject(subject, "edit")
    if (!relay) throw new Error("Relay not found")
    await requireIconFileAccess(user, subject)
    const path = data.path.trim()
    const input =
      subject.kind === "app" && data.service
        ? { appId: subject.id, path, service: data.service }
        : {
            instanceId:
              subject.kind === "app" ? `app:${subject.id}` : subject.id,
            path: path.replace(/^\/+/u, ""),
          }
    const icon = await runAppEffect(
      "icons.readSourceFile",
      readRelayIconEffect(relay, input, user.id).pipe(
        Effect.mapError((cause) =>
          cause instanceof Error ? cause : new Error(String(cause))
        )
      )
    )
    if (!icon) throw new Error(`Nothing is at ${path}`)
    return {
      contentBase64: icon.bytes.toString("base64"),
      contentType: icon.contentType,
    }
  })
