// Runs in the short-lived helper a tar restore starts, as root, with the
// volume or App folder it restores mounted at `/volume`: one step of
// swapping the restored copy in (see `./backups/tar-restore-steps.ts`).
import {
  runTarRestoreStep,
  type TarRestoreStep,
} from "./backups/tar-restore-steps.js"

const [step, staging, uid, gid, mode] = process.argv.slice(2)
await runTarRestoreStep(
  "/volume",
  step as TarRestoreStep,
  staging ?? "",
  uid && gid && mode
    ? { gid: Number(gid), mode: Number(mode), uid: Number(uid) }
    : null
)
