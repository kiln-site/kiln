import * as React from "react"
import {
  Activity,
  AtSign,
  Braces,
  DatabaseBackup,
  FileCode2,
  FileText,
  HardDrive,
  Link2,
  Plug,
  Plus,
  Power,
  Terminal,
  Trash2,
  X,
} from "lucide-react"

import {
  type BrickV2,
  type BrickV2ContainerDeploy,
  type BrickV2Port,
  type BrickV2Ready,
  type BrickV2RunDeploy,
  brickV2PortExposure,
} from "@workspace/contracts"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Textarea } from "@workspace/ui/components/textarea"
import { cn } from "@workspace/ui/lib/utils"

import {
  FieldShell,
  NumberField,
  Segmented,
  SelectField,
  SwitchField,
  TextField,
  useIssue,
} from "~/components/bricks/creator/creator-fields"
import type { Edit } from "~/components/bricks/creator/creator-edit"
import { useSetter } from "~/components/bricks/creator/creator-edit"
import {
  type CreatorPanel,
  setIn,
} from "~/components/bricks/creator/creator-state"
import { InputDialog } from "~/components/bricks/creator/input-dialog"
import {
  PanelDialog,
  PanelOpenContext,
} from "~/components/bricks/creator/panel-dialog"

const SyntaxCodeEditor = React.lazy(() =>
  import("@/components/syntax-code-editor").then((module) => ({
    default: module.SyntaxCodeEditor,
  }))
)

// The one dialog open at a time, for whichever part of the Brick is being
// edited.
export function PanelHost({
  brick,
  edit,
  onClose,
  onMoveInput,
  open,
  panel,
}: {
  brick: BrickV2
  edit: Edit
  onClose: () => void
  // Moves the question being edited and keeps editing it.
  onMoveInput: (offset: number) => void
  // False while the dialog animates out, before `panel` is cleared.
  open: boolean
  panel: CreatorPanel | null
}) {
  if (!panel) return null
  return (
    <PanelOpenContext.Provider value={open}>
      <Panel
        brick={brick}
        edit={edit}
        onClose={onClose}
        onMoveInput={onMoveInput}
        panel={panel}
      />
    </PanelOpenContext.Provider>
  )
}

function Panel({
  brick,
  edit,
  onClose,
  onMoveInput,
  panel,
}: {
  brick: BrickV2
  edit: Edit
  onClose: () => void
  onMoveInput: (offset: number) => void
  panel: CreatorPanel
}) {
  if (panel.kind === "input") {
    return (
      <InputDialog
        key={panel.index}
        edit={edit}
        index={panel.index}
        input={brick.inputs?.[panel.index]}
        keys={(brick.inputs ?? []).map((input) => input.key)}
        onClose={onClose}
        onMove={onMoveInput}
      />
    )
  }
  if (panel.kind === "connection" || panel.kind === "backups") {
    return (
      <DatabaseDialog
        brick={brick}
        edit={edit}
        onClose={onClose}
        panel={panel.kind}
      />
    )
  }
  const deploy = brick.deploy
  if (deploy.type === "static") return null
  const props = { deploy, edit, kind: brick.kind, onClose }
  switch (panel.kind) {
    case "env":
      return <EnvDialog {...props} />
    case "ports":
      return <PortsDialog {...props} />
    case "ready":
      return <ReadyDialog {...props} />
    case "address":
      return <AddressDialog {...props} />
    case "stop":
      return <StopDialog {...props} />
    case "source":
      return <SourceDialog {...props} />
  }
  if (deploy.type !== "image" && deploy.type !== "dockerfile") return null
  const containerProps = { ...props, deploy }
  switch (panel.kind) {
    case "volumes":
      return <VolumesDialog {...containerProps} />
    case "files":
      return <FilesDialog {...containerProps} />
    case "command":
      return <CommandDialog {...containerProps} />
  }
  return null
}

interface DeployDialogProps<D> {
  deploy: D
  edit: Edit
  kind: BrickV2["kind"]
  onClose: () => void
}

function AddButton({
  children,
  onClick,
}: {
  children: React.ReactNode
  onClick: () => void
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      className="self-start"
    >
      <Plus />
      {children}
    </Button>
  )
}

function RemoveButton({
  label,
  onClick,
}: {
  label: string
  onClick: () => void
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      onClick={onClick}
      className="hover:text-destructive"
    >
      <Trash2 />
    </Button>
  )
}

function EnvDialog({
  deploy,
  edit,
  onClose,
}: DeployDialogProps<BrickV2RunDeploy>) {
  // Rows keep their order and blanks while editing; the record is written
  // from them on every change.
  const [rows, setRows] = React.useState(() =>
    Object.entries(deploy.env ?? {}).map(([key, value]) => ({ key, value }))
  )
  const [pasting, setPasting] = React.useState(false)
  const write = (next: typeof rows) => {
    setRows(next)
    const record = Object.fromEntries(
      next
        .filter((row) => row.key.trim())
        .map((row) => [row.key.trim(), row.value])
    )
    edit((brick) =>
      setIn(
        brick,
        ["deploy", "env"],
        Object.keys(record).length > 0 ? record : undefined
      )
    )
  }
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.key, (counts.get(row.key) ?? 0) + 1)
  return (
    <PanelDialog
      onClose={onClose}
      icon={Braces}
      title="Environment"
      description={
        deploy.type === "compose"
          ? "Written to the project's .env. Values can use {{ templates }}."
          : "Variables the container starts with. Values can use {{ templates }}."
      }
      className="sm:max-w-2xl"
    >
      {pasting ? (
        <PasteEnv
          onCancel={() => setPasting(false)}
          onPaste={(pasted) => {
            write([...rows.filter((row) => row.key), ...pasted])
            setPasting(false)
          }}
        />
      ) : (
        <>
          {rows.length > 0 ? (
            <ul className="flex flex-col gap-1.5">
              {rows.map((row, index) => (
                <li
                  key={index}
                  className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-2"
                >
                  <Input
                    value={row.key}
                    placeholder="NAME"
                    spellCheck={false}
                    aria-label="Name"
                    aria-invalid={
                      (counts.get(row.key) ?? 0) > 1 ||
                      (row.key !== "" &&
                        !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(row.key))
                        ? true
                        : undefined
                    }
                    onChange={(event) =>
                      write(
                        rows.map((entry, other) =>
                          other === index
                            ? { ...entry, key: event.target.value }
                            : entry
                        )
                      )
                    }
                    className="h-8 font-mono text-sm"
                  />
                  <Input
                    value={row.value}
                    placeholder="value"
                    spellCheck={false}
                    aria-label="Value"
                    onChange={(event) =>
                      write(
                        rows.map((entry, other) =>
                          other === index
                            ? { ...entry, value: event.target.value }
                            : entry
                        )
                      )
                    }
                    className="h-8 font-mono text-sm"
                  />
                  <RemoveButton
                    label="Remove variable"
                    onClick={() =>
                      write(rows.filter((_, other) => other !== index))
                    }
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="type-support text-muted-foreground">
              No variables yet.
            </p>
          )}
          <div className="flex gap-2">
            <AddButton
              onClick={() => setRows([...rows, { key: "", value: "" }])}
            >
              Add variable
            </AddButton>
            <Button variant="ghost" size="sm" onClick={() => setPasting(true)}>
              Paste a .env
            </Button>
          </div>
        </>
      )}
    </PanelDialog>
  )
}

function PasteEnv({
  onCancel,
  onPaste,
}: {
  onCancel: () => void
  onPaste: (rows: Array<{ key: string; value: string }>) => void
}) {
  const [text, setText] = React.useState("")
  const rows = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const at = line.indexOf("=")
      return at === -1
        ? { key: line, value: "" }
        : { key: line.slice(0, at).trim(), value: line.slice(at + 1).trim() }
    })
  return (
    <>
      <Textarea
        autoFocus
        rows={8}
        value={text}
        spellCheck={false}
        placeholder={"VERSION={{ version }}\nTZ=UTC"}
        onChange={(event) => setText(event.target.value)}
        className="font-mono text-sm"
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={rows.length === 0}
          onClick={() => onPaste(rows)}
        >
          Add {rows.length || ""} {rows.length === 1 ? "variable" : "variables"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </>
  )
}

const exposureOptions = [
  { value: "public", label: "Public port" },
  { value: "http", label: "HTTPS domain" },
  { value: "private", label: "Private" },
] as const

function PortsDialog({
  deploy,
  edit,
  kind,
  onClose,
}: DeployDialogProps<BrickV2RunDeploy>) {
  const set = useSetter(edit)
  const ports = deploy.ports ?? []
  const write = (next: Array<BrickV2Port>) =>
    set("deploy", "ports")(next.length > 0 ? next : undefined)
  const portsIssue = useIssue("deploy.ports")
  return (
    <PanelDialog
      onClose={onClose}
      icon={Plug}
      title="Ports"
      description="What it listens on. The first one is the one Hearth shows and players or apps connect to."
      className="sm:max-w-2xl"
    >
      {portsIssue ? (
        <p className="type-support text-destructive">{portsIssue}</p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {ports.map((port, index) => (
          <li
            key={index}
            className={cn(
              "grid items-end gap-2 border border-border bg-card/40 p-2.5",
              deploy.type === "compose"
                ? "sm:grid-cols-[minmax(0,1fr)_5.5rem_6rem_8.5rem_7rem_auto]"
                : "sm:grid-cols-[minmax(0,1fr)_5.5rem_6rem_8.5rem_auto]"
            )}
          >
            <TextField
              label={index === 0 ? "Name · primary" : "Name"}
              mono
              path={`deploy.ports.${index}.name`}
              value={port.name}
              onChange={(name) =>
                set("deploy", "ports", index, "name")(name ?? "")
              }
            />
            <NumberField
              label="Port"
              path={`deploy.ports.${index}.port`}
              value={port.port}
              onChange={(value) =>
                set("deploy", "ports", index, "port")(value ?? 0)
              }
            />
            <SelectField
              label="Protocol"
              value={port.protocol ?? "tcp"}
              options={[
                { value: "tcp", label: "TCP" },
                { value: "udp", label: "UDP" },
                { value: "both", label: "Both" },
              ]}
              onChange={(value) =>
                set(
                  "deploy",
                  "ports",
                  index,
                  "protocol"
                )(value === "tcp" ? undefined : value)
              }
            />
            <SelectField
              label="Reached by"
              value={brickV2PortExposure(kind, port)}
              options={exposureOptions}
              onChange={(value) =>
                set(
                  "deploy",
                  "ports",
                  index,
                  "expose"
                )(
                  value ===
                    brickV2PortExposure(kind, { ...port, expose: undefined })
                    ? undefined
                    : value
                )
              }
            />
            {deploy.type === "compose" ? (
              <TextField
                label="Service"
                mono
                optional
                path={`deploy.ports.${index}.service`}
                value={port.service}
                onChange={set("deploy", "ports", index, "service")}
              />
            ) : null}
            <RemoveButton
              label={`Remove ${port.name || "port"}`}
              onClick={() => write(ports.filter((_, other) => other !== index))}
            />
          </li>
        ))}
      </ul>
      <AddButton
        onClick={() =>
          write([
            ...ports,
            {
              name: ports.length === 0 ? "web" : `port-${ports.length + 1}`,
              port: 8080,
            },
          ])
        }
      >
        Add port
      </AddButton>
      <p className="type-meta text-muted-foreground">
        Public ports open on the Relay; HTTPS domains go through its proxy;
        private ports are only for instances connected to it. Kiln picks the
        host port.
      </p>
    </PanelDialog>
  )
}

function VolumesDialog({
  deploy,
  edit,
  onClose,
}: DeployDialogProps<BrickV2ContainerDeploy>) {
  const set = useSetter(edit)
  const volumes = deploy.volumes ?? []
  const write = (next: Array<string>) =>
    set("deploy", "volumes")(next.length > 0 ? next : undefined)
  return (
    <PanelDialog
      onClose={onClose}
      icon={HardDrive}
      title="Kept data"
      description="Folders kept across restarts and updates. Everything else starts fresh on every deploy."
    >
      <ul className="flex flex-col gap-1.5">
        {volumes.map((path, index) => (
          <li
            key={index}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2"
          >
            <div className="relative">
              <Input
                value={path}
                spellCheck={false}
                onChange={(event) =>
                  write(
                    volumes.map((entry, other) =>
                      other === index ? event.target.value : entry
                    )
                  )
                }
                className="h-8 pr-28 font-mono text-sm"
              />
              {index === 0 ? (
                <span className="type-meta pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground">
                  shown in Files
                </span>
              ) : null}
            </div>
            <RemoveButton
              label="Remove folder"
              onClick={() =>
                write(volumes.filter((_, other) => other !== index))
              }
            />
          </li>
        ))}
      </ul>
      <AddButton
        onClick={() =>
          write([...volumes, volumes.length === 0 ? "/data" : "/"])
        }
      >
        Add folder
      </AddButton>
    </PanelDialog>
  )
}

function FilesDialog({
  deploy,
  edit,
  onClose,
}: DeployDialogProps<BrickV2ContainerDeploy>) {
  const set = useSetter(edit)
  const files = deploy.files ?? []
  const write = (next: typeof files) =>
    set("deploy", "files")(next.length > 0 ? next : undefined)
  return (
    <PanelDialog
      onClose={onClose}
      icon={FileText}
      title="Files"
      description="Written into the container before it starts, like a config file. Content can use {{ templates }}."
      className="sm:max-w-2xl"
    >
      {files.map((file, index) => (
        <div
          key={index}
          className="flex flex-col gap-2 border border-border bg-card/40 p-3"
        >
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
            <TextField
              label="Path"
              mono
              path={`deploy.files.${index}.path`}
              value={file.path}
              onChange={(path) =>
                set("deploy", "files", index, "path")(path ?? "")
              }
            />
            <RemoveButton
              label="Remove file"
              onClick={() => write(files.filter((_, other) => other !== index))}
            />
          </div>
          <Textarea
            rows={4}
            spellCheck={false}
            aria-label="Content"
            value={file.content}
            onChange={(event) =>
              set("deploy", "files", index, "content")(event.target.value)
            }
            className="font-mono text-sm"
          />
          <SwitchField
            label="Write once"
            help="Keep later edits instead of rewriting it on every start"
            checked={file.once === true}
            onChange={(on) =>
              set("deploy", "files", index, "once")(on ? true : undefined)
            }
          />
        </div>
      ))}
      <AddButton
        onClick={() =>
          write([...files, { path: "/data/config.txt", content: "" }])
        }
      >
        Add file
      </AddButton>
    </PanelDialog>
  )
}

type ReadyKind = "start" | "log" | "command" | "http"

function ReadyDialog({
  deploy,
  edit,
  onClose,
}: DeployDialogProps<BrickV2RunDeploy>) {
  const set = useSetter(edit)
  const ready = deploy.ready
  const current: ReadyKind = !ready
    ? "start"
    : "log" in ready
      ? "log"
      : "command" in ready
        ? "command"
        : "http"
  const choose = (next: ReadyKind) => {
    const value: BrickV2Ready | undefined =
      next === "start"
        ? undefined
        : next === "log"
          ? { log: ready && "log" in ready ? ready.log : ["Done"] }
          : next === "command"
            ? { command: ready && "command" in ready ? ready.command : "" }
            : { http: ready && "http" in ready ? ready.http : "/" }
    set("deploy", "ready")(value)
  }
  const portNames = (deploy.ports ?? []).map((port) => port.name)
  return (
    <PanelDialog
      onClose={onClose}
      icon={Activity}
      title="Ready when"
      description="When Kiln shows it as running. Until then it's starting."
    >
      <Segmented
        label="Ready when"
        value={current}
        onChange={choose}
        options={[
          { value: "start", label: "It starts" },
          { value: "log", label: "A log line" },
          { value: "command", label: "A command" },
          { value: "http", label: "HTTP check" },
        ]}
      />
      {ready && "log" in ready ? (
        <ListEditor
          label="Log lines"
          help="Ready once the log shows any of these."
          values={ready.log}
          placeholder={")! For help, type"}
          onChange={(log) => set("deploy", "ready", "log")(log)}
        />
      ) : null}
      {ready && "command" in ready ? (
        <TextField
          label="Command"
          mono
          path="deploy.ready.command"
          value={ready.command}
          placeholder="pg_isready -h 127.0.0.1"
          help="Runs in the container until it succeeds."
          onChange={(command) =>
            set("deploy", "ready", "command")(command ?? "")
          }
        />
      ) : null}
      {ready && "http" in ready ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Path"
            mono
            path="deploy.ready.http"
            value={ready.http}
            onChange={(path) => set("deploy", "ready", "http")(path ?? "/")}
          />
          <SelectField
            label="On port"
            path="deploy.ready.port"
            value={ready.port ?? "\u0000primary"}
            options={[
              { value: "\u0000primary", label: "The primary port" },
              ...portNames.map((name) => ({ value: name, label: name })),
            ]}
            onChange={(port) =>
              set(
                "deploy",
                "ready",
                "port"
              )(port === "\u0000primary" ? undefined : port)
            }
          />
        </div>
      ) : null}
      {current === "start" ? (
        <p className="type-support text-muted-foreground">
          Kiln also checks that the primary port answers, for every Brick.
        </p>
      ) : null}
    </PanelDialog>
  )
}

function AddressDialog({
  deploy,
  edit,
  onClose,
}: DeployDialogProps<BrickV2RunDeploy>) {
  const set = useSetter(edit)
  return (
    <PanelDialog
      onClose={onClose}
      icon={AtSign}
      title="Address"
      description="The name it gets under the Relay's domain. Game servers also get an SRV record, so players join without a port."
    >
      <TextField
        label="Hostname"
        mono
        optional
        path="deploy.hostname"
        value={deploy.hostname}
        placeholder="{{ version }}.{{ kiln.brick }}"
        onChange={set("deploy", "hostname")}
      />
      <p className="type-support text-muted-foreground">
        Leave it empty and Kiln names it after the instance.
      </p>
    </PanelDialog>
  )
}

function StopDialog({
  deploy,
  edit,
  onClose,
}: DeployDialogProps<BrickV2RunDeploy>) {
  const set = useSetter(edit)
  return (
    <PanelDialog
      onClose={onClose}
      icon={Power}
      title="Console stop"
      description="Commands that stop it on purpose when someone types them in Hearth's console, so Kiln doesn't restart it."
    >
      <ListEditor
        label="Commands"
        values={deploy.stop ?? []}
        placeholder="stop"
        onChange={(stop) =>
          set("deploy", "stop")(stop.length > 0 ? stop : undefined)
        }
      />
    </PanelDialog>
  )
}

function CommandDialog({
  deploy,
  edit,
  onClose,
}: DeployDialogProps<BrickV2ContainerDeploy>) {
  const set = useSetter(edit)
  return (
    <PanelDialog
      onClose={onClose}
      icon={Terminal}
      title="Command"
      description="Replaces the image's own command, one argument per row. Arguments can use {{ templates }}."
    >
      <ListEditor
        label="Arguments"
        values={deploy.command ?? []}
        placeholder="--port"
        allowBlank
        onChange={(command) =>
          set("deploy", "command")(command.length > 0 ? command : undefined)
        }
      />
      <TextField
        label="Run as user"
        mono
        optional
        path="deploy.user"
        value={deploy.user}
        placeholder="1000:1000"
        help="A numeric user and group. The image's own unless set."
        onChange={set("deploy", "user")}
      />
    </PanelDialog>
  )
}

function SourceDialog({
  deploy,
  edit,
  onClose,
}: DeployDialogProps<BrickV2RunDeploy>) {
  if (deploy.type !== "dockerfile" && deploy.type !== "compose") return null
  const file = deploy.type === "dockerfile" ? "dockerfile" : "compose"
  const value =
    (deploy.type === "dockerfile" ? deploy.dockerfile : deploy.compose) ?? ""
  return (
    <PanelDialog
      onClose={onClose}
      icon={FileCode2}
      title={deploy.type === "dockerfile" ? "Dockerfile" : "Compose file"}
      description="Kept in the Brick, so installing it needs no repository."
      className="sm:max-w-4xl"
    >
      <div className="editor-grid relative h-[min(45dvh,32rem)] min-w-0 overflow-hidden border border-border md:h-[min(60vh,32rem)]">
        <React.Suspense
          fallback={
            <p className="type-support p-4 text-muted-foreground">
              Opening the editor…
            </p>
          }
        >
          <SyntaxCodeEditor
            ariaLabel={file === "dockerfile" ? "Dockerfile" : "Compose file"}
            disabled={false}
            fontSize={13}
            onChange={(next) =>
              edit((brick) => setIn(brick, ["deploy", file], next))
            }
            onSearchOpenChange={noop}
            originalValue={value}
            path={file === "dockerfile" ? "Dockerfile" : "compose.yaml"}
            redactSensitive={false}
            readOnly={false}
            searchOpen={false}
            searchQuery=""
            showChanges={false}
            value={value}
            wrapLines={false}
          />
        </React.Suspense>
      </div>
    </PanelDialog>
  )
}

const noop = () => {}

function DatabaseDialog({
  brick,
  edit,
  onClose,
  panel,
}: {
  brick: BrickV2
  edit: Edit
  onClose: () => void
  panel: "connection" | "backups"
}) {
  const set = useSetter(edit)
  const database = brick.database
  const ports = brick.deploy.type === "static" ? [] : (brick.deploy.ports ?? [])
  if (panel === "connection") {
    return (
      <PanelDialog
        onClose={onClose}
        icon={Link2}
        title="Connect with"
        description="How apps reach it. Hearth hands this URL to apps connected to the database."
      >
        <TextField
          label="Connection URL"
          mono
          path="database.connection"
          value={database?.connection}
          placeholder="postgres://{{ username }}:{{ password }}@{{ kiln.host }}:5432/{{ database }}"
          onChange={(connection) =>
            set("database", "connection")(connection ?? "")
          }
        />
        <SelectField
          label="Port"
          path="database.port"
          value={database?.port}
          options={[
            ...new Set([
              ...ports.map((port) => port.name),
              database?.port ?? "",
            ]),
          ]
            .filter(Boolean)
            .map((name) => ({ value: name, label: name }))}
          onChange={set("database", "port")}
        />
      </PanelDialog>
    )
  }
  return (
    <PanelDialog
      onClose={onClose}
      icon={DatabaseBackup}
      title="Backups"
      description="Commands that run in the container. Without them, backups snapshot its volume."
    >
      <TextField
        label="Backup"
        mono
        optional
        path="database.backup"
        value={database?.backup}
        placeholder='exec pg_dump --username "$POSTGRES_USER"'
        help="Writes a dump to stdout."
        onChange={set("database", "backup")}
      />
      <TextField
        label="Restore"
        mono
        optional
        path="database.restore"
        value={database?.restore}
        placeholder='exec psql --username "$POSTGRES_USER"'
        help="Reads a dump from stdin."
        onChange={set("database", "restore")}
      />
    </PanelDialog>
  )
}

// A short list of strings, one row each.
function ListEditor({
  allowBlank,
  help,
  label,
  onChange,
  placeholder,
  values,
}: {
  allowBlank?: boolean
  help?: string
  label: string
  onChange: (values: Array<string>) => void
  placeholder?: string
  values: ReadonlyArray<string>
}) {
  const [rows, setRows] = React.useState<Array<string>>(() => [...values])
  const write = (next: Array<string>) => {
    setRows(next)
    onChange(allowBlank ? next : next.filter((value) => value.trim()))
  }
  return (
    <FieldShell label={label} help={help}>
      <ul className="flex flex-col gap-1.5">
        {rows.map((value, index) => (
          <li
            key={index}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2"
          >
            <Input
              value={value}
              placeholder={placeholder}
              spellCheck={false}
              onChange={(event) =>
                write(
                  rows.map((entry, other) =>
                    other === index ? event.target.value : entry
                  )
                )
              }
              className="h-8 font-mono text-sm"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Remove"
              onClick={() => write(rows.filter((_, other) => other !== index))}
            >
              <X />
            </Button>
          </li>
        ))}
      </ul>
      <Button
        variant="outline"
        size="sm"
        className="mt-1 self-start"
        onClick={() => setRows([...rows, ""])}
      >
        <Plus />
        Add
      </Button>
    </FieldShell>
  )
}
