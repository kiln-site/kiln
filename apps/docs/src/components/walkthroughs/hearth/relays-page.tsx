import * as React from "react"
import {
  ArrowUp,
  ArrowUpDown,
  Bell,
  CalendarClock,
  Check,
  ChevronsUpDown,
  CloudDownload,
  Command as CommandIcon,
  Copy,
  Fingerprint,
  Info,
  ListTodo,
  LoaderCircle,
  LogOut,
  Pause,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Star,
  Trash2,
  UserRound,
  UserRoundCog,
  X,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Kbd } from "@workspace/ui/components/kbd"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
} from "@workspace/ui/components/sidebar"
import { cn } from "@workspace/ui/lib/utils"

import { DiscordIcon, GitHubIcon } from "~/components/brand-icons"

import { BackupIcon } from "@/components/backup-icon"
import {
  DataTableToolbar,
  DataTableWorkspace,
} from "@/components/data-table-workspace"
import { HearthMark } from "@/components/hearth-mark"
import {
  AppKindIcon,
  DatabaseKindIcon,
  RelayKindIcon,
  ServerKindIcon,
} from "@/components/instance-kind-icon"
import { SectionNavigation } from "@/components/section-navigation"
import { WorkspaceFrame } from "@/components/workspace-frame"
import { createDataTableSearchStore } from "@/lib/data-table-search"
import {
  infrastructureDestinations,
  relayDestinations,
} from "@/lib/navigation-destinations"

// Hearth's Relays page, drawn with Hearth's own components and made-up
// Relays. Nothing here fetches or saves; the walkthrough changes `dialog`
// and the Relays shown to tell its story. Elements the walkthrough aims at
// carry data-target.

export interface ExampleRelay {
  address: string
  arch: string
  id: string
  memory: string
  name: string
}

export type RelaysDialog =
  | { kind: "closed" }
  | { kind: "install"; copied: boolean }
  | {
      kind: "confirm"
      address: string
      build: string
      fingerprint: string
      name: string
    }

export function RelaysPage({
  dialog,
  relays,
}: {
  dialog: RelaysDialog
  relays: Array<ExampleRelay>
}) {
  const current = relays[0]
  return (
    <SidebarProvider className="h-full min-h-0">
      <HearthSidebar relay={current} relayCount={relays.length} />
      <SidebarInset className="h-full min-w-0 overflow-hidden">
        <div
          data-slot="app-content"
          className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <WorkspaceFrame
            header={<PageToolbar title="Infrastructure" context="Relays" />}
          >
            <div
              data-slot="global-route-content"
              className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-background/55"
            >
              <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
                <header className="mx-auto w-full max-w-[90rem] shrink-0 px-2 pt-3 sm:px-5">
                  <SectionNavigation
                    className="mb-6"
                    label="Infrastructure sections"
                    sections={infrastructureDestinations}
                    title="Infrastructure"
                    renderLink={(
                      section,
                      { activeProps, children, className }
                    ) => {
                      const active = section.to === "/infra/relays"
                      return (
                        <span
                          data-status={active ? "active" : undefined}
                          className={cn(
                            className,
                            active && activeProps.className
                          )}
                        >
                          {children}
                        </span>
                      )
                    }}
                  />
                </header>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <div className="mx-auto flex h-full min-h-[34rem] w-full max-w-[90rem] flex-col px-2 pb-3 sm:px-5 sm:pb-5">
                    <RelaysTable relays={relays} />
                  </div>
                </div>
              </div>
            </div>
          </WorkspaceFrame>
          {dialog.kind === "closed" ? null : <AddRelayDialog dialog={dialog} />}
        </div>
        <PanelFooter />
      </SidebarInset>
    </SidebarProvider>
  )
}

function HearthSidebar({
  relay,
  relayCount,
}: {
  relay: ExampleRelay | undefined
  relayCount: number
}) {
  return (
    <Sidebar
      collapsible="none"
      className="h-full border-r border-sidebar-border/80"
    >
      <SidebarHeader className="h-20 shrink-0 justify-center px-2 py-2">
        <SidebarMenu>
          <SidebarMenuItem className="flex items-center gap-1">
            <SidebarMenuButton
              size="lg"
              className="h-11 min-w-0 flex-1 hover:bg-transparent"
            >
              <HearthMark />
              <span className="min-w-0 flex-1 truncate font-heading text-2xl font-semibold tracking-[0.04em]">
                KILN
              </span>
            </SidebarMenuButton>
            <Button
              variant="ghost"
              size="icon-sm"
              className="mr-1 text-muted-foreground"
            >
              <Bell />
            </Button>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <div className="shrink-0 p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton className="h-8 w-full justify-start gap-2.5 bg-card px-2 shadow-[0_0_0_0.5px_color-mix(in_oklab,var(--sidebar-foreground)_16%,transparent)]! dark:bg-black/25">
              <Search />
              <span className="min-w-0 flex-1 truncate text-sidebar-foreground/60">
                Search Kiln...
              </span>
              <Kbd className="h-[18px] min-w-8 gap-0.5 px-1">
                <CommandIcon className="size-3!" aria-hidden="true" />
                <span>K</span>
              </Kbd>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </div>
      <SidebarSeparator />
      <SidebarContent>
        <SidebarGroup className="pt-2">
          <SidebarGroupLabel className="type-technical-label">
            Infrastructure
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <NavItem
                icon={<RelayKindIcon />}
                label="Relays"
                count={relayCount}
                active
              />
              <NavItem
                icon={<ServerKindIcon />}
                label="Game Servers"
                count={0}
              />
              <NavItem
                icon={<DatabaseKindIcon />}
                label="Databases"
                count={0}
              />
              <NavItem icon={<AppKindIcon />} label="Apps" count={0} />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {relay ? (
          <>
            <SidebarSeparator />
            <SidebarGroup>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    size="lg"
                    className="h-12 border border-sidebar-border bg-sidebar-accent/30 px-2"
                  >
                    <span className="relative grid size-8 shrink-0 place-items-center border border-border bg-background">
                      <RelayKindIcon className="size-4" />
                      <span className="absolute -bottom-0.5 -left-0.5 size-2 rounded-full bg-emerald-500 ring-2 ring-sidebar" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-semibold">
                        {relay.name}
                      </span>
                      <span className="block truncate text-[0.6875rem] text-sidebar-foreground/60">
                        {relay.arch} · {relay.id}
                      </span>
                    </span>
                    <ChevronsUpDown className="size-3.5 text-sidebar-foreground/55" />
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {relayDestinations.map((destination) => (
                  <SidebarMenuItem key={destination.label}>
                    <SidebarMenuButton>
                      <destination.icon />
                      <span>{destination.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>
          </>
        ) : null}
      </SidebarContent>
      <SidebarFooter>
        <SidebarSeparator />
        <SidebarGroup className="p-0">
          <SidebarGroupLabel className="type-technical-label">
            Manage
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <NavItem icon={<CalendarClock />} label="Automations" />
              <NavItem icon={<BackupIcon />} label="Backups" />
              <NavItem icon={<ListTodo />} label="Activity" />
              <NavItem icon={<UserRoundCog />} label="Access" />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator />
        <div className="flex h-11 items-center gap-1 px-2">
          <span className="-ml-1 flex h-9 min-w-0 flex-1 items-center gap-2 px-1">
            <span className="grid size-6 place-items-center bg-primary/15 text-xs font-semibold text-primary-ink">
              A
            </span>
            <span className="min-w-0 flex-1 truncate text-xs font-semibold">
              Ada
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-sidebar-foreground/55" />
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-sidebar-foreground/70"
          >
            <Settings />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-sidebar-foreground/70"
          >
            <LogOut />
          </Button>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}

function NavItem({
  active = false,
  count,
  icon,
  label,
}: {
  active?: boolean
  count?: number
  icon: React.ReactNode
  label: string
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton data-active={active || undefined} isActive={active}>
        {icon}
        <span>{label}</span>
      </SidebarMenuButton>
      {count === undefined ? null : (
        <SidebarMenuBadge className="text-sidebar-muted-foreground">
          {count}
        </SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  )
}

// Hearth's GlobalPageToolbar, with the Infrastructure section's actions.
function PageToolbar({ context, title }: { context: string; title: string }) {
  return (
    <header className="shrink-0 border-b bg-background/90">
      <div className="flex min-h-20 items-center gap-4 px-3 py-2 sm:px-5">
        <SidebarTrigger className="-mr-1.5 -ml-2.5 size-8 shrink-0 text-muted-foreground shadow-none" />
        <span className="h-8 w-px shrink-0 bg-border/80" aria-hidden="true" />
        <h1 className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="type-page-title shrink-0 text-foreground">
            {title}
          </span>
          <span className="shrink-0 text-border">/</span>
          <span className="type-page-context min-w-0 truncate text-muted-foreground">
            {context}
          </span>
        </h1>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            className="h-9 shrink-0 gap-1.5 bg-card px-3 text-xs shadow-none"
            size="sm"
            variant="outline"
          >
            <HearthMark className="size-4" />
            Kiln
          </Button>
          <Button
            className="h-9 w-[6.5rem] shrink-0 gap-1.5 bg-card px-3 text-xs shadow-none"
            size="sm"
            variant="outline"
          >
            <CloudDownload />
            Updates
          </Button>
        </div>
      </div>
    </header>
  )
}

const searchStore = createDataTableSearchStore("")
const columns =
  "grid grid-cols-[9rem_1.75rem_12rem_7.5rem_minmax(0,1fr)_minmax(0,1fr)_10rem]"

function RelaysTable({ relays }: { relays: Array<ExampleRelay> }) {
  return (
    <DataTableWorkspace
      toolbar={
        <DataTableToolbar
          leading={
            <Button variant="outline" size="icon" aria-label="Refresh">
              <RefreshCw />
            </Button>
          }
          controls={
            <Button variant="outline" size="icon" aria-label="Favorites only">
              <Star />
            </Button>
          }
          actions={
            <>
              <Button variant="outline" className="px-2.5">
                <ListTodo />
                Activity
              </Button>
              <Button data-target="add-relay">
                <Plus /> Add Relay
              </Button>
            </>
          }
          search={{
            ariaLabel: "Search relays",
            placeholder: "Search relays",
            store: searchStore,
          }}
        />
      }
    >
      <div
        className={cn(
          columns,
          "type-technical-label h-11 items-center border-b px-3 text-muted-foreground"
        )}
      >
        <HeaderCell sortable>Status</HeaderCell>
        <span />
        <HeaderCell sorted>Relay</HeaderCell>
        <HeaderCell>Memory</HeaderCell>
        <HeaderCell sortable>Host / IP</HeaderCell>
        <HeaderCell sortable>Owner</HeaderCell>
        <span />
      </div>
      {relays.map((relay) => (
        <div
          key={relay.id}
          data-target={`relay-${relay.name}`}
          className={cn(
            columns,
            "min-h-[3.75rem] items-center border-b px-3 text-sm"
          )}
        >
          <span className="flex items-center gap-2 text-xs text-emerald-400">
            <span className="size-1.5 rounded-full bg-emerald-400" />
            Online
          </span>
          <Star className="size-4 text-muted-foreground" />
          <span className="flex min-w-0 items-center gap-3 pl-2">
            <span className="relative grid size-8 shrink-0 place-items-center border border-border bg-card">
              <RelayKindIcon className="size-4" />
              <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-emerald-500 ring-2 ring-background" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs font-semibold">
                {relay.name}
              </span>
              <span className="block truncate font-mono text-xs text-muted-foreground">
                {relay.arch} • {relay.id}
              </span>
            </span>
          </span>
          <span className="flex items-center gap-1.5 text-xs">
            {relay.memory}
            <Info className="size-3.5 text-muted-foreground" />
          </span>
          <span className="truncate font-mono text-xs">{relay.address}</span>
          <span className="flex items-center gap-3 text-xs">
            <UserRound className="size-4 text-muted-foreground" />
            <span className="font-semibold">Unassigned</span>
          </span>
          <span className="flex items-center justify-end gap-3 text-muted-foreground">
            <SlidersHorizontal className="size-4" />
            <Pause className="size-4" />
            <Trash2 className="size-4 text-destructive" />
            <span className="text-lg leading-none">⋮</span>
          </span>
        </div>
      ))}
    </DataTableWorkspace>
  )
}

function HeaderCell({
  children,
  sortable = false,
  sorted = false,
}: {
  children: React.ReactNode
  sortable?: boolean
  sorted?: boolean
}) {
  return (
    <span className="flex items-center gap-1.5">
      {children}
      {sorted ? (
        <ArrowUp className="size-3" />
      ) : sortable ? (
        <ArrowUpDown className="size-3 opacity-50" />
      ) : null}
    </span>
  )
}

// Hearth's Add a Relay dialog: the install command, then the Relay that
// announced itself.
function AddRelayDialog({
  dialog,
}: {
  dialog: Exclude<RelaysDialog, { kind: "closed" }>
}) {
  return (
    <div className="absolute inset-0 z-50 grid place-items-center bg-black/55">
      <div
        data-target="dialog"
        className="type-body relative grid w-full max-w-xl gap-5 rounded-xl border border-accent-border/25 bg-[color-mix(in_oklab,var(--surface-overlay)_70%,transparent)] p-5 text-popover-foreground shadow-2xl shadow-black/55 backdrop-blur-xl"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute top-3 right-3 text-muted-foreground"
        >
          <X />
        </Button>
        <div className="flex flex-col gap-1.5 pr-8">
          <div className="type-dialog-title text-foreground">Add a Relay</div>
          <div className="type-support text-muted-foreground">
            Run this on the new machine, then confirm the Relay here.
          </div>
        </div>
        <div className="flex border-b border-border/70">
          {["Install", "Pairing link"].map((label) => (
            <span
              key={label}
              aria-selected={label === "Install"}
              className="type-control-sm -mb-px border-b-2 border-transparent px-3 py-2 text-muted-foreground aria-selected:border-primary aria-selected:text-foreground"
            >
              {label}
            </span>
          ))}
        </div>
        {dialog.kind === "install" ? (
          <div className="min-w-0 space-y-3">
            <div className="flex items-center gap-2 border border-border/70 bg-background/35 py-1.5 pr-1.5 pl-3">
              <code className="min-w-0 flex-1 truncate font-mono text-xs">
                curl -fsSL https://kiln.site/install | sh -s -- --join
                &apos;https://kiln.example.com/#kj1.bvx7efic5jpuesyvdble&apos;
              </code>
              <Button
                data-target="copy"
                size="sm"
                variant={dialog.copied ? "outline" : "default"}
              >
                {dialog.copied ? <Check /> : <Copy />}
                {dialog.copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <div className="type-meta flex items-center gap-2 text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" />
              <span className="flex-1">Waiting for the Relay</span>
              <span className="tabular-nums">30 min</span>
              <Button size="xs" variant="ghost">
                <RefreshCw />
                New command
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="min-w-0 space-y-4">
              <div
                data-target="fingerprint"
                className="flex items-center gap-3 border border-primary/20 bg-primary/[0.045] p-3"
              >
                <span className="flex size-8 shrink-0 items-center justify-center border border-primary/20 bg-primary/10 text-primary-ink">
                  <Fingerprint className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="type-meta text-muted-foreground">
                    {dialog.address} · {dialog.build}
                  </div>
                  <div className="font-mono text-xs break-all">
                    {dialog.fingerprint}
                  </div>
                </div>
              </div>
              <div className="grid gap-2">
                <label className="type-label text-foreground">Name</label>
                <Input placeholder={dialog.name} readOnly />
              </div>
              <div className="type-meta text-muted-foreground">
                Hearth can&apos;t reach this machine, so the Relay connects to
                Hearth instead, and its consoles and file transfers go through
                Hearth.
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost">Cancel</Button>
              <Button data-target="confirm">
                <Check />
                Add Relay
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// Hearth's PanelFooter, with a made-up build.
function PanelFooter() {
  return (
    <footer className="type-meta grid h-14 shrink-0 grid-cols-[minmax(4.5rem,1fr)_auto_minmax(4.5rem,1fr)] grid-rows-2 bg-background text-center tracking-wide text-muted-foreground">
      <div className="col-start-2 row-start-1 flex items-center gap-1.5 self-end justify-self-center pb-0.5 whitespace-nowrap">
        <span>Kiln · Hearth Panel</span>
        <span className="font-mono text-primary-ink/90">1a2b3c4</span>
      </div>
      <div className="col-start-2 row-start-2 flex items-center justify-center gap-x-2 self-start justify-self-center pt-0.5 whitespace-nowrap">
        <span>QuartzDev © 2026</span>
        <span className="text-border">/</span>
        <span>Terms of Use</span>
        <span>Privacy Policy</span>
      </div>
      <div className="col-start-3 row-span-2 row-start-1 flex h-full items-center gap-1 justify-self-end px-3">
        <DiscordIcon className="size-5" />
        <GitHubIcon className="size-5" />
      </div>
    </footer>
  )
}
