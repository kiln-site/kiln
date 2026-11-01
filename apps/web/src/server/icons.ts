import { createServerFn } from "@tanstack/react-start"
import {
  appFileRootId,
  appServiceNameSchema,
  fileRootIdSchema,
  relayIdSchema,
  sniffIconImage,
} from "@workspace/contracts"
import { Effect } from "effect"
import { z } from "zod"

import { getIconDetailsEffect } from "@/effect/icons"
import { resolveMinecraftProfileEffect } from "@/effect/minecraft-profile"
import { runAppEffect } from "@/effect/runtime"
import {
  detectInstanceIconEffect,
  iconLaneKey,
  readRelayIconEffect,
  removeCustomIconEffect,
  saveCustomIconEffect,
} from "@/lib/icon-detection.server"
import {
  ICON_SOURCE_MAX_BYTES,
  iconOriginSchema,
  iconSubjectSchema,
  type IconSubject,
} from "@/lib/icons"
import { validateUploadedIcon } from "@/lib/icon-validation"
import { isMinecraftUsername } from "@/lib/minecraft-profile"
import { fetchPublicHttps } from "@/lib/public-https.server"
import { activeRelay } from "@/lib/relay-registry"
import { assertRequestRateLimit } from "@/lib/request-rate-limit"
import { requireEligibleResourceUser } from "@/server/auth"
import {
  authorizedIconSubject,
  iconIndexFor,
  iconSubjectFor,
  requireFileRootRead,
  requireIconFileAccess,
} from "@/server/icons.server"
import { promiseEffect } from "@/effect/promise"
import { exclusive } from "@/operations/lanes"
import {
  operation,
  runOperationPromise,
  signedIn,
} from "@/operations/operation"

// Icons for game servers, apps, databases, and accounts. Browsers prepare
// what people choose (square, small, WebP) and save it here; Hearth checks
// it again, keeps it, and serves it from /api/icons.

const subjectInput = z.strictObject({ subject: iconSubjectSchema })

// A change to one subject's icon, as an operation: the person may edit it,
// and with `files`, read the files it's taken from.
const iconOperation = <
  Input extends { readonly subject: IconSubject },
  A,
>(definition: {
  readonly name: string
  readonly doing: string
  readonly files?: boolean
  readonly run: (
    context: Awaited<ReturnType<typeof iconSubjectFor>>,
    input: Input
  ) => Promise<A>
}) =>
  operation<Input>()({
    name: definition.name,
    doing: definition.doing,
    authorize: ({ input, user }) =>
      signedIn(user).pipe(
        Effect.flatMap((person) =>
          promiseEffect(async () => {
            const context = await iconSubjectFor(person, input.subject, "edit")
            const subject = input.subject
            if (
              definition.files &&
              (subject.kind === "server" || subject.kind === "app")
            ) {
              await requireIconFileAccess(person, subject)
            }
            return context
          })
        )
      ),
    locks: ({ input }) => [exclusive(iconLaneKey(input.subject))],
    run: ({ context, input }) =>
      promiseEffect(() => definition.run(context, input)),
    audit: ({ input }) =>
      input.subject.kind === "user"
        ? { id: input.subject.id, kind: "user" }
        : {
            id: input.subject.id,
            kind:
              input.subject.kind === "server" ? "instance" : input.subject.kind,
            relayId: input.subject.relayId,
          },
  })

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

const saveCustomInputSchema = subjectInput.extend({
  // A prepared icon is at most 256 KiB.
  contentBase64: z.base64().max(Math.ceil((256 * 1024) / 3) * 4),
  // Files are linked with linkIconFile instead; sites are only found.
  origin: iconOriginSchema.refine(
    (origin) => origin.type !== "site" && origin.type !== "file",
    { message: "Choose where the icon came from" }
  ),
})

const saveCustom = iconOperation({
  name: "icon.save",
  doing: "Changing this icon",
  run: async (_context, data: z.infer<typeof saveCustomInputSchema>) => {
    const image = Buffer.from(data.contentBase64, "base64")
    const contentType = validateUploadedIcon(image)
    const digest = await runAppEffect(
      "icons.saveCustom",
      saveCustomIconEffect(data.subject, {
        contentType,
        image,
        origin: data.origin,
      })
    )
    return { digest }
  },
})

export const saveCustomIcon = createServerFn({ method: "POST" })
  .validator(saveCustomInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(saveCustom, data, {
      user: await requireEligibleResourceUser(),
    })
  )

const removeCustom = iconOperation({
  name: "icon.remove",
  doing: "Changing this icon",
  run: async ({ relay }, data: z.infer<typeof subjectInput>) => {
    const digest = await runAppEffect(
      "icons.removeCustom",
      removeCustomIconEffect(relay, data.subject)
    )
    return { digest }
  },
})

export const removeCustomIcon = createServerFn({ method: "POST" })
  .validator(subjectInput)
  .handler(async ({ data }) =>
    runOperationPromise(removeCustom, data, {
      user: await requireEligibleResourceUser(),
    })
  )

/** Looks for a game server's or app's icon again, now. */
const detect = iconOperation({
  name: "icon.detect",
  doing: "Looking for this icon",
  run: async ({ relay, user }, data: z.infer<typeof subjectInput>) => {
    if (data.subject.kind !== "server" && data.subject.kind !== "app") {
      throw new Error("Kiln finds icons only for game servers and apps")
    }
    if (!relay) throw new Error("Relay not found")
    assertRequestRateLimit(`icons.detect:${user.id}`, 20, 60_000)
    const subject = data.subject
    await runAppEffect("icons.detect", detectInstanceIconEffect(relay, subject))
    return runAppEffect("icons.details", getIconDetailsEffect(subject))
  },
})

export const detectIcon = createServerFn({ method: "POST" })
  .validator(subjectInput)
  .handler(async ({ data }) =>
    runOperationPromise(detect, data, {
      user: await requireEligibleResourceUser(),
    })
  )

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

/**
 * Makes a game server's or app's icon follow one of its files, or a file
 * inside one of an app's containers: Hearth copies it now and again
 * whenever it changes. It's read with the person's own access.
 */
const linkFileInputSchema = z.strictObject({
  path: z.string().min(1).max(1_024),
  service: appServiceNameSchema.optional(),
  subject: iconSubjectSchema,
})

const linkFile = iconOperation({
  name: "icon.link",
  doing: "Changing this icon",
  files: true,
  run: async ({ relay, user }, data: z.infer<typeof linkFileInputSchema>) => {
    const subject = data.subject
    if (subject.kind !== "server" && subject.kind !== "app") {
      throw new Error("Only game servers and apps have files to link")
    }
    if (!relay) throw new Error("Relay not found")
    const path = data.path.trim()
    const service = subject.kind === "app" ? data.service : undefined
    const origin = service
      ? { type: "file" as const, path, service }
      : { type: "file" as const, path: path.replace(/^\/+/u, "") }
    const icon = await runAppEffect(
      "icons.linkFile",
      readRelayIconEffect(
        relay,
        service
          ? { appId: subject.id, path, service }
          : {
              instanceId:
                subject.kind === "app" ? appFileRootId(subject.id) : subject.id,
              path: origin.path,
            },
        user.id
      ).pipe(
        Effect.mapError((cause) =>
          cause instanceof Error ? cause : new Error(String(cause))
        )
      )
    )
    if (!icon) throw new Error(`Nothing is at ${path}`)
    const digest = await runAppEffect(
      "icons.saveLinked",
      saveCustomIconEffect(subject, {
        contentType: icon.contentType,
        image: icon.bytes,
        origin,
        originVersion: icon.version,
      })
    )
    return { digest }
  },
})

export const linkIconFile = createServerFn({ method: "POST" })
  .validator(linkFileInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(linkFile, data, {
      user: await requireEligibleResourceUser(),
    })
  )

/**
 * A Minecraft player's head, for the browser to make a picture of. Mojang
 * says whose the name is; the head is drawn from that account's skin.
 */
export const fetchMinecraftHead = createServerFn({ method: "GET" })
  .validator(z.strictObject({ username: z.string().trim().min(1).max(32) }))
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    assertRequestRateLimit(`icons.minecraft:${user.id}`, 30, 60_000)
    if (!isMinecraftUsername(data.username)) {
      throw new Error("Minecraft usernames are 3–16 letters, digits, or _")
    }
    const profile = await runAppEffect(
      "icons.minecraftProfile",
      resolveMinecraftProfileEffect(data.username)
    )
    if (!profile)
      throw new Error(`No Minecraft player is named ${data.username}`)
    const head = await fetchPublicHttps(
      `https://mc-heads.net/avatar/${encodeURIComponent(profile.id)}/256.png`,
      { accept: "image/png", maxBytes: ICON_SOURCE_MAX_BYTES }
    )
    if (sniffIconImage(head.body) !== "image/png") {
      throw new Error("Couldn't get that player's head")
    }
    return {
      contentBase64: head.body.toString("base64"),
      contentType: "image/png" as const,
      username: profile.name,
    }
  })

/**
 * An image from any files the user can read, for the browser to make their
 * picture of, when it can't read the file from the Relay directly.
 */
export const readPictureSourceFile = createServerFn({ method: "POST" })
  .validator(
    z.strictObject({
      path: z.string().min(1).max(1_024),
      relayId: relayIdSchema,
      rootId: fileRootIdSchema,
    })
  )
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    await requireFileRootRead(user, data.relayId, data.rootId)
    const relay = await activeRelay(data.relayId)
    const path = data.path.replace(/^\/+/u, "")
    const icon = await runAppEffect(
      "icons.readPictureSource",
      readRelayIconEffect(
        relay,
        { instanceId: data.rootId, path },
        user.id
      ).pipe(
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
