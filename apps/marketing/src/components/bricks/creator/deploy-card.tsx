import * as React from "react"
import {
  Activity,
  AtSign,
  Braces,
  CircleAlert,
  DatabaseBackup,
  FileCode2,
  FileText,
  HardDrive,
  Link2,
  type LucideIcon,
  MemoryStick,
  Plug,
  Power,
  Table2,
  Terminal,
} from "lucide-react"

import {
  type BrickV2Database,
  type BrickV2Deploy,
  type BrickV2DeployType,
  type BrickV2Kind,
  brickV2Builtins,
  brickV2PortExposure,
} from "@workspace/contracts"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { Input } from "@workspace/ui/components/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import { cn } from "@workspace/ui/lib/utils"

import { BrickGlyph } from "~/components/bricks/brick-glyph"
import {
  Segmented,
  SwitchField,
  TextField,
  useIssue,
  useIssueCount,
} from "~/components/bricks/creator/creator-fields"
import type { Edit } from "~/components/bricks/creator/creator-edit"
import { useSetter } from "~/components/bricks/creator/creator-edit"
import {
  type CreatorPanel,
  convertDeploy,
  deployAllowed,
  fieldDomId,
  setIn,
} from "~/components/bricks/creator/creator-state"
import { CardHeader } from "~/components/bricks/creator/inputs-card"
import { brickDeployLabels, officialIcons } from "~/lib/bricks"

type PanelKind = Exclude<CreatorPanel["kind"], "input">

const deployTypes: ReadonlyArray<{
  icon: string
  line: string
  type: BrickV2DeployType
}> = [
  { type: "image", icon: "docker", line: "Run an image" },
  { type: "dockerfile", icon: "dockerfile", line: "Build a Dockerfile" },
  { type: "compose", icon: "compose", line: "Run services" },
  { type: "static", icon: "static-site", line: "Serve files" },
]

const exposureLabels = {
  public: "public",
  http: "HTTPS",
  private: "private",
} as const

// How Kiln runs it: the way, its one key setting, and a tile for each other
// part, which opens a dialog.
export const DeployCard = React.memo(function DeployCard({
  database,
  deploy,
  edit,
  inputKeys,
  kind,
  onOpen,
}: {
  database: BrickV2Database | undefined
  deploy: BrickV2Deploy
  edit: Edit
  inputKeys: string
  kind: BrickV2Kind
  onOpen: (panel: PanelKind) => void
}) {
  const onType = (type: BrickV2DeployType) =>
    edit((brick) => ({ ...brick, deploy: convertDeploy(brick.deploy, type) }))

  return (
    <section aria-label="How it runs" className="border border-border">
      <CardHeader
        title="How it runs"
        detail={<TemplateNames inputKeys={inputKeys} />}
      />
      <div
        role="group"
        aria-label="Runs as"
        className="grid grid-cols-2 gap-px border-b border-border bg-border sm:grid-cols-4"
      >
        {deployTypes.map((entry) => {
          const allowed = deployAllowed(kind, entry.type)
          const icon = officialIcons.find(
            (candidate) => candidate.name === entry.icon
          )
          return (
            <button
              key={entry.type}
              type="button"
              aria-pressed={deploy.type === entry.type}
              disabled={!allowed}
              title={allowed ? undefined : "Only apps are static sites"}
              onClick={() => onType(entry.type)}
              className="group flex items-center gap-2.5 bg-background px-3 py-2 text-left transition-colors outline-none hover:bg-card/60 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-35 aria-pressed:bg-accent"
            >
              <BrickGlyph
                className="size-5"
                color={
                  deploy.type === entry.type
                    ? "var(--primary-ink)"
                    : "var(--muted-foreground)"
                }
                iconUrl={icon?.url}
                id={entry.type}
              />
              <span className="min-w-0">
                <span className="type-control-sm block truncate">
                  {brickDeployLabels[entry.type]}
                </span>
                <span className="type-meta block truncate text-muted-foreground">
                  {entry.line}
                </span>
              </span>
            </button>
          )
        })}
      </div>
      <div className="px-4 py-3">
        <MainSetting deploy={deploy} edit={edit} onOpen={onOpen} />
      </div>
      {deploy.type === "static" ? null : (
        <FacetGrid deploy={deploy} edit={edit} kind={kind} onOpen={onOpen} />
      )}
      {kind === "database" ? (
        <DatabaseTiles database={database} edit={edit} onOpen={onOpen} />
      ) : null}
    </section>
  )
})

function TemplateNames({ inputKeys }: { inputKeys: string }) {
  const names = [
    ...inputKeys.split(",").filter(Boolean),
    ...Object.keys(brickV2Builtins),
  ]
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="type-meta text-muted-foreground underline decoration-dotted underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {"{{ templates }}"}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <p className="type-section-title">Templates</p>
        <p className="type-meta mb-2 text-muted-foreground">
          Any text below can use these. Kiln fills them in at install.
        </p>
        <ul className="flex flex-col gap-1">
          {names.map((name) => (
            <li
              key={name}
              className="flex items-baseline justify-between gap-3"
            >
              <code className="type-code text-primary-ink">{`{{ ${name} }}`}</code>
              <span className="type-meta truncate text-muted-foreground">
                {name in brickV2Builtins
                  ? brickV2Builtins[name as keyof typeof brickV2Builtins]
                  : "An answer"}
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

function MainSetting({
  deploy,
  edit,
  onOpen,
}: {
  deploy: BrickV2Deploy
  edit: Edit
  onOpen: (panel: PanelKind) => void
}) {
  const set = useSetter(edit)
  if (deploy.type === "image") {
    return (
      <TextField
        label="Image"
        mono
        path="deploy.image"
        value={deploy.image}
        placeholder="ghcr.io/owner/image:{{ version }}"
        onChange={(value) => set("deploy", "image")(value ?? "")}
      />
    )
  }
  if (deploy.type === "static") {
    const build = deploy.build
    const setBuild = (field: "image" | "command", value: string | undefined) =>
      edit((brick) => {
        const next = { image: "", command: "", ...build, [field]: value ?? "" }
        return setIn(
          brick,
          ["deploy", "build"],
          next.image || next.command ? next : undefined
        )
      })
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Build command"
          mono
          optional
          path="deploy.build.command"
          value={build?.command}
          placeholder="npm ci && npm run build"
          help="Skipped when it's empty."
          onChange={(value) => setBuild("command", value)}
        />
        <TextField
          label="Built in"
          mono
          optional
          path="deploy.build.image"
          value={build?.image}
          placeholder="node:24-alpine"
          onChange={(value) => setBuild("image", value)}
        />
        <TextField
          label="Folder to serve"
          mono
          optional
          path="deploy.root"
          value={deploy.root}
          placeholder="."
          onChange={set("deploy", "root")}
        />
        <div className="self-end pb-1">
          <SwitchField
            label="Single-page app"
            help="Unknown paths get index.html"
            checked={deploy.spa === true}
            onChange={(on) => set("deploy", "spa")(on ? true : undefined)}
          />
        </div>
      </div>
    )
  }
  const file = deploy.type === "dockerfile" ? "dockerfile" : "compose"
  const label = deploy.type === "dockerfile" ? "Dockerfile" : "Compose file"
  const written =
    deploy.type === "dockerfile" ? deploy.dockerfile : deploy.compose
  const choose = (next: "repository" | "inline") =>
    edit((brick) => {
      const current = { ...brick.deploy } as Record<string, unknown>
      if (next === "repository") {
        delete current[file]
        current.path =
          deploy.path ?? (file === "dockerfile" ? "Dockerfile" : "compose.yaml")
      } else {
        delete current.path
        current[file] =
          written ?? (file === "dockerfile" ? "FROM alpine:3\n" : "services:\n")
      }
      return { ...brick, deploy: current as BrickV2Deploy }
    })
  return (
    <div className="grid gap-3 sm:grid-cols-[14rem_minmax(0,1fr)] sm:items-end">
      <Segmented
        label={`Where the ${label} is`}
        value={written === undefined ? "repository" : "inline"}
        onChange={choose}
        options={[
          { value: "repository", label: "In the repo" },
          { value: "inline", label: "In this Brick" },
        ]}
      />
      {written === undefined ? (
        <TextField
          label={`${label} path`}
          mono
          path="deploy.path"
          value={deploy.path}
          onChange={(value) => set("deploy", "path")(value ?? "")}
        />
      ) : (
        <button
          type="button"
          id={fieldDomId(`deploy.${file}`)}
          onClick={() => onOpen("source")}
          className="flex h-9 items-center gap-2 border border-border bg-input/18 px-3 text-left outline-none hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <FileCode2 className="size-4 text-primary-ink" />
          <span className="type-control-sm">Edit the {label}</span>
          <span className="type-meta ml-auto text-muted-foreground">
            {written.split("\n").filter(Boolean).length} lines
          </span>
        </button>
      )}
      {deploy.type === "compose" ? (
        <TextField
          className="sm:col-span-2"
          label="Main service"
          mono
          optional
          path="deploy.service"
          value={deploy.service}
          help="The one whose console and logs Hearth opens first."
          onChange={set("deploy", "service")}
        />
      ) : null}
    </div>
  )
}

function FacetGrid({
  deploy,
  edit,
  kind,
  onOpen,
}: {
  deploy: Exclude<BrickV2Deploy, { type: "static" }>
  edit: Edit
  kind: BrickV2Kind
  onOpen: (panel: PanelKind) => void
}) {
  const container = deploy.type === "image" || deploy.type === "dockerfile"
  const ports = deploy.ports ?? []
  const env = Object.keys(deploy.env ?? {})
  const ready = deploy.ready
  return (
    <div className="grid grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-3">
      <Tile
        icon={Plug}
        title="Ports"
        issues="deploy.ports"
        empty={ports.length === 0}
        onClick={() => onOpen("ports")}
      >
        {ports.length === 0
          ? "None"
          : ports
              .map(
                (port) =>
                  `${port.port}/${port.protocol ?? "tcp"} ${exposureLabels[brickV2PortExposure(kind, port)]}`
              )
              .join(", ")}
      </Tile>
      <Tile
        icon={Braces}
        title="Environment"
        issues="deploy.env"
        empty={env.length === 0}
        onClick={() => onOpen("env")}
      >
        {env.length === 0
          ? "None"
          : env.length <= 2
            ? env.join(", ")
            : `${env.length} variables`}
      </Tile>
      {container ? (
        <Tile
          icon={HardDrive}
          title="Kept data"
          issues="deploy.volumes"
          empty={!deploy.volumes?.length}
          onClick={() => onOpen("volumes")}
        >
          {deploy.volumes?.length ? deploy.volumes.join(", ") : "Nothing kept"}
        </Tile>
      ) : null}
      <Tile
        icon={Activity}
        title="Ready when"
        issues="deploy.ready"
        empty={!ready}
        onClick={() => onOpen("ready")}
      >
        {!ready
          ? "It starts"
          : "log" in ready
            ? `Log shows “${ready.log[0]}”`
            : "command" in ready
              ? `${ready.command} succeeds`
              : `GET ${ready.http} answers`}
      </Tile>
      <MemoryTile memory={deploy.memory} edit={edit} />
      <Tile
        icon={AtSign}
        title="Address"
        issues="deploy.hostname"
        empty={!deploy.hostname}
        onClick={() => onOpen("address")}
      >
        {deploy.hostname ?? "Kiln picks one"}
      </Tile>
      <Tile
        icon={Power}
        title="Console stop"
        issues="deploy.stop"
        empty={!deploy.stop?.length}
        onClick={() => onOpen("stop")}
      >
        {deploy.stop?.length ? deploy.stop.join(", ") : "None"}
      </Tile>
      {container ? (
        <>
          <Tile
            icon={Terminal}
            title="Command"
            issues="deploy.command,deploy.user"
            empty={!deploy.command?.length && !deploy.user}
            onClick={() => onOpen("command")}
          >
            {deploy.command?.length
              ? deploy.command.join(" ")
              : deploy.user
                ? `As ${deploy.user}`
                : "The image's own"}
          </Tile>
          <Tile
            icon={FileText}
            title="Files"
            issues="deploy.files"
            empty={!deploy.files?.length}
            onClick={() => onOpen("files")}
          >
            {deploy.files?.length
              ? deploy.files.map((file) => file.path).join(", ")
              : "None"}
          </Tile>
        </>
      ) : null}
    </div>
  )
}

function Tile({
  children,
  empty,
  icon: Icon,
  issues,
  onClick,
  title,
}: {
  children: React.ReactNode
  empty?: boolean
  icon: LucideIcon
  issues: string
  onClick: () => void
  title: string
}) {
  const count = useIssueCount(issues)
  return (
    <button
      type="button"
      id={fieldDomId(issues.split(",")[0]!)}
      onClick={onClick}
      className="group flex min-w-0 flex-col gap-1 bg-background px-3.5 py-2.5 text-left transition-colors outline-none hover:bg-card/60 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
    >
      <span className="flex items-center gap-1.5">
        <Icon className="size-3.5 text-muted-foreground group-hover:text-primary-ink" />
        <span className="type-label text-muted-foreground">{title}</span>
        {count > 0 ? (
          <CircleAlert className="ml-auto size-3.5 text-destructive" />
        ) : null}
      </span>
      <span
        className={cn(
          "type-code truncate text-[0.8125rem]",
          empty ? "text-muted-foreground/60" : "text-foreground"
        )}
      >
        {children}
      </span>
    </button>
  )
}

const memoryPresets = ["256M", "512M", "1G", "2G", "4G", "8G", "16G"]

function MemoryTile({
  edit,
  memory,
}: {
  edit: Edit
  memory: string | undefined
}) {
  const set = useSetter(edit)
  const issue = useIssue("deploy.memory")
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={fieldDomId("deploy.memory")}
          className="group flex min-w-0 flex-col gap-1 bg-background px-3.5 py-2.5 text-left transition-colors outline-none hover:bg-card/60 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
        >
          <span className="flex items-center gap-1.5">
            <MemoryStick className="size-3.5 text-muted-foreground group-hover:text-primary-ink" />
            <span className="type-label text-muted-foreground">Memory</span>
            {issue ? (
              <CircleAlert className="ml-auto size-3.5 text-destructive" />
            ) : null}
          </span>
          <span
            className={cn(
              "type-code truncate text-[0.8125rem]",
              memory ? "text-foreground" : "text-muted-foreground/60"
            )}
          >
            {memory ?? "Hearth's default"}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <p className="type-section-title">Starting memory</p>
        <p className="type-meta mb-3 text-muted-foreground">
          A suggestion. Each server's own limit in Hearth wins.
        </p>
        <div className="grid grid-cols-4 gap-1">
          {memoryPresets.map((preset) => (
            <button
              key={preset}
              type="button"
              aria-pressed={memory === preset}
              onClick={() => set("deploy", "memory")(preset)}
              className="type-code h-8 border border-border text-[0.8125rem] outline-none hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring/60 aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:text-primary-ink"
            >
              {preset}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={!memory}
            onClick={() => set("deploy", "memory")(undefined)}
            className="type-label h-8 border border-dashed border-border text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 aria-pressed:border-primary aria-pressed:text-foreground"
          >
            None
          </button>
        </div>
        <Input
          value={memory ?? ""}
          placeholder="Or type one, like 3G"
          aria-invalid={issue ? true : undefined}
          onChange={(event) =>
            set(
              "deploy",
              "memory"
            )(event.target.value.toUpperCase() || undefined)
          }
          className="mt-2 h-8 font-mono text-sm"
        />
        {issue ? (
          <p className="type-meta mt-1 text-destructive">{issue}</p>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

const viewerLabels = {
  none: "None",
  mysql: "MySQL viewer",
  postgres: "PostgreSQL viewer",
} as const

function DatabaseTiles({
  database,
  edit,
  onOpen,
}: {
  database: BrickV2Database | undefined
  edit: Edit
  onOpen: (panel: PanelKind) => void
}) {
  const set = useSetter(edit)
  return (
    <>
      <div className="flex h-9 items-center border-t border-border bg-card/40 px-4">
        <h3 className="type-technical-label text-muted-foreground">Database</h3>
      </div>
      <div className="grid grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-3">
        <Tile
          icon={Link2}
          title="Connect with"
          issues="database.port,database.connection,database"
          empty={!database?.connection}
          onClick={() => onOpen("connection")}
        >
          {database?.connection || "Not set"}
        </Tile>
        <Tile
          icon={DatabaseBackup}
          title="Backups"
          issues="database.backup,database.restore"
          empty={!database?.backup}
          onClick={() => onOpen("backups")}
        >
          {database?.backup
            ? `Dump${database.restore ? " and restore" : ""}`
            : "Volume snapshots"}
        </Tile>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="group col-span-2 flex min-w-0 flex-col gap-1 bg-background px-3.5 py-2.5 text-left transition-colors outline-none hover:bg-card/60 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset sm:col-span-1"
            >
              <span className="flex items-center gap-1.5">
                <Table2 className="size-3.5 text-muted-foreground group-hover:text-primary-ink" />
                <span className="type-label text-muted-foreground">Viewer</span>
              </span>
              <span className="type-code truncate text-[0.8125rem]">
                {viewerLabels[database?.viewer ?? "none"]}
              </span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuRadioGroup
              value={database?.viewer ?? "none"}
              onValueChange={(value) =>
                set("database", "viewer")(value === "none" ? undefined : value)
              }
            >
              {(
                Object.keys(viewerLabels) as Array<keyof typeof viewerLabels>
              ).map((value) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  {viewerLabels[value]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <p className="type-meta px-2 pt-1 pb-2 text-muted-foreground">
              Hearth opens its viewer for official Bricks only.
            </p>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  )
}
