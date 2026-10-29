import { z } from "zod"

/**
 * What deleting any game server, database, App, or volume asks, in the
 * browser and the CLI alike: its name, typed, and the account password.
 * The request names the resource by its ID, so the typed name only has to
 * show the person meant this one; a name is what they recognize, where
 * pasting an ID they never read proves little.
 */
export const deleteConfirmationSchema = z.object({
  confirmation: z.string().max(256),
  password: z.string().max(128),
})

export type DeleteConfirmation = z.infer<typeof deleteConfirmationSchema>

/** Whether a typed confirmation names the resource, ignoring outer spaces. */
export function confirmationMatches(typed: string, name: string): boolean {
  const expected = name.trim()
  return expected.length > 0 && typed.trim() === expected
}
