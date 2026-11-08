import { isInstanceId, type InstanceIdKind } from "@workspace/contracts"

/**
 * The names an instance's Docker resources and folders go by.
 *
 * An instance's ID is 12 hexadecimal characters. Instances created before
 * those IDs had an older one (a 40-character hex ID, or a Relay's key
 * fingerprint), and the one-time migration
 * (`instance-id-migration.ts`) gave each a new ID without renaming or
 * moving anything: Docker can't rename volumes or networks or change a
 * container's labels, and moving data risks it. So everything physical
 * named after an ID — containers, networks, volumes, Compose projects,
 * folders, image tags, backup repositories — is named after `physicalKey`,
 * the old ID for an instance that had one and the ID itself otherwise, and
 * whatever reads an ID back from a label, a folder or a name passes it
 * through `currentId`, which turns an old ID into its new one.
 *
 * The map is read from SQLite once, at startup, before anything reads
 * Docker. Until then, as in tests, every ID is its own key.
 */
export interface InstanceLegacyId {
  readonly id: string
  readonly kind: InstanceIdKind
  readonly legacyId: string
}

let legacyById = new Map<string, string>()
let idByLegacy = new Map<string, string>()

/** Replaces the map with the migration's, as SQLite has it. */
export function useInstanceLegacyIds(
  entries: Iterable<InstanceLegacyId>
): void {
  const byId = new Map<string, string>()
  const byLegacy = new Map<string, string>()
  for (const entry of entries) {
    byId.set(entry.id, entry.legacyId)
    byLegacy.set(entry.legacyId, entry.id)
  }
  legacyById = byId
  idByLegacy = byLegacy
}

/** The old ID an instance had before the migration, if it had one. */
export function legacyInstanceId(id: string): string | null {
  return legacyById.get(id) ?? null
}

/** What an instance's Docker resources and folders are named after. */
export function physicalKey(id: string): string {
  return legacyById.get(id) ?? id
}

/**
 * The part of a name that used an old ID's first 8 characters, such as a
 * game server's container `kiln-<8>`: a migrated instance keeps it, a new
 * one uses its whole ID, which is never shortened.
 */
export function physicalShortKey(id: string): string {
  return legacyById.get(id)?.slice(0, 8) ?? id
}

/** The current ID for an ID read back from a label, folder or name. */
export function currentId(value: string): string {
  return idByLegacy.get(value) ?? value
}

/**
 * The instance ID a label, folder or name carries: a current one as it is,
 * an old one as its new one, and null for anything else.
 */
export function instanceIdFrom(
  value: string | null | undefined
): string | null {
  if (!value) return null
  // A Relay's old ID, its fingerprint, is case-sensitive; hex IDs aren't.
  const id = idByLegacy.get(value) ?? currentId(value.toLowerCase())
  return isInstanceId(id) ? id : null
}
