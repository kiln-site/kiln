import type { Migration } from "@/effect/migrations"

import { baseline } from "./0001_baseline"
import { utcInstants } from "./0002_utc_instants"
import { revokeTrustedDevices } from "./0003_revoke_trusted_devices"

// Append new migrations with the next id. Never edit or reorder applied ones.
export const migrations: ReadonlyArray<Migration> = [
  baseline,
  utcInstants,
  revokeTrustedDevices,
]
