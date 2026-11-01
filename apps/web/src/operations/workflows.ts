import { Layer } from "effect"

import { deliverInvitation } from "@/lib/access-invitation-delivery"
import { deployAppOperation } from "@/lib/app-deployments.server"
import { githubSyncRunOperation } from "@/lib/github-sync.server"
import { deleteResource, keepResource } from "@/lib/resource-deletion.server"
import {
  rollBackLegacyServerMigration,
  serverMigration,
} from "@/lib/server-migrations.server"
import { deleteTailscaleNetwork } from "@/lib/tailscale-cleanup.server"
import { rewriteTailscaleDns } from "@/lib/tailscale-dns.server"

/**
 * Every workflow Hearth runs, registered with the engine when it starts. An
 * operation kind adds its handler here; one removed must stay until its
 * unfinished runs have drained.
 */
export const HearthWorkflows = Layer.mergeAll(
  deliverInvitation.layer,
  deployAppOperation.layer,
  githubSyncRunOperation.layer,
  deleteResource.layer,
  keepResource.layer,
  serverMigration.layer,
  rollBackLegacyServerMigration.layer,
  deleteTailscaleNetwork.layer,
  rewriteTailscaleDns.layer
)
