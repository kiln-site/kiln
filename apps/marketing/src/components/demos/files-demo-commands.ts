// What the files section's feature list can ask the files demo to do. The
// demo loads on its own, so a request made before it mounts waits for it.
export type FilesDemoCommand =
  | "open-tree"
  | "search"
  | "open-nbt"
  | "open-sqlite"

let handler: ((command: FilesDemoCommand) => void) | null = null
let pending: FilesDemoCommand | null = null

export function sendFilesDemoCommand(command: FilesDemoCommand) {
  if (handler) handler(command)
  else pending = command
}

export function onFilesDemoCommand(next: (command: FilesDemoCommand) => void) {
  handler = next
  if (pending) {
    next(pending)
    pending = null
  }
  return () => {
    if (handler === next) handler = null
  }
}
