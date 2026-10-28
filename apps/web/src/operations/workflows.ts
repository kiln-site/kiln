import { Layer } from "effect"

import { deliverInvitation } from "@/lib/access-invitation-delivery"

/**
 * Every workflow Hearth runs, registered with the engine when it starts. An
 * operation kind adds its handler here; one removed must stay until its
 * unfinished runs have drained.
 */
export const HearthWorkflows = Layer.mergeAll(deliverInvitation.layer)
