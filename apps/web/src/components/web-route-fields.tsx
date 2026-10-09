import type * as React from "react"
import { relayInstanceWebRouteInputSchema } from "@workspace/contracts"
import type { RelayInstanceWebRoute } from "@workspace/contracts"
import { AlertTriangle } from "lucide-react"

import { Input } from "@workspace/ui/components/input"

// A web route's fields, shared by the server and app route dialogs. Read
// them back with `parseWebRouteForm`.
export function WebRouteFields({
  children,
  route,
}: {
  // Extra fields after the port, such as an app's service.
  children?: React.ReactNode
  route?: Pick<
    RelayInstanceWebRoute,
    "hostname" | "name" | "path" | "stripPrefix" | "targetPort"
  >
}) {
  return (
    <>
      <label className="type-label block space-y-1.5">
        Name
        <Input
          autoComplete="off"
          defaultValue={route?.name}
          maxLength={32}
          name="name"
          placeholder="Live map"
          required
        />
      </label>
      <label className="type-label block space-y-1.5">
        Hostname
        <Input
          autoCapitalize="none"
          autoCorrect="off"
          defaultValue={route?.hostname}
          name="hostname"
          placeholder="map.donutsmp.com"
          required
        />
      </label>
      <div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-3">
        <label className="type-label block space-y-1.5">
          Path (optional)
          <Input
            defaultValue={route?.path ?? ""}
            name="path"
            placeholder="/map"
          />
        </label>
        <label className="type-label block space-y-1.5">
          Internal Port
          <Input
            defaultValue={route?.targetPort}
            max={65_535}
            min={1}
            name="targetPort"
            placeholder="8080"
            required
            type="number"
          />
        </label>
      </div>
      {children}
      <label className="type-support flex items-center gap-2 text-muted-foreground">
        <input
          className="accent-primary"
          defaultChecked={route?.stripPrefix ?? true}
          name="stripPrefix"
          type="checkbox"
        />
        Strip the configured path before forwarding
      </label>
      <div className="type-meta flex gap-2 border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-amber-100">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-300" />
        Point this hostname at the Relay before applying the route.
      </div>
    </>
  )
}

export function parseWebRouteForm(form: FormData, id: string | undefined) {
  const path = String(form.get("path") ?? "").trim()
  return relayInstanceWebRouteInputSchema.safeParse({
    id,
    hostname: String(form.get("hostname") ?? ""),
    name: String(form.get("name") ?? ""),
    path: path || null,
    stripPrefix: form.get("stripPrefix") === "on",
    targetPort: Number(form.get("targetPort")),
  })
}
