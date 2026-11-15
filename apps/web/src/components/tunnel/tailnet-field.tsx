import * as React from "react"

import { TailscaleLogo } from "@/components/brand-logos"
import {
  InstancePickerContent,
  type InstancePickerItem,
} from "@/components/instance-picker"
import {
  InstancePickerField,
  PickerPlaceholder,
  pickerCreateItem,
} from "@/components/instance-picker-field"
import { TailnetCard, tailnetMeta } from "@/components/tunnel/tailnet-card"
import type { TailnetOverview } from "@/components/tunnel/tailnet-data"
import type { GroupPickerIdentity } from "@/lib/instance-picker-filters"

// The tailnet a new tunnel joins: one that has no tunnel on its Relay yet,
// picked from the list, or a new one named by typing it.

/** What's chosen: a tailnet there is, or one to make with the tunnel. */
export type TailnetChoice =
  | { kind: "existing"; id: string }
  | { kind: "new"; name: string }

type TailnetPickerItem = InstancePickerItem<GroupPickerIdentity>

const CREATE_KEY = "tailnet:create"

function tailnetItem(tailnet: TailnetOverview): TailnetPickerItem {
  const meta =
    tailnet.integration === null
      ? `${tailnetMeta(tailnet)} · needs an auth key`
      : tailnetMeta(tailnet)
  return {
    card: <TailnetCard meta={meta} name={tailnet.name} />,
    identity: { id: tailnet.id, kind: "group" },
    key: tailnet.id,
    meta,
    name: tailnet.name,
    searchText: tailnet.domains.join(" "),
  }
}

export const TailnetField = React.memo(function TailnetField({
  disabled,
  onChange,
  tailnets,
  value,
}: {
  disabled: boolean
  onChange: (choice: TailnetChoice) => void
  /** The tailnets a tunnel on this Relay could join. */
  tailnets: ReadonlyArray<TailnetOverview>
  value: TailnetChoice | null
}) {
  const items = React.useMemo(() => tailnets.map(tailnetItem), [tailnets])
  const selectedKeys = React.useMemo(
    () => new Set(value?.kind === "existing" ? [value.id] : []),
    [value]
  )
  const searchItem = React.useCallback(
    (text: string) => {
      const name = text.trim()
      const lowered = name.toLowerCase()
      return name &&
        !tailnets.some((tailnet) => tailnet.name.toLowerCase() === lowered)
        ? pickerCreateItem<GroupPickerIdentity>({
            identity: { id: CREATE_KEY, kind: "group" },
            meta: "New tailnet, made with this tunnel",
            name,
          })
        : null
    },
    [tailnets]
  )
  const chosen =
    value?.kind === "existing"
      ? tailnets.find((tailnet) => tailnet.id === value.id)
      : undefined

  return (
    <div className="space-y-1.5">
      <InstancePickerField
        disabled={disabled}
        label="Tailnet"
        labelClassName="mb-1.5 block text-xs font-medium text-muted-foreground"
        title="Tailnets"
        value={
          chosen ? (
            <TailnetCard meta={tailnetMeta(chosen)} name={chosen.name} />
          ) : (
            <PickerPlaceholder
              icon={
                <TailscaleLogo
                  className="size-3.5 text-foreground/80"
                  aria-hidden
                />
              }
              meta={
                value?.kind === "new"
                  ? "New tailnet, made with this tunnel"
                  : "Pick one, or type a name for a new one"
              }
              name={value?.kind === "new" ? value.name : "Choose a tailnet"}
            />
          )
        }
      >
        {(close) => (
          <InstancePickerContent
            ariaLabel="Tailnets"
            emptyMessage={
              tailnets.length === 0
                ? "No tailnet can take a tunnel on this Relay. Type a name to create one."
                : "No tailnet by that name"
            }
            favoritesFilter={false}
            filterBar={false}
            items={items}
            searchItem={searchItem}
            searchPlaceholder="Find a tailnet, or name a new one"
            selectedKeys={selectedKeys}
            onSelect={(item) => {
              onChange(
                item.key === CREATE_KEY
                  ? { kind: "new", name: item.searchText ?? item.name }
                  : { kind: "existing", id: item.key }
              )
              close()
            }}
          />
        )}
      </InstancePickerField>
      <p className="type-meta leading-relaxed font-normal text-muted-foreground">
        A tailnet is the tunnels of one Tailscale account. Each Relay's tunnel
        joins it, and what they connect answers to names under its TLDs.
      </p>
    </div>
  )
})
