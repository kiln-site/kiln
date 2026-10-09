import type { RelayBrowserResourceKind } from "@workspace/contracts"

// What the UI calls a resource's console output. Servers have a console;
// other kinds of resource only show their logs.
export interface ConsoleCopy {
  // The search field's placeholder and label.
  readonly search: string
  // The stream, lowercase, as in "the console stream".
  readonly stream: string
  // Notices over the output, uppercase, as in "CONSOLE CONNECTION FAILED".
  readonly notice: string
}

export const consoleCopy: Record<RelayBrowserResourceKind, ConsoleCopy> = {
  app: { notice: "LOG", search: "Search logs", stream: "log stream" },
  database: { notice: "LOG", search: "Search logs", stream: "log stream" },
  instance: {
    notice: "CONSOLE",
    search: "Search console",
    stream: "console stream",
  },
}
