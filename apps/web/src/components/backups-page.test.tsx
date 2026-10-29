import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router"
import { expect, it } from "vite-plus/test"
import { TooltipProvider } from "@workspace/ui/components/tooltip"
import { relayInstanceSchema } from "@workspace/contracts"

import { BackupsPage } from "@/components/backups-page"
import { createBackupSearchStore } from "@/components/backups/state"
import type { BackupRun } from "@/lib/backup-runs"
import { relayFleetInstance } from "@/lib/relay-fleet"
import {
  accessCapabilitiesQueryOptions,
  appBackupsQueryOptions,
  appDirectoryQueryOptions,
  backupRunsInfiniteQueryOptions,
  backupStorageQueryOptions,
  managedDatabaseDirectoryQueryOptions,
  relaySnapshotQueryOptions,
} from "@/lib/query-options"

it("resolves backup identity cards by target kind and Relay, keeping missing targets readable", () => {
  const client = new QueryClient()
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ["/backups/runs"] }),
  })
  const targetId = "d1e518cf".repeat(5)
  const missingId = "f34e95b9".repeat(5)
  client.setQueryData(accessCapabilitiesQueryOptions().queryKey, {
    canManageAccess: false,
    canManageRelays: false,
    canUpdateHearth: false,
    canUpdateRelays: false,
    grants: [],
    isPlatformAdmin: false,
    isRelayCreator: false,
    pendingScopes: [],
    relayConfigured: true,
    user: {
      email: "user@example.test",
      emailVerified: true,
      id: "user-a",
      isDevelopmentBypass: false,
      name: "User",
      role: "user",
      twoFactorEnabled: false,
    },
  })
  client.setQueryData(backupStorageQueryOptions().queryKey, [])
  client.setQueryData(appDirectoryQueryOptions().queryKey, [])
  client.setQueryData(relaySnapshotQueryOptions().queryKey, {
    nodes: [],
    instances: [
      server(targetId, "The Group Palworld", "relay-a"),
      server(targetId, "Another game", "relay-b"),
    ],
  })
  client.setQueryData(managedDatabaseDirectoryQueryOptions().queryKey, [
    {
      createdAt: "2026-10-23T12:00:00.000Z",
      databaseName: "world",
      engine: "mysql",
      hasCredentials: true,
      hostname: "database-world",
      id: targetId,
      image: "mysql:8.4",
      internalPort: 3306,
      name: "World database",
      permissions: [],
      relayId: "relay-a",
      relayName: "Relay A",
      shortId: targetId.slice(0, 8),
      supportsImportExport: true,
    },
  ])
  const backups = [
    backupRun("first", targetId, "instance", "relay-a"),
    backupRun("second", targetId, "instance", "relay-b"),
    backupRun("database", targetId, "database", "relay-a"),
    backupRun("missing", missingId, "instance", "relay-a"),
    backupRun("platform", "kiln-installation", "platform", "relay-a"),
  ]
  client.setQueryData(
    backupRunsInfiniteQueryOptions({
      direction: "desc",
      search: "",
      sort: "createdAt",
      scope: null,
      status: null,
    }).queryKey,
    { pageParams: [null], pages: [{ items: backups, nextCursor: null }] }
  )

  try {
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <RouterContextProvider router={router}>
          <TooltipProvider>
            <BackupsPage
              filters={{}}
              onFiltersChange={() => {}}
              searchStore={createBackupSearchStore("")}
            />
          </TooltipProvider>
        </RouterContextProvider>
      </QueryClientProvider>
    )
    const targetCells = [...markup.matchAll(/<td\b[^>]*>(.*?)<\/td>/gs)]
      .map((match) => match[1]!)
      .filter((cell) => cell.includes("Status: Checking"))
    expect(targetCells).toHaveLength(backups.length)
    for (const [index, name] of [
      "The Group Palworld",
      "Another game",
      "World database",
      missingId.slice(0, 8),
      "Kiln",
    ].entries()) {
      expect(targetCells[index]).toContain(`>${name}</span>`)
    }
    expect(targetCells[0]).toContain("/server/relay-a-d1e518cf/console")
    expect(targetCells[1]).toContain("/server/relay-b-d1e518cf/console")
    expect(targetCells[2]).toContain("/infra/databases")
    expect(targetCells[3]).not.toContain("href=")
  } finally {
    client.clear()
  }
})

it("waits to offer New Backup until a scoped volume is found, so it can't back up the whole App instead", () => {
  const appId = "a1b2c3d4".repeat(5)
  const volume = `${appId}/data`
  const render = (backups: unknown) => {
    const client = new QueryClient()
    const router = createRouter({
      routeTree: createRootRoute(),
      history: createMemoryHistory({ initialEntries: ["/backups/runs"] }),
    })
    client.setQueryData(accessCapabilitiesQueryOptions().queryKey, {
      canManageAccess: true,
      canManageRelays: true,
      canUpdateHearth: true,
      canUpdateRelays: true,
      grants: [],
      isPlatformAdmin: true,
      isRelayCreator: false,
      pendingScopes: [],
      relayConfigured: true,
      user: {
        email: "admin@example.test",
        emailVerified: true,
        id: "admin",
        isDevelopmentBypass: false,
        name: "Admin",
        role: "admin",
        twoFactorEnabled: false,
      },
    })
    client.setQueryData(backupStorageQueryOptions().queryKey, [])
    client.setQueryData(appDirectoryQueryOptions().queryKey, [
      {
        createdAt: "2026-10-23T12:00:00.000Z",
        id: appId,
        name: "Website",
        permissions: [],
        relayId: "relay-a",
        relayName: "Relay A",
        shortId: appId.slice(0, 8),
      },
    ])
    client.setQueryData(relaySnapshotQueryOptions().queryKey, {
      nodes: [],
      instances: [],
    })
    client.setQueryData(managedDatabaseDirectoryQueryOptions().queryKey, [])
    if (backups) {
      client.setQueryData(
        appBackupsQueryOptions("relay-a", appId).queryKey,
        backups as never
      )
    }
    try {
      const markup = renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <RouterContextProvider router={router}>
            <TooltipProvider>
              <BackupsPage
                filters={{
                  kind: "app",
                  relay: "relay-a",
                  server: appId,
                  volume,
                }}
                onFiltersChange={() => {}}
                searchStore={createBackupSearchStore("")}
              />
            </TooltipProvider>
          </RouterContextProvider>
        </QueryClientProvider>
      )
      const button = /<button[^>]*aria-label="New Backup"[^>]*>/u.exec(markup)
      expect(button).not.toBeNull()
      return /\sdisabled=""/u.test(button![0])
    } finally {
      client.clear()
    }
  }
  const listed = (available: boolean) => ({
    available,
    batch: [],
    targets: [
      {
        id: appId,
        kind: "app",
        latest: null,
        name: null,
        restore: null,
        unfinished: null,
      },
      ...(available
        ? [
            {
              id: volume,
              kind: "volume",
              latest: null,
              name: "data",
              restore: null,
              unfinished: null,
            },
          ]
        : []),
    ],
    uncovered: [],
    used: [],
  })

  // Still looking it up, or its Relay can't say whether it exists.
  expect(render(null)).toBe(true)
  expect(render(listed(false))).toBe(true)
  // Found, so New Backup opens with it chosen.
  expect(render(listed(true))).toBe(false)
})

function server(id: string, name: string, relayId: string) {
  return relayFleetInstance(
    relayInstanceSchema.parse({
      connectAddress: "127.0.0.1:8211",
      containerId: null,
      desiredState: "stopped",
      directory: "/games/palworld",
      game: "Palworld",
      id,
      implementation: "palworld",
      javaVersion: "none",
      name,
      observedState: "stopped",
      service: "palworld",
      shortId: id.slice(0, 8),
      status: "stopped",
      version: "latest",
    }),
    { id: relayId, name: relayId }
  )
}

function backupRun(
  id: string,
  targetId: string,
  targetKind: BackupRun["targetKind"],
  relayId: string
): BackupRun {
  return {
    artifacts: [],
    artifactKind: "archive",
    backupMode: "full",
    batchId: null,
    consistency: null,
    bytes: 1024,
    checksumSha256: null,
    completedAt: "2026-10-23T12:00:00.000Z",
    createdAt: "2026-10-23T12:00:00.000Z",
    filename: null,
    id,
    name: `Backup ${id}`,
    orderKey: { id, value: 0 },
    reason: "manual",
    relayId,
    relayPresent: true,
    resticSnapshotId: null,
    status: "available",
    storageId: null,
    targetId,
    targetKind,
    taskBytesCompleted: 0,
    taskBytesTotal: null,
    taskCurrentArtifactId: null,
    taskCurrentPath: null,
    taskError: null,
    taskErrorCode: null,
    taskId: `${id}-task`,
    taskKind: "create",
    taskPhase: null,
    taskStartedAt: null,
    taskStatus: "succeeded",
    taskUpdatedAt: "2026-10-23T12:00:00.000Z",
    warnings: [],
  }
}
