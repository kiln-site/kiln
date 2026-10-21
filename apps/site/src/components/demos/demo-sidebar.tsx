import * as React from "react"
import {
  Bell,
  CalendarClock,
  ChevronsUpDown,
  CommandIcon,
  Folder,
  ListTodo,
  LogOut,
  Network,
  Rocket,
  Search,
  Settings,
  SlidersHorizontal,
  TerminalSquare,
  UserRoundCog,
} from "lucide-react"

import { Avatar, AvatarFallback } from "@workspace/ui/components/avatar"
import { Kbd } from "@workspace/ui/components/kbd"
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuItem,
  SidebarSeparator,
} from "@workspace/ui/components/sidebar"
import { cn } from "@workspace/ui/lib/utils"

import { BackupIcon } from "@/components/backup-icon"
import { HearthMark } from "@/components/hearth-mark"
import { IdentityName } from "@/components/identity-name"
import {
  AppKindIcon,
  DatabaseKindIcon,
  RelayKindIcon,
  ServerKindIcon,
} from "@/components/instance-kind-icon"

import { BrickMark, officialBricks } from "~/components/brick-mark"
import { demoServer } from "~/components/demos/demo-server"

export type DemoView = "console" | "files"

// Hearth's SidebarMenuButton reads the sidebar's provider, which also takes
// over Cmd+B for the whole page, so the demo draws the same button itself.
const menuButtonClassName =
  "type-menu peer/menu-button group/menu-button relative flex h-8 w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left ring-sidebar-ring outline-hidden transition-[width,height,padding,color,background-color,border-color,box-shadow] duration-150 group-data-[collapsible=icon]:size-[40px]! group-data-[collapsible=icon]:p-[10px]! before:pointer-events-none before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:bg-transparent before:transition-colors before:content-[''] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring/45 active:bg-sidebar-accent active:text-sidebar-accent-foreground data-active:bg-transparent data-active:font-medium data-active:text-primary data-active:before:bg-primary data-active:hover:bg-primary/6 data-active:hover:text-primary [&_svg]:size-4 [&_svg]:shrink-0 group-data-[collapsible=icon]:[&_svg]:size-[20px]! [&>span:last-child]:truncate"

function MenuButton({
  active = false,
  className,
  ...props
}: React.ComponentProps<"button"> & { active?: boolean }) {
  return (
    <button
      type="button"
      data-sidebar="menu-button"
      data-size="default"
      data-active={active || undefined}
      aria-current={active ? "page" : undefined}
      className={cn(menuButtonClassName, className)}
      {...props}
    />
  )
}

// What the demo can't open stays in place, so the sidebar reads as Hearth's,
// but dimmed and out of reach, so nobody expects a click to work.
const unavailable = { className: "opacity-40", inert: true } as const

const paperIcon = officialBricks.find((brick) => brick.name === "Paper")!.icon

const infrastructure = [
  { count: 2, icon: RelayKindIcon, label: "Relays" },
  { count: 4, icon: ServerKindIcon, label: "Game Servers" },
  { count: 2, icon: DatabaseKindIcon, label: "Databases" },
  { count: 3, icon: AppKindIcon, label: "Apps" },
]

const serverTabs: Array<{
  icon: typeof Folder
  label: string
  view?: DemoView
}> = [
  { icon: TerminalSquare, label: "Console", view: "console" },
  { icon: Folder, label: "Files", view: "files" },
  { icon: Rocket, label: "Startup" },
  { icon: Network, label: "Network" },
  { icon: SlidersHorizontal, label: "Info" },
]

const manage = [
  { icon: CalendarClock, label: "Automations" },
  { icon: BackupIcon, label: "Backups" },
  { icon: ListTodo, label: "Activity" },
  { icon: UserRoundCog, label: "Access" },
]

// Hearth's sidebar as it looks with a game server open. Console and Files
// switch the demo's page.
export const DemoSidebar = React.memo(function DemoSidebar({
  collapsed,
  className,
  onViewChange,
  running,
  view,
}: {
  collapsed: boolean
  className?: string
  onViewChange: (view: DemoView) => void
  running: boolean
  view: DemoView
}) {
  return (
    <nav
      aria-label="Hearth"
      data-collapsible={collapsed ? "icon" : ""}
      data-state={collapsed ? "collapsed" : "expanded"}
      className={cn(
        "group flex h-full w-64 shrink-0 flex-col overflow-hidden border-r border-sidebar-border/80 bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-linear data-[collapsible=icon]:w-[60px]",
        className
      )}
    >
      <SidebarHeader className="h-20 shrink-0 justify-center px-2 py-2">
        <SidebarMenu>
          <SidebarMenuItem className="flex items-center gap-1">
            <div className="flex h-11 min-w-0 flex-1 items-center gap-2 p-2 group-data-[collapsible=icon]:size-[40px] group-data-[collapsible=icon]:p-0">
              <HearthMark className="group-data-[collapsible=icon]:size-[40px]!" />
              <span className="min-w-0 flex-1 truncate font-heading text-2xl font-semibold tracking-[0.04em] group-data-[collapsible=icon]:hidden">
                KILN
              </span>
            </div>
            <button
              inert
              type="button"
              aria-label="Notifications"
              className="mr-1 grid size-8 shrink-0 place-items-center text-sidebar-foreground/60 opacity-40 transition-colors group-data-[collapsible=icon]:hidden hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <Bell className="size-4" />
            </button>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <div className="shrink-0 p-2 group-data-[collapsible=icon]:px-0">
        <SidebarMenu>
          <SidebarMenuItem {...unavailable}>
            <MenuButton
              aria-label="Search Kiln"
              className="h-8 w-full justify-start gap-2.5 bg-black/25 px-2 shadow-[0_0_0_0.5px_color-mix(in_oklab,var(--sidebar-foreground)_16%,transparent)]! group-data-[collapsible=icon]:justify-center hover:bg-black/35 hover:shadow-[0_0_0_0.5px_color-mix(in_oklab,var(--sidebar-foreground)_24%,transparent)]!"
            >
              <Search />
              <span className="min-w-0 flex-1 truncate text-sidebar-foreground/60 group-data-[collapsible=icon]:sr-only">
                Search Kiln...
              </span>
              <Kbd className="h-[18px] min-w-8 gap-0.5 px-1 group-data-[collapsible=icon]:hidden">
                <CommandIcon className="size-3!" aria-hidden="true" />
                <span>K</span>
              </Kbd>
            </MenuButton>
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
              {infrastructure.map((item) => (
                <SidebarMenuItem key={item.label} {...unavailable}>
                  <MenuButton>
                    <item.icon />
                    <span>{item.label}</span>
                  </MenuButton>
                  <SidebarMenuBadge className="text-sidebar-muted-foreground">
                    {item.count}
                  </SidebarMenuBadge>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator />
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem {...unavailable}>
                <MenuButton
                  aria-label={`Switch game server. ${demoServer.name}`}
                  className="mb-1.5 h-auto border border-sidebar-border/75 bg-background/35 px-2 py-2 group-data-[collapsible=icon]:h-[40px]! group-data-[collapsible=icon]:overflow-visible group-data-[collapsible=icon]:bg-black/25 hover:border-sidebar-border hover:bg-sidebar-accent"
                >
                  <IdentityName
                    className="min-w-0 flex-1 gap-2 group-data-[collapsible=icon]:gap-0"
                    icon={<PaperIcon />}
                    iconClassName="border-sidebar-border/70 bg-background/25 text-sidebar-foreground/85 group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:inset-0 group-data-[collapsible=icon]:size-full group-data-[collapsible=icon]:rounded-none group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent"
                    meta={`${demoServer.implementation} ${demoServer.version}`}
                    metaClassName="text-sidebar-muted-foreground"
                    name={demoServer.name}
                    nameClassName="type-control-sm text-sidebar-foreground"
                    status={
                      running
                        ? { label: "Running", tone: "success" }
                        : { label: "Stopped", tone: "neutral" }
                    }
                    statusClassName="ring-popover"
                    textClassName="group-data-[collapsible=icon]:sr-only"
                  />
                  <ChevronsUpDown className="ml-auto size-3.5! text-sidebar-foreground/60 group-data-[collapsible=icon]:hidden" />
                </MenuButton>
              </SidebarMenuItem>
              {serverTabs.map((tab) => (
                <SidebarMenuItem
                  key={tab.label}
                  {...(tab.view ? {} : unavailable)}
                >
                  <MenuButton
                    active={tab.view === view}
                    onClick={
                      tab.view ? () => onViewChange(tab.view!) : undefined
                    }
                  >
                    <tab.icon />
                    <span>{tab.label}</span>
                  </MenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarSeparator />
        <SidebarGroup className="p-0">
          <SidebarGroupLabel className="type-technical-label">
            Manage
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {manage.map((item) => (
                <SidebarMenuItem key={item.label} {...unavailable}>
                  <MenuButton>
                    <item.icon />
                    <span>{item.label}</span>
                  </MenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator />
        <SidebarMenu>
          <SidebarMenuItem>
            <div
              inert
              className="flex h-11 items-center gap-1 px-2 opacity-40 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
            >
              <span className="flex min-w-0 flex-1 items-center gap-2 group-data-[collapsible=icon]:flex-none">
                <Avatar aria-hidden="true" className="rounded-none">
                  <AvatarFallback className="type-label rounded-none bg-primary/12 font-bold text-primary">
                    JL
                  </AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1 truncate text-xs font-semibold group-data-[collapsible=icon]:hidden">
                  Jordan Lee
                </span>
              </span>
              <span
                aria-hidden="true"
                className="grid size-7 shrink-0 place-items-center text-sidebar-foreground/55 group-data-[collapsible=icon]:hidden"
              >
                <Settings className="size-4" />
              </span>
              <span
                aria-hidden="true"
                className="ml-auto grid size-7 shrink-0 place-items-center text-sidebar-foreground/55 group-data-[collapsible=icon]:hidden"
              >
                <LogOut className="size-4" />
              </span>
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </nav>
  )
})

function PaperIcon() {
  return (
    <span
      className="grid size-4 place-items-center text-[#e67e7e] group-data-[collapsible=icon]:size-5!"
      aria-hidden="true"
    >
      <BrickMark icon={paperIcon} />
    </span>
  )
}
