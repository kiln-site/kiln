import { Layer } from "effect"

import { deliverInvitation } from "@/lib/access-invitation-delivery"
import { deployAppOperation } from "@/lib/app-deployments.server"
import { githubSyncRunOperation } from "@/lib/github-sync.server"
import { deleteResource, keepResource } from "@/lib/resource-deletion.server"
import {
  rollBackLegacyServerMigration,
  serverMigration,
} from "@/lib/instance-migrations.server"
import { deleteTunnel } from "@/lib/tunnel-deletion.server"
import { rewriteTailscaleDns } from "@/lib/tunnel-dns.server"
import { pruneTunnelGateways } from "@/lib/tunnel-gateway-pruning.server"

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
  deleteTunnel.layer,
  rewriteTailscaleDns.layer,
  pruneTunnelGateways.layer
)
