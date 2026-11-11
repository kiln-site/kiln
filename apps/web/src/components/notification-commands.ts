import type { QueryClient } from "@tanstack/react-query"

import { showToast } from "@workspace/ui/components/sonner"

import { settleResourceInvitationDecision } from "@/components/resource-invitation-dialog"
import { tapPromiseError } from "@/effect/promise"
import {
  notificationsQueryOptions,
  setCachedInvitationOutcome,
} from "@/lib/collections/notifications"
import {
  deploymentsHref,
  notificationHref,
  notificationResourceHref,
} from "@/lib/notification-links"
import type { KilnNotification } from "@/lib/notifications"
import { redeployAppDeployment } from "@/server/app-deployments"
import {
  deployInstanceUpdate,
  skipInstanceUpdate,
} from "@/server/instance-updates"
import { decideResourceInvitation } from "@/server/resource-access"

/** What a notification offers beside it, the same in a row and a toast. */
export interface NotificationCommand {
  key: string
  label: string
  /** It only opens a page, which a toast has no room to offer as well. */
  link?: boolean
  pendingLabel?: string
  /** The one to do; a toast shows it as its action. */
  primary?: boolean
  run: () => Promise<unknown> | void
}

interface CommandContext {
  navigate: (href: string) => void
  platformAdmin: boolean
  queryClient: QueryClient
}

/**
 * The commands that need no more than a click, least important first. A row
 * adds the few that need more of the page, such as a confirmation dialog.
 */
export function notificationCommands(
  context: CommandContext,
  { content, id }: KilnNotification
): ReadonlyArray<NotificationCommand> {
  const { navigate, platformAdmin, queryClient } = context
  const link = (key: string, label: string, href: string, primary = false) => ({
    key,
    label,
    link: true,
    primary,
    run: () => navigate(href),
  })
  const open = (href: string | null, label = "Open") =>
    href ? [link("open", label, href, true)] : []
  switch (content.kind) {
    case "kiln.updated":
      return [link("changelog", "Changelog", "/infra/updates/changelog")]
    case "kiln.release":
      return [
        link("changelog", "Changelog", "/infra/updates/changelog"),
        link("update", "Update", "/infra/updates", true),
      ]
    case "access.invited": {
      if (content.outcome !== undefined)
        return open(notificationHref(content, platformAdmin))
      const answer = (decision: "accept" | "decline") =>
        tapPromiseError(
          async () => {
            const result = await decideResourceInvitation({
              data: { decision, force: false, id: content.invitationId },
            })
            settleResourceInvitationDecision(
              queryClient,
              content.invitationId,
              result
            )
            setCachedInvitationOutcome(
              queryClient,
              id,
              result.accepted ? "accepted" : "declined"
            )
          },
          // It usually changed meanwhile; show what happened to it.
          () =>
            void queryClient.invalidateQueries({
              queryKey: notificationsQueryOptions().queryKey,
            })
        )
      return [
        {
          key: "decline",
          label: "Decline",
          pendingLabel: "Declining…",
          run: () => answer("decline"),
        },
        {
          key: "accept",
          label: "Accept",
          pendingLabel: "Accepting…",
          primary: true,
          run: () => answer("accept"),
        },
      ]
    }
    case "access.removed":
      return []
    case "resource.disk-limit":
      return open(notificationHref(content, platformAdmin), "Limits")
    // Taken or passed over from its page, which shows what it would change.
    case "instance.brick-update":
      return open(notificationHref(content, platformAdmin), "Updates")
    case "app.image-update": {
      // A game server is an `instance` to notifications, a `server` here.
      const instance = {
        instanceId: content.resource.id,
        kind:
          content.resource.type === "app"
            ? ("app" as const)
            : content.resource.type === "database"
              ? ("database" as const)
              : ("server" as const),
        relayId: content.resource.relayId,
      }
      return [
        {
          key: "skip",
          label: "Skip",
          pendingLabel: "Skipping…",
          run: () =>
            skipInstanceUpdate({
              data: { ...instance, digest: content.digest },
            }),
        },
        {
          key: "deploy",
          label: "Deploy",
          pendingLabel: "Deploying…",
          primary: true,
          run: async () => {
            await deployInstanceUpdate({ data: instance })
            // It runs once any deployment running ends.
            showToast({ message: "Update deploy queued", type: "success" })
          },
        },
      ]
    }
    case "app.deployed":
      return content.status === "failed"
        ? [
            link(
              "deployments",
              "Deployments",
              deploymentsHref(content.resource)
            ),
            {
              key: "redeploy",
              label: "Redeploy",
              pendingLabel: "Redeploying…",
              primary: true,
              run: async () => {
                await redeployAppDeployment({
                  data: { deploymentId: content.deploymentId },
                })
                showToast({ message: "Redeploy queued", type: "success" })
              },
            },
          ]
        : open(deploymentsHref(content.resource), "Deployments")
    case "security.report":
      return open(
        notificationHref(content, platformAdmin),
        platformAdmin ? "Review" : "Open"
      )
    case "server.migration":
      return open(
        notificationResourceHref(
          content.outcome === "completed" ? content.destination : content.source
        )
      )
  }
}
