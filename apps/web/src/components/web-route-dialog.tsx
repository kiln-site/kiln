import * as React from "react"
import {
  relayInstanceWebRouteInputSchema,
  wwwCounterpart,
} from "@workspace/contracts"
import type {
  RelayInstanceWebRouteInput,
  WebRouteWww,
} from "@workspace/contracts"
import { CornerUpRight, Globe2, LoaderCircle } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Switch } from "@workspace/ui/components/switch"
import { cn } from "@workspace/ui/lib/utils"

import { ensuringPromise, recoverPromise } from "@/effect/promise"

// One of an app's services, as its containers show it.
export interface WebRouteServiceOption {
  readonly image: string
  readonly name: string
  // The container ports it publishes, the likeliest to serve HTTP.
  readonly ports: ReadonlyArray<number>
  readonly running: boolean
  readonly state: string
}

type Route = RelayInstanceWebRouteInput & { readonly service?: string }

// Adds or edits a route. Every field stays in place as the choices change,
// so the dialog never changes size under the pointer.
export function WebRouteDialog({
  route,
  services,
  onOpenChange,
  onSubmit,
}: {
  route?: Route
  // An app's services; a game server's routes reach the server itself.
  services?: ReadonlyArray<WebRouteServiceOption>
  onOpenChange: (open: boolean) => void
  onSubmit: (route: Route) => Promise<void>
}) {
  const [mode, setMode] = React.useState<"redirect" | "serve">(
    route?.redirect ? "redirect" : "serve"
  )
  const [hostname, setHostname] = React.useState(route?.hostname ?? "")
  const [www, setWww] = React.useState<WebRouteWww>(route?.www ?? "none")
  // A new route starts at the first service that publishes a port.
  const [service, setService] = React.useState(
    route?.service ??
      (services?.find(({ ports }) => ports.length > 0) ?? services?.[0])
        ?.name ??
      ""
  )
  const [port, setPort] = React.useState(
    route?.targetPort?.toString() ??
      services?.find(({ name }) => name === service)?.ports[0]?.toString() ??
      ""
  )
  const [path, setPath] = React.useState(route?.path ?? "")
  const [stripPrefix, setStripPrefix] = React.useState(
    route?.stripPrefix ?? true
  )
  const [httpsRedirect, setHttpsRedirect] = React.useState(
    route?.httpsRedirect ?? true
  )
  const [name, setName] = React.useState(route?.name ?? "")
  const [redirectTo, setRedirectTo] = React.useState(route?.redirect?.to ?? "")
  const [permanent, setPermanent] = React.useState(
    route?.redirect?.permanent ?? true
  )
  const [preservePath, setPreservePath] = React.useState(
    route?.redirect?.preservePath ?? true
  )
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)

  const host = normalizeHostname(hostname)
  const counterpart = host ? wwwCounterpart(host) : null
  const selectedService = services?.find(({ name }) => name === service)

  const chooseService = (next: string) => {
    const previous = services?.find(({ name }) => name === service)
    const chosen = services?.find(({ name }) => name === next)
    setService(next)
    // Follow the service's port unless one was typed for this route.
    if (
      chosen?.ports[0] &&
      (!port || port === previous?.ports[0]?.toString())
    ) {
      setPort(chosen.ports[0].toString())
    }
  }

  const submit = async () => {
    const parsed = relayInstanceWebRouteInputSchema.safeParse({
      hostname: host,
      httpsRedirect: mode === "serve" ? httpsRedirect : true,
      id: route?.id,
      name,
      path: path.trim() || null,
      primary: route?.primary ?? false,
      redirect:
        mode === "redirect"
          ? { permanent, preservePath, to: normalizeUrl(redirectTo) }
          : null,
      stripPrefix,
      targetPort: mode === "serve" ? Number(port) || null : null,
      // A redirect sends its www counterpart to the same place.
      www: mode === "redirect" && www === "serve" ? "redirect" : www,
    })
    if (!parsed.success) {
      setError(issueMessage(parsed.error.issues[0]))
      return
    }
    if (mode === "serve" && parsed.data.targetPort === null) {
      setError("Enter the port the route serves")
      return
    }
    if (services && mode === "serve" && !service.trim()) {
      setError("Choose the service this route reaches")
      return
    }
    setError(null)
    setPending(true)
    await ensuringPromise(
      () =>
        recoverPromise(
          () =>
            onSubmit({
              ...parsed.data,
              ...(services ? { service: service.trim() || "app" } : {}),
            }),
          (cause) =>
            setError(cause instanceof Error ? cause.message : "Could not save")
        ),
      () => setPending(false)
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!pending) onOpenChange(open)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <p className="type-technical-label text-primary-ink">Web route</p>
          <DialogTitle>
            {route ? "Edit web route" : "Add web route"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Serve a domain over HTTPS, or redirect it to another URL.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="grid grid-cols-2 gap-2" role="radiogroup">
            <ModeButton
              checked={mode === "serve"}
              description={services ? "Reach a service" : "Reach a port"}
              disabled={pending}
              icon={<Globe2 />}
              label="Serve"
              onSelect={() => setMode("serve")}
            />
            <ModeButton
              checked={mode === "redirect"}
              description="Send visitors to a URL"
              disabled={pending}
              icon={<CornerUpRight />}
              label="Redirect"
              onSelect={() => setMode("redirect")}
            />
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
            <Field label="Domain">
              <Input
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect="off"
                autoFocus
                className="font-mono"
                placeholder="donutsmp.com"
                spellCheck={false}
                value={hostname}
                onBlur={() => setHostname(host)}
                onChange={(event) => setHostname(event.target.value)}
              />
            </Field>
            <Field
              label={
                <span className="block truncate">{counterpart ?? "www."}</span>
              }
            >
              <Select
                value={
                  mode === "redirect" && www === "serve" ? "redirect" : www
                }
                onValueChange={(value) =>
                  setWww(
                    value === "redirect" || value === "serve" ? value : "none"
                  )
                }
              >
                <SelectTrigger aria-label="www counterpart" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not routed</SelectItem>
                  <SelectItem value="redirect">
                    {mode === "redirect" ? "Redirects too" : "Redirects here"}
                  </SelectItem>
                  {mode === "serve" ? (
                    <SelectItem value="serve">Serves the same</SelectItem>
                  ) : null}
                </SelectContent>
              </Select>
            </Field>
          </div>

          {/* Both panels share one cell, so switching keeps the height. */}
          <div className="grid *:col-start-1 *:row-start-1">
            <div
              className={cn(
                "grid content-start gap-4",
                mode !== "serve" && "invisible"
              )}
              inert={mode !== "serve"}
            >
              <div
                className={cn(
                  "grid gap-3",
                  services
                    ? "grid-cols-[minmax(0,1fr)_7rem]"
                    : "grid-cols-[7rem_minmax(0,1fr)]"
                )}
              >
                {services ? (
                  <Field label="Service">
                    {services.length > 0 ? (
                      <ServiceSelect
                        disabled={
                          services.length === 1 && service === services[0]?.name
                        }
                        selected={selectedService}
                        services={services}
                        value={service}
                        onValueChange={chooseService}
                      />
                    ) : (
                      <Input
                        className="font-mono"
                        placeholder="web"
                        value={service}
                        onChange={(event) => setService(event.target.value)}
                      />
                    )}
                  </Field>
                ) : null}
                <Field label="Port">
                  <Input
                    className="font-mono"
                    inputMode="numeric"
                    placeholder={
                      selectedService?.ports[0]?.toString() ?? "8080"
                    }
                    value={port}
                    onChange={(event) =>
                      setPort(
                        event.target.value.replace(/\D/gu, "").slice(0, 5)
                      )
                    }
                  />
                </Field>
                {services ? null : (
                  <Field label="Path (optional)">
                    <Input
                      className="font-mono"
                      placeholder="/map"
                      value={path}
                      onChange={(event) => setPath(event.target.value)}
                    />
                  </Field>
                )}
              </div>
              {services ? (
                <Field label="Path (optional)">
                  <Input
                    className="font-mono"
                    placeholder="/api"
                    value={path}
                    onChange={(event) => setPath(event.target.value)}
                  />
                </Field>
              ) : null}
              <div className="grid gap-2.5">
                <ToggleRow
                  checked={stripPrefix}
                  description={
                    path.trim()
                      ? `The service sees / instead of ${path.trim()}`
                      : "Only applies to a route with a path"
                  }
                  disabled={!path.trim()}
                  label="Strip the path before forwarding"
                  onCheckedChange={setStripPrefix}
                />
                <ToggleRow
                  checked={httpsRedirect}
                  description={
                    httpsRedirect
                      ? "Plain HTTP requests move to HTTPS"
                      : "Plain HTTP is served as well"
                  }
                  label="Redirect HTTP to HTTPS"
                  onCheckedChange={setHttpsRedirect}
                />
              </div>
            </div>

            <div
              className={cn(
                "grid content-start gap-4",
                mode !== "redirect" && "invisible"
              )}
              inert={mode !== "redirect"}
            >
              <Field label="Destination">
                <Input
                  autoCapitalize="none"
                  autoComplete="off"
                  autoCorrect="off"
                  className="font-mono"
                  placeholder="https://donutsmp.com"
                  spellCheck={false}
                  value={redirectTo}
                  onBlur={() => setRedirectTo(normalizeUrl(redirectTo))}
                  onChange={(event) => setRedirectTo(event.target.value)}
                />
              </Field>
              <Field label="Kind">
                <Select
                  value={permanent ? "permanent" : "temporary"}
                  onValueChange={(value) => setPermanent(value === "permanent")}
                >
                  <SelectTrigger aria-label="Redirect kind" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="permanent">
                      Permanent (301) · browsers remember it
                    </SelectItem>
                    <SelectItem value="temporary">
                      Temporary (302) · checked every visit
                    </SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <ToggleRow
                checked={preservePath}
                description={
                  preservePath
                    ? "/shop?id=4 goes to the same path there"
                    : "Every page goes to the destination itself"
                }
                label="Keep the path and query"
                onCheckedChange={setPreservePath}
              />
            </div>
          </div>

          <Field label="Label (optional)">
            <Input
              autoComplete="off"
              maxLength={32}
              placeholder="Live map"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          <p
            aria-live="polite"
            className="type-meta -my-1 min-h-4 text-destructive"
            role={error ? "alert" : undefined}
          >
            {error}
          </p>

          <DialogFooter>
            <Button
              disabled={pending}
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button className="min-w-28" disabled={pending} type="submit">
              {pending ? <LoaderCircle className="animate-spin" /> : null}
              {route ? "Save route" : "Add route"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ModeButton({
  checked,
  description,
  disabled,
  icon,
  label,
  onSelect,
}: {
  checked: boolean
  description: string
  disabled: boolean
  icon: React.ReactNode
  label: string
  onSelect: () => void
}) {
  return (
    <Button
      aria-checked={checked}
      className="h-auto items-start justify-start px-3 py-2.5 text-left"
      disabled={disabled}
      role="radio"
      type="button"
      variant={checked ? "default" : "outline"}
      onClick={onSelect}
    >
      <span className="mt-0.5 [&_svg]:size-4">{icon}</span>
      <span>
        <span className="block text-xs">{label}</span>
        <span className="type-meta mt-0.5 block">{description}</span>
      </span>
    </Button>
  )
}

function Field({
  children,
  label,
}: {
  children: React.ReactNode
  label: React.ReactNode
}) {
  return (
    <label className="type-label grid min-w-0 gap-1.5">
      {label}
      {children}
    </label>
  )
}

function ToggleRow({
  checked,
  description,
  disabled = false,
  label,
  onCheckedChange,
}: {
  checked: boolean
  description: string
  disabled?: boolean
  label: string
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <label
      className={cn(
        "flex items-center justify-between gap-4",
        disabled && "opacity-60"
      )}
    >
      <span className="min-w-0">
        <span className="type-label block">{label}</span>
        <span className="type-meta block truncate text-muted-foreground">
          {description}
        </span>
      </span>
      <Switch
        aria-label={label}
        checked={checked && !disabled}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </label>
  )
}

function ServiceSelect({
  disabled,
  selected,
  services,
  value,
  onValueChange,
}: {
  disabled: boolean
  selected: WebRouteServiceOption | undefined
  services: ReadonlyArray<WebRouteServiceOption>
  value: string
  onValueChange: (value: string) => void
}) {
  return (
    <Select disabled={disabled} value={value} onValueChange={onValueChange}>
      <SelectTrigger aria-label="Service" className="w-full">
        <SelectValue placeholder="Choose a service">
          {selected ? (
            <span className="flex min-w-0 items-center gap-2">
              <ServiceDot service={selected} />
              <span className="truncate font-mono text-xs">
                {selected.name}
              </span>
            </span>
          ) : null}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {services.map((service) => (
          <SelectItem key={service.name} value={service.name}>
            <span className="flex min-w-0 items-center gap-2.5">
              <ServiceDot service={service} />
              <span className="min-w-0">
                <span className="flex items-baseline gap-2">
                  <span className="font-mono text-xs font-medium">
                    {service.name}
                  </span>
                  <span className="type-meta text-muted-foreground">
                    {service.state}
                    {service.ports.length
                      ? ` · ${service.ports.join(", ")}`
                      : ""}
                  </span>
                </span>
                <span className="type-meta block max-w-72 truncate font-mono text-muted-foreground">
                  {service.image}
                </span>
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function ServiceDot({ service }: { service: WebRouteServiceOption }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        service.running ? "bg-emerald-400" : "bg-muted-foreground/50"
      )}
    />
  )
}

// Accepts a pasted URL: keeps its hostname and drops a scheme or path.
function normalizeHostname(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//u, "")
    .replace(/[/?#].*$/u, "")
    .replace(/\.$/u, "")
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

function issueMessage(
  issue: { message: string; path: ReadonlyArray<PropertyKey> } | undefined
): string {
  if (!issue) return "The route is invalid"
  const field = issue.path[0]
  if (field === "hostname") return "Enter a domain such as donutsmp.com"
  if (field === "targetPort") return "Enter a port from 1 to 65535"
  if (field === "redirect")
    return "Enter a destination such as https://donutsmp.com"
  if (field === "path") return "Start the path with / and leave out spaces"
  return issue.message
}
