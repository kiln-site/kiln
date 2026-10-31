import { Layer } from "effect"

import { deliverInvitation } from "@/lib/access-invitation-delivery"
import { githubSyncRunOperation } from "@/lib/github-sync.server"
import { deleteResource, keepResource } from "@/lib/resource-deletion.server"
import { deleteTailscaleNetwork } from "@/lib/tailscale-cleanup.server"

/**
 * Every workflow Hearth runs, registered with the engine when it starts. An
 * operation kind adds its handler here; one removed must stay until its
 * unfinished runs have drained.
 */
export const HearthWorkflows = Layer.mergeAll(
  deliverInvitation.layer,
  githubSyncRunOperation.layer,
  deleteResource.layer,
  keepResource.layer,
  deleteTailscaleNetwork.layer
)
