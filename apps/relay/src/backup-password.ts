// Run as `kiln-relay backup-password <repository-id>`, anywhere the Relay's
// image runs, with no Relay, Docker or network: prints the password that
// Kiln's recovery code gives one repository of incremental backups.
import { basename } from "node:path"

import {
  backupRepositoryPassword,
  backupRepositoryRoot,
  decodeRecoveryCode,
} from "@workspace/contracts"

import { readRecoveryCode } from "./recovery-code-input.js"

// The last folder of where the repository is, so its whole path does too.
const repositoryId = basename(process.argv[3] ?? "")
if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(repositoryId)) {
  console.error(
    "Usage: kiln-relay backup-password <repository>; the recovery code is read from standard input"
  )
  process.exit(1)
}
const key = decodeRecoveryCode(await readRecoveryCode())
if (key === null) {
  console.error("Error: A recovery code starts with kiln-rk-")
  process.exit(1)
}
console.log(
  await backupRepositoryPassword(await backupRepositoryRoot(key), repositoryId)
)
process.exit()
