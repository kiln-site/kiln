import { readFile } from "node:fs/promises"
import { resolve, sep } from "node:path"

import type { Plugin } from "vite-plus"

const serverDirectory = resolve(import.meta.dirname, "../web/src/server") + sep
const exportedName =
  /^export (?:async function\*?|function\*?|const|let|class|enum) (\w+)/gmu
const reexport = /^export \{[^}]*\} from "[^"]+"/gmu

// Hearth's server functions never run on the marketing site, but the demos
// render Hearth components whose modules import them. Each `apps/web/src/server`
// module therefore builds as stubs that throw when called, so none of Hearth's
// server code, its database, or its secrets reach the site's bundles.
// Re-exports from client-safe modules pass through unchanged.
export function stubHearthServer(): Plugin {
  return {
    name: "kiln-marketing:stub-hearth-server",
    enforce: "pre",
    async load(id) {
      const file = id.split("?")[0] ?? id
      if (!file.startsWith(serverDirectory)) return null
      const source = await readFile(file, "utf8")
      const stubs = [...source.matchAll(exportedName)].map(
        ([, name]) =>
          `export const ${name} = () => {\n  throw new Error(${JSON.stringify(`${name} runs only in Hearth`)})\n}`
      )
      return [...(source.match(reexport) ?? []), ...stubs].join("\n")
    },
  }
}
