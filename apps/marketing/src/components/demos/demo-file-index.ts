import { infiniteQueryOptions, QueryClient } from "@tanstack/react-query"
import type { RelayDirectoryPage } from "@workspace/contracts"

import {
  directorySizeBatches,
  relayDirectorySizesQueryOptions,
} from "@/components/files/file-query-options"
import { FileTreeIndex } from "@/components/files/file-tree-index"
import { queryKeys } from "@/lib/query-options"

import {
  demoDirectorySizes,
  demoEntries,
} from "~/components/demos/editor-files"
import { demoServer } from "~/components/demos/demo-server"

// Never stale, so Hearth's components never ask the Relay to refresh.
const forever = { updatedAt: Number.MAX_SAFE_INTEGER }

// Hearth's file index for the demo server, reading folders from the demo's
// files instead of a Relay.
class DemoFileIndex extends FileTreeIndex {
  override directoryOptions(directory: string) {
    const options = super.directoryOptions(directory)
    return infiniteQueryOptions({
      ...options,
      queryFn: (): RelayDirectoryPage => ({
        cursor: null,
        directory,
        entries: demoEntries.filter((entry) => isChild(entry.path, directory)),
        instanceId: demoServer.id,
      }),
      staleTime: Infinity,
    })
  }
}

// A query client holding what Hearth's file components read: each folder's
// listing, the folders' sizes, and the server's file activity (no pins).
export function createDemoFiles() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  const fileIndex = new DemoFileIndex({
    instanceId: demoServer.id,
    queryClient,
    relayId: demoServer.relayId,
  })
  const directories = ["", ...Object.keys(demoDirectorySizes)]
  for (const directory of directories) {
    const entries = demoEntries.filter((entry) =>
      isChild(entry.path, directory)
    )
    for (const paths of directorySizeBatches(entries)) {
      queryClient.setQueryData(
        relayDirectorySizesQueryOptions(
          queryClient,
          demoServer.relayId,
          demoServer.id,
          paths
        ).queryKey,
        {
          backoffAttempt: 0,
          instanceId: demoServer.id,
          pending: [],
          pollAttempt: 0,
          sizes: Object.fromEntries(
            paths.map((path) => [path, demoDirectorySizes[path] ?? 0])
          ),
        },
        forever
      )
    }
  }
  queryClient.setQueryData(
    queryKeys.fileActivity(demoServer.relayId, demoServer.id),
    { files: [], instanceId: demoServer.id },
    forever
  )
  return { fileIndex, queryClient }
}

function isChild(path: string, directory: string) {
  if (!path.startsWith(directory) || path === directory) return false
  const rest = path.slice(directory.length).replace(/\/$/u, "")
  return !rest.includes("/")
}
