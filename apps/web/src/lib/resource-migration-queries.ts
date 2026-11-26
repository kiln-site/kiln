import { queryOptions } from "@tanstack/react-query"

import type { MigratedKindName } from "@/lib/resource-migration-input"
import {
  getResourceMigrations,
  getResourceMigrationServing,
  previewResourceMigration,
} from "@/server/resource-migrations"

/**
 * The signed-in person's moves and copies, polled while one runs, so its
 * progress keeps moving should a realtime update be missed.
 */
export function resourceMigrationsQueryOptions() {
  return queryOptions({
    queryKey: ["resource-migrations"],
    queryFn: () => getResourceMigrations(),
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

/** What the Move or duplicate dialog offers for one resource. */
export function resourceMigrationPreviewQueryOptions(resource: {
  id: string
  kind: MigratedKindName
  relayId: string
}) {
  const reference = {
    id: resource.id,
    kind: resource.kind,
    relayId: resource.relayId,
  }
  return queryOptions({
    queryKey: [
      "resource-migrations",
      "preview",
      reference.kind,
      reference.relayId,
      reference.id,
    ],
    queryFn: () => previewResourceMigration({ data: reference }),
    // Long enough that the dialog opens on what pointing at its button
    // fetched; starting the copy checks everything again.
    staleTime: 30_000,
    retry: false,
  })
}

/**
 * Whether domains moved with a resource to a Relay would work there. Asked
 * of the one chosen, once chosen: reaching it from outside takes seconds
 * when nothing answers.
 */
export function resourceMigrationServingQueryOptions(
  resource: { id: string; kind: MigratedKindName; relayId: string },
  destinationRelayId: string
) {
  return queryOptions({
    queryKey: [
      "resource-migrations",
      "serving",
      resource.relayId,
      resource.id,
      destinationRelayId,
    ],
    queryFn: () =>
      getResourceMigrationServing({
        data: {
          destinationRelayId,
          id: resource.id,
          kind: resource.kind,
          relayId: resource.relayId,
        },
      }),
    staleTime: 30_000,
    retry: false,
  })
}
