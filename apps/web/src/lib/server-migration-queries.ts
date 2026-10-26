import { queryOptions } from "@tanstack/react-query"

import {
  getServerMigrations,
  previewServerMigration,
} from "@/server/server-migrations"

/**
 * The signed-in person's copies of game servers, polled while one runs, so
 * its progress keeps moving should a realtime update be missed.
 */
export function serverMigrationsQueryOptions() {
  return queryOptions({
    queryKey: ["server-migrations"],
    queryFn: () => getServerMigrations(),
    refetchInterval: (query) =>
      query.state.data?.some(
        (migration) =>
          migration.state === "running" || migration.state === "cancelling"
      )
        ? 2_000
        : false,
    staleTime: 10_000,
  })
}

/** What the Move or duplicate dialog offers for one game server. */
export function serverMigrationPreviewQueryOptions(server: {
  instanceId: string
  relayId: string
}) {
  return queryOptions({
    queryKey: [
      "server-migrations",
      "preview",
      server.relayId,
      server.instanceId,
    ],
    queryFn: () => previewServerMigration({ data: server }),
    // Long enough that the dialog opens on what pointing at its button
    // fetched; starting the copy checks everything again.
    staleTime: 30_000,
    retry: false,
  })
}
