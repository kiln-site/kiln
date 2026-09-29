import type { Migration } from "@/effect/migrations"

import { baseline } from "./0001_baseline"

// Append new migrations with the next id. Never edit or reorder applied ones.
export const migrations: ReadonlyArray<Migration> = [baseline]
