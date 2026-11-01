import { Effect } from "effect"

import {
  loadPlatformAppearanceDefaultEffect,
  saveAppearanceOverrideEffect,
  savePlatformAppearanceDefaultEffect,
} from "@/effect/appearance-preferences"
import { hasPlatformPermission } from "@/lib/access-control"
import {
  normalizeAppearanceOverride,
  resolveAppearance,
  type ColorScheme,
} from "@/lib/appearance"
import { exclusive, partKey } from "@/operations/lanes"
import { operation, signedIn } from "@/operations/operation"

export interface AppearanceUpdate {
  readonly accentColor: string | null
  readonly colorScheme: ColorScheme
  readonly customColors: ReadonlyArray<string | null>
  /** Makes it, or stops it being, the appearance new people start with. */
  readonly defaultForNewUsers?: boolean | undefined
}

/**
 * Saves the person's appearance, and with `defaultForNewUsers` the platform's
 * default too. Their own is one row of theirs, holding nothing; the default
 * is made from the one stored, so saving it holds the default's lane and one
 * save of it goes after another. Only a change to the default is audited.
 */
export const saveAppearance = operation<AppearanceUpdate>()({
  name: "appearancePreferences.save",
  doing: "Saving the default appearance",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.tap((person) =>
        input.defaultForNewUsers !== undefined &&
        !hasPlatformPermission(person, "platform.appearance.manage-default")
          ? Effect.fail(
              new Error(
                "The platform.appearance.manage-default permission is required"
              )
            )
          : Effect.void
      )
    ),
  locks: ({ input }) =>
    input.defaultForNewUsers === undefined
      ? []
      : [exclusive(partKey("platform-appearance", "default"))],
  run: ({ context: user, input }) =>
    Effect.gen(function* () {
      const appearanceOverride = normalizeAppearanceOverride(input)
      const platformDefault = yield* loadPlatformAppearanceDefaultEffect()
      const appearance = resolveAppearance(
        appearanceOverride,
        input.defaultForNewUsers === false ? null : platformDefault
      )
      yield* saveAppearanceOverrideEffect(
        crypto.randomUUID(),
        user.id,
        appearanceOverride
      )
      if (input.defaultForNewUsers !== undefined) {
        yield* savePlatformAppearanceDefaultEffect(
          input.defaultForNewUsers ? appearance : null
        )
      }
      return {
        appearance,
        appearanceOverride,
        defaultForNewUsers:
          input.defaultForNewUsers ?? platformDefault !== null,
      }
    }),
  audit: ({ input }) =>
    input.defaultForNewUsers === undefined
      ? null
      : { id: "appearance", kind: "platform" },
})
