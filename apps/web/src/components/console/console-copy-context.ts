import * as React from "react"

import { consoleCopy, type ConsoleCopy } from "@/lib/console-copy"

// The shared console UI reads its wording from here; pages for other kinds of
// resource than servers provide theirs.
export const ConsoleCopyContext = React.createContext<ConsoleCopy>(
  consoleCopy.instance
)

export function useConsoleCopy(): ConsoleCopy {
  return React.useContext(ConsoleCopyContext)
}
