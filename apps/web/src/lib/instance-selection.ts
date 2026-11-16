// The sidebar remembers its selection in one cookie: a game server's ID
// alone, or a database's, app's, Relay's or tunnel's ID after its kind, so the
// sidebar knows which directory to open it from without loading them all.
export function instanceSelection(prefix: "app" | "db" | "relay" | "tunnel") {
  const marker = `${prefix}:`
  return {
    fromSelection(selection: string | null | undefined): string | null {
      return selection?.startsWith(marker)
        ? selection.slice(marker.length)
        : null
    },
    toSelection(id: string): string {
      return `${marker}${id}`
    },
  }
}
