import { IdentityName } from "@/components/identity-name"
import { GroupKindIcon } from "@/components/instance-kind-icon"

/**
 * A group of instances as a picker's row shows it, in place of an
 * instance's card: its name, and what choosing it chooses.
 */
export function GroupPickerCard({
  meta,
  name,
}: {
  meta: string
  name: string
}) {
  return (
    <IdentityName
      className="min-w-0 flex-1 gap-2"
      icon={<GroupKindIcon className="size-4" aria-hidden="true" />}
      iconClassName="border-0 bg-muted/55"
      meta={meta}
      metaClassName="font-mono"
      name={name}
      nameClassName="type-control-sm"
    />
  )
}
