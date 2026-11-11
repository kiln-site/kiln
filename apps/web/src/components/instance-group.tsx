import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { Boxes, CircleAlert, LoaderCircle, Trash2 } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { showToast } from "@workspace/ui/components/sonner"

import {
  DeleteConfirmationFields,
  useDeleteConfirmation,
} from "@/components/delete-confirmation-fields"
import { InfoRailButton } from "@/components/info-page"
import { InstanceCard } from "@/components/instance-card"
import { instanceGroupQueryOptions, queryKeys } from "@/lib/query-options"
import {
  deleteInstanceGroup,
  type getInstanceGroup,
} from "@/server/instance-groups"

// The group an instance is part of, on its Info page: a row that names it,
// and a dialog that lists what else is in it and deletes it. A group has no
// page of its own yet.

type Group = NonNullable<Awaited<ReturnType<typeof getInstanceGroup>>>
type Member = Group["members"][number]

/** Which instance's page this is. */
export interface GroupMemberReference {
  instanceId: string
  kind: Member["kind"]
  relayId: string
}

const kindNames = {
  app: "App",
  database: "Database",
  server: "Game server",
} as const satisfies Record<Member["kind"], string>

const memberName = (member: Member) =>
  member.name ?? `${kindNames[member.kind]} ${member.instanceId}`

/** A rail row for an instance that is in a group. Nothing for one that isn't. */
export const InfoRailGroupRow = React.memo(function InfoRailGroupRow({
  member,
}: {
  member: GroupMemberReference
}) {
  const { data: group } = useQuery(instanceGroupQueryOptions(member))
  const [open, setOpen] = React.useState(false)
  if (!group) return null
  return (
    <>
      <InfoRailButton
        detail={<span className="truncate">{group.name}</span>}
        leading={<Boxes />}
        onClick={() => setOpen(true)}
      >
        Part of
      </InfoRailButton>
      {open ? (
        <InstanceGroupDialog
          current={member.instanceId}
          group={group}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  )
})

function InstanceGroupDialog({
  current,
  group,
  onOpenChange,
}: {
  /** The member whose page it was opened from. */
  current: string
  group: Group
  onOpenChange: (open: boolean) => void
}) {
  const [deleting, setDeleting] = React.useState(false)
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {deleting ? (
          <DeleteGroupForm
            current={current}
            group={group}
            onCancel={() => setDeleting(false)}
            onDeleted={() => onOpenChange(false)}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{group.name}</DialogTitle>
              <DialogDescription>
                Installed together, and kept together as a group.
              </DialogDescription>
            </DialogHeader>
            <ul className="grid gap-1.5">
              {group.members.map((member) => (
                <li key={member.instanceId}>
                  <MemberLink
                    member={member}
                    onNavigate={() => onOpenChange(false)}
                  />
                </li>
              ))}
            </ul>
            {group.hidden > 0 ? (
              <p className="type-meta text-muted-foreground">
                {group.hidden === 1
                  ? "One more member you can't see."
                  : `${group.hidden} more members you can't see.`}
              </p>
            ) : null}
            <DialogFooter>
              {group.canDelete ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-destructive sm:mr-auto"
                  onClick={() => setDeleting(true)}
                >
                  <Trash2 /> Delete group
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Close
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

const memberRowClassName =
  "flex w-full items-center rounded-lg border border-border/70 px-2.5 py-2 text-left transition-colors hover:bg-muted/40"

function MemberLink({
  member,
  onNavigate,
}: {
  member: Member
  onNavigate: () => void
}) {
  const card = (
    <InstanceCard
      instance={{
        id: member.instanceId,
        kind: member.kind,
        relayId: member.relayId,
      }}
      meta={`${kindNames[member.kind]} · ${member.instanceId}`}
      name={memberName(member)}
      showFavorite={false}
    />
  )
  switch (member.kind) {
    case "app":
      return (
        <Link
          className={memberRowClassName}
          params={{ appId: member.instanceId }}
          to="/app/$appId/info"
          onClick={onNavigate}
        >
          {card}
        </Link>
      )
    case "database":
      return (
        <Link
          className={memberRowClassName}
          params={{ databaseId: member.instanceId }}
          to="/db/$databaseId/info"
          onClick={onNavigate}
        >
          {card}
        </Link>
      )
    case "server":
      return (
        <Link
          className={memberRowClassName}
          params={{ serverId: member.instanceId }}
          to="/server/$serverId/info"
          onClick={onNavigate}
        >
          {card}
        </Link>
      )
  }
}

// Where each kind's list is, for when the page's own instance is deleted.
const lists = {
  app: "/infra/apps",
  database: "/infra/databases",
  server: "/infra/servers",
} as const satisfies Record<Member["kind"], string>

function DeleteGroupForm({
  current,
  group,
  onCancel,
  onDeleted,
}: {
  current: string
  group: Group
  onCancel: () => void
  onDeleted: () => void
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const confirmation = useDeleteConfirmation(group.name)
  // The members to delete with the group. None, until some are chosen:
  // forgetting a group mustn't cost a database by default.
  const [chosen, setChosen] = React.useState<ReadonlySet<string>>(new Set())
  const doomed = group.members.filter((member) => chosen.has(member.instanceId))
  const remove = useMutation({
    mutationFn: () =>
      deleteInstanceGroup({
        data: {
          ...confirmation.input,
          delete: doomed.map((member) => member.instanceId),
          groupId: group.id,
        },
      }),
    onSuccess: async () => {
      const here = doomed.find((member) => member.instanceId === current)
      // Its own page has nothing left to show.
      if (here) await navigate({ to: lists[here.kind] })
      onDeleted()
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.apps.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.databases.all }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.instanceGroups.all,
        }),
      ])
      showToast({
        description:
          doomed.length === 0
            ? "Its members stay as they are."
            : doomed.length === 1
              ? "One member is being deleted."
              : `${doomed.length} members are being deleted.`,
        message: `${group.name} deleted`,
        type: "success",
      })
    },
  })

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (confirmation.ready && !remove.isPending) remove.mutate()
      }}
    >
      <DialogHeader>
        <DialogTitle>Delete {group.name}?</DialogTitle>
        <DialogDescription>
          The group is forgotten, and its members stay, in no group. A member
          checked here is deleted with it, and its data, without a final backup;
          to take one, delete it from its own page first.
        </DialogDescription>
      </DialogHeader>
      <fieldset className="grid gap-2" disabled={remove.isPending}>
        {group.members.map((member) => (
          <label
            key={member.instanceId}
            className="flex cursor-pointer items-center gap-3 rounded-lg border border-border/70 px-3 py-2 text-sm"
          >
            <input
              checked={chosen.has(member.instanceId)}
              className="size-4 rounded-[3px] border-input accent-destructive"
              type="checkbox"
              onChange={(event) => {
                const next = new Set(chosen)
                if (event.currentTarget.checked) next.add(member.instanceId)
                else next.delete(member.instanceId)
                setChosen(next)
              }}
            />
            <span className="min-w-0 flex-1 truncate">
              Also delete {memberName(member)}
            </span>
            <span className="type-meta text-muted-foreground">
              {kindNames[member.kind]}
            </span>
          </label>
        ))}
      </fieldset>
      {doomed.length > 0 ? (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs light:bg-destructive/10">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          This action cannot be undone.
        </div>
      ) : null}
      <DeleteConfirmationFields
        confirmation={confirmation}
        disabled={remove.isPending}
      />
      {remove.error ? (
        <p className="text-xs text-destructive">{remove.error.message}</p>
      ) : null}
      <DialogFooter>
        <Button
          disabled={remove.isPending}
          type="button"
          variant="ghost"
          onClick={onCancel}
        >
          Back
        </Button>
        <Button
          disabled={remove.isPending || !confirmation.ready}
          type="submit"
          variant="destructive"
        >
          {remove.isPending ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <Trash2 />
          )}
          Delete group
        </Button>
      </DialogFooter>
    </form>
  )
}
