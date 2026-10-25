/**
 * Each transfer is a record on disk, `<transferId>.json`, beside its data,
 * so a Relay that restarts knows its transfers: which artifacts it still
 * serves, and which pulls it should resume.
 */
import { mkdir, readdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Option, Schema } from "effect"

import { writeFileAtomic } from "../../effect/atomic-file.js"

export const ensureTransferDirectory = (directory: string) =>
  Effect.tryPromise(() => mkdir(directory, { mode: 0o700, recursive: true }))

/** The records in `directory` that decode; others are left alone. */
export const readTransferRecords = Effect.fnUntraced(function* <A, I>(
  directory: string,
  schema: Schema.Codec<A, I>
) {
  yield* ensureTransferDirectory(directory)
  const names = yield* Effect.tryPromise(() => readdir(directory))
  const decode = Schema.decodeUnknownOption(Schema.fromJsonString(schema))
  const records: Array<A> = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    const text = yield* Effect.tryPromise(() =>
      readFile(join(directory, name), "utf8")
    ).pipe(Effect.option)
    const record = Option.flatMap(text, decode)
    if (Option.isSome(record)) records.push(record.value)
  }
  return records
})

export const writeTransferRecord = <A, I>(
  directory: string,
  transferId: string,
  schema: Schema.Codec<A, I>,
  record: A
) =>
  Effect.suspend(() =>
    writeFileAtomic(
      join(directory, `${transferId}.json`),
      `${Schema.encodeSync(Schema.fromJsonString(schema))(record)}\n`,
      0o600
    )
  )

/** Removes a transfer's record and every file named for it. */
export const removeTransferFiles = (directory: string, transferId: string) =>
  Effect.tryPromise(async () => {
    for (const name of await readdir(directory)) {
      if (name === transferId || name.startsWith(`${transferId}.`)) {
        await rm(join(directory, name), { force: true, recursive: true })
      }
    }
  })
