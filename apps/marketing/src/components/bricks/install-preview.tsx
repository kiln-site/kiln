import * as React from "react"
import { ChevronRight, GitBranch, KeyRound, Sparkles } from "lucide-react"

import {
  type BrickV2,
  type BrickV2Input,
  type BrickV2Value,
  brickV2InputDefault,
  brickV2NeedsSource,
  brickV2OptionLabel,
  brickV2OptionValue,
  brickV2Pattern,
  brickV2PortExposure,
  renderBrickV2Template,
} from "@workspace/contracts"
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

import { BrickTile } from "~/components/bricks/brick-glyph"
import { brickDeployLabels, brickKindLabels } from "~/lib/bricks"

type Values = Record<string, BrickV2Value | undefined>

const noInputs: ReadonlyArray<BrickV2Input> = []

// What installing a Brick looks like: the form Hearth asks someone to fill
// in, and what Kiln runs with their answers. Try values in the form and the
// right side follows, suggestions and templates included.
export function InstallPreview({
  brick,
  iconUrl,
  layout = "split",
}: {
  brick: BrickV2
  iconUrl: string | undefined
  layout?: "split" | "stacked"
}) {
  const inputs = brick.inputs ?? noInputs
  const [editedName, setName] = React.useState<string | null>(null)
  const name = editedName ?? brick.name
  const [edited, setEdited] = React.useState<Values>({})
  const values = React.useMemo(
    () => effectiveValues(inputs, edited),
    [inputs, edited]
  )
  const shown = React.useMemo(
    () => displayValues(brick, inputs, values, name),
    [brick, inputs, values, name]
  )
  const onValue = React.useCallback((key: string, value: BrickV2Value) => {
    setEdited((current) => ({ ...current, [key]: value }))
  }, [])

  return (
    <div
      className={cn(
        "grid gap-px border border-border bg-border",
        layout === "split" && "lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]"
      )}
    >
      <section aria-label="Install form" className="min-w-0 bg-background">
        <PaneHeading>What someone fills in</PaneHeading>
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <BrickTile color={brick.color} iconUrl={iconUrl} id={brick.id} />
          <div className="min-w-0">
            <p className="type-section-title truncate">
              New {brickKindLabels[brick.kind].toLowerCase()}
            </p>
            <p className="type-meta truncate text-muted-foreground">
              From the {brick.name || "untitled"} Brick
            </p>
          </div>
        </div>
        <InstallForm
          brick={brick}
          inputs={inputs}
          name={name}
          onName={setName}
          onValue={onValue}
          values={values}
        />
      </section>
      <section aria-label="What Kiln runs" className="min-w-0 bg-background">
        <PaneHeading>What Kiln runs</PaneHeading>
        <RunSummary brick={brick} shown={shown} />
      </section>
    </div>
  )
}

function PaneHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="type-technical-label border-b border-border bg-card/60 px-5 py-2.5 text-muted-foreground">
      {children}
    </h3>
  )
}

const InstallForm = React.memo(function InstallForm({
  brick,
  inputs,
  name,
  onName,
  onValue,
  values,
}: {
  brick: BrickV2
  inputs: ReadonlyArray<BrickV2Input>
  name: string
  onName: (name: string) => void
  onValue: (key: string, value: BrickV2Value) => void
  values: Values
}) {
  const id = React.useId()
  const basic = inputs.filter((input) => !input.advanced)
  const advanced = inputs.filter((input) => input.advanced)
  const memory =
    brick.deploy.type === "static" ? undefined : brick.deploy.resources?.memory

  return (
    <div className="flex flex-col gap-4 px-5 py-5">
      <Field label="Name" htmlFor={`${id}-name`}>
        <Input
          id={`${id}-name`}
          value={name}
          onChange={(event) => onName(event.target.value)}
        />
      </Field>
      {brickV2NeedsSource(brick.deploy) ? (
        <Field
          label="Source"
          help="A Git repository, built on every push, or an upload."
        >
          <div className="type-support flex h-8 items-center gap-2 border border-dashed border-input px-2.5 text-muted-foreground">
            <GitBranch className="size-3.5" />
            Pick a repository
          </div>
        </Field>
      ) : null}
      {basic.map((input) => (
        <InputField
          key={input.key}
          input={input}
          onValue={onValue}
          value={values[input.key]}
        />
      ))}
      {memory ? (
        <Field
          label="Memory"
          help="Kiln's own limit. The Brick only suggests it."
        >
          <div className="type-code flex h-8 items-center border border-input bg-input/18 px-2.5">
            {memory}
          </div>
        </Field>
      ) : null}
      {advanced.length > 0 ? (
        <details className="group border-t border-border pt-3">
          <summary className="type-control flex cursor-pointer list-none items-center gap-1.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
            Advanced
            <span className="type-meta">({advanced.length})</span>
          </summary>
          <div className="mt-4 flex flex-col gap-4">
            {advanced.map((input) => (
              <InputField
                key={input.key}
                input={input}
                onValue={onValue}
                value={values[input.key]}
              />
            ))}
          </div>
        </details>
      ) : null}
      {inputs.length === 0 ? (
        <p className="type-support text-muted-foreground">
          This Brick asks for nothing else.
        </p>
      ) : null}
    </div>
  )
})

function Field({
  children,
  error,
  help,
  htmlFor,
  label,
  optional,
}: {
  children: React.ReactNode
  error?: string | undefined
  help?: string | undefined
  htmlFor?: string
  label: string
  optional?: boolean | undefined
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={htmlFor} className="type-label flex items-center gap-1.5">
        {label}
        {optional ? (
          <span className="font-normal text-muted-foreground">Optional</span>
        ) : null}
      </label>
      {children}
      {error ? (
        <p className="type-meta text-destructive">{error}</p>
      ) : help ? (
        <p className="type-meta text-muted-foreground">{help}</p>
      ) : null}
    </div>
  )
}

const InputField = React.memo(function InputField({
  input,
  onValue,
  value,
}: {
  input: BrickV2Input
  onValue: (key: string, value: BrickV2Value) => void
  value: BrickV2Value | undefined
}) {
  const id = React.useId()
  const error = inputError(input, value)
  const common = {
    error,
    help: input.help,
    htmlFor: id,
    label: input.label || input.key,
    optional: input.optional,
  }

  if (input.type === "boolean") {
    return (
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <label htmlFor={id} className="type-label">
            {input.label || input.key}
          </label>
          {input.help ? (
            <p className="type-meta mt-0.5 text-muted-foreground">
              {input.help}
            </p>
          ) : null}
        </div>
        <Switch
          id={id}
          checked={value === true}
          onCheckedChange={(checked) => onValue(input.key, checked)}
        />
      </div>
    )
  }

  if (input.type === "select") {
    const options = input.options ?? []
    return (
      <Field {...common}>
        <Select
          value={value === undefined ? "" : String(value)}
          onValueChange={(next) => {
            const option = options.find(
              (candidate) => String(brickV2OptionValue(candidate)) === next
            )
            if (option !== undefined)
              onValue(input.key, brickV2OptionValue(option))
          }}
        >
          <SelectTrigger id={id} className="w-full">
            <SelectValue placeholder="Choose one" />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem
                key={String(brickV2OptionValue(option))}
                value={String(brickV2OptionValue(option))}
              >
                {brickV2OptionLabel(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    )
  }

  if (input.type === "secret" && input.generate && value === undefined) {
    return (
      <Field {...common}>
        <div className="type-support flex h-8 items-center gap-2 border border-input bg-input/18 px-2.5 text-muted-foreground">
          <Sparkles className="size-3.5 text-primary-ink" />
          Kiln generates one
          <button
            type="button"
            className="ml-auto text-foreground underline-offset-4 hover:underline"
            onClick={() => onValue(input.key, "")}
          >
            Set my own
          </button>
        </div>
      </Field>
    )
  }

  return (
    <Field {...common}>
      <Input
        id={id}
        type={
          input.type === "number"
            ? "number"
            : input.type === "secret"
              ? "password"
              : "text"
        }
        aria-invalid={error ? true : undefined}
        placeholder={input.placeholder}
        value={value === undefined ? "" : String(value)}
        onChange={(event) =>
          onValue(
            input.key,
            input.type === "number"
              ? Number(event.target.value)
              : event.target.value
          )
        }
        className={input.type === "text" ? "font-mono text-sm" : undefined}
      />
    </Field>
  )
})

function inputError(
  input: BrickV2Input,
  value: BrickV2Value | undefined
): string | undefined {
  if (value === undefined || value === "") {
    return input.optional || (input.type === "secret" && input.generate)
      ? undefined
      : "Required"
  }
  if (typeof value === "string") {
    if (input.min !== undefined && value.length < input.min) {
      return `At least ${input.min} characters`
    }
    if (input.max !== undefined && value.length > input.max) {
      return `At most ${input.max} characters`
    }
    if (input.pattern && !brickV2Pattern(input.pattern)?.test(value)) {
      return "That doesn't match the expected format"
    }
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "Enter a number"
    if (input.min !== undefined && value < input.min)
      return `At least ${input.min}`
    if (input.max !== undefined && value > input.max)
      return `At most ${input.max}`
  }
  return undefined
}

// Each input's value: what was typed, otherwise its default given the others.
// Two passes let a suggestion follow an input declared after it.
function effectiveValues(
  inputs: ReadonlyArray<BrickV2Input>,
  edited: Values
): Values {
  let values: Values = {}
  for (let pass = 0; pass < 2; pass += 1) {
    const next: Values = {}
    for (const input of inputs) {
      next[input.key] =
        input.key in edited
          ? edited[input.key]
          : brickV2InputDefault(input, { ...values, ...next })
    }
    values = next
  }
  return values
}

// What templates show: secrets hidden, generated ones named as such.
function displayValues(
  brick: BrickV2,
  inputs: ReadonlyArray<BrickV2Input>,
  values: Values,
  name: string
): Values {
  const shown: Values = {
    "kiln.brick": brick.id,
    "kiln.host": `${brick.id || "brick"}-7f3a2c1e`,
    "kiln.name": name,
  }
  for (const input of inputs) {
    const value = values[input.key]
    shown[input.key] =
      input.type !== "secret"
        ? (value ?? "")
        : value === undefined || value === ""
          ? "‹generated›"
          : "••••••••"
  }
  return shown
}

const RunSummary = React.memo(function RunSummary({
  brick,
  shown,
}: {
  brick: BrickV2
  shown: Values
}) {
  const deploy = brick.deploy
  const render = (template: string) => renderBrickV2Template(template, shown)
  const rows: Array<React.ReactNode> = []
  const row = (label: string, value: React.ReactNode, template?: string) =>
    rows.push(
      <Row key={label} label={label} template={template}>
        {value}
      </Row>
    )

  row("Runs", brickDeployLabels[deploy.type])
  if (deploy.type === "image") {
    row("Image", <Code>{render(deploy.image)}</Code>, deploy.image)
  }
  if (deploy.type === "dockerfile") {
    row(
      "Builds",
      deploy.dockerfile !== undefined ? (
        <CodeBlock text={render(deploy.dockerfile)} />
      ) : (
        <span>
          <Code>{render(deploy.path ?? "Dockerfile")}</Code> from the chosen
          repository
          {deploy.context ? (
            <>
              , in <Code>{deploy.context}</Code>
            </>
          ) : null}
        </span>
      ),
      deploy.path
    )
  }
  if (deploy.type === "compose") {
    row(
      "Project",
      deploy.compose !== undefined ? (
        <CodeBlock text={render(deploy.compose)} />
      ) : (
        <span>
          <Code>{render(deploy.path ?? "compose.yaml")}</Code> from the chosen
          repository
        </span>
      ),
      deploy.path
    )
    if (deploy.service) row("Main service", <Code>{deploy.service}</Code>)
  }
  if (deploy.type === "static") {
    row("Served by", "The Relay's shared web server, no container of its own")
    const command = deploy.build ? render(deploy.build.command).trim() : ""
    row(
      "Build",
      deploy.build && command ? (
        <span className="flex flex-col gap-1">
          <Code>{command}</Code>
          <span className="type-meta text-muted-foreground">
            in <Code>{render(deploy.build.image)}</Code>
          </span>
        </span>
      ) : (
        "None, the files are served as they are"
      ),
      deploy.build?.command
    )
    row("Folder", <Code>{render(deploy.root ?? ".")}</Code>, deploy.root)
    if (deploy.spa) row("Unknown paths", <span>Answered with index.html</span>)
    if (deploy.headers && Object.keys(deploy.headers).length > 0) {
      row("Headers", <KeyValues entries={Object.entries(deploy.headers)} />)
    }
  }

  if (deploy.type === "image" || deploy.type === "dockerfile") {
    if (deploy.entrypoint?.length) {
      row("Entrypoint", <Code>{deploy.entrypoint.map(render).join(" ")}</Code>)
    }
    if (deploy.command?.length) {
      row("Command", <Code>{deploy.command.map(render).join(" ")}</Code>)
    }
    if (deploy.user) row("User", <Code>{deploy.user}</Code>)
    if (deploy.workdir) row("Working folder", <Code>{deploy.workdir}</Code>)
  }
  if (deploy.type !== "static") {
    const env = Object.entries(deploy.env ?? {})
    if (env.length > 0) {
      row(
        "Environment",
        <KeyValues entries={env.map(([key, value]) => [key, render(value)])} />
      )
    }
    const ports = deploy.ports ?? []
    if (ports.length > 0) {
      row(
        "Ports",
        <ul className="flex flex-col gap-1.5">
          {ports.map((port, index) => (
            <li
              key={`${port.name}-${index}`}
              className="flex flex-wrap items-center gap-2"
            >
              <Code>
                {port.port}/{port.protocol ?? "tcp"}
              </Code>
              <span className="text-muted-foreground">{port.name}</span>
              {port.service ? (
                <span className="type-meta text-muted-foreground">
                  on {port.service}
                </span>
              ) : null}
              <Exposure exposure={brickV2PortExposure(brick.kind, port)} />
              {index === 0 ? (
                <span className="type-meta text-muted-foreground">primary</span>
              ) : null}
            </li>
          ))}
        </ul>
      )
    }
  }
  if (deploy.type === "image" || deploy.type === "dockerfile") {
    if (deploy.volumes?.length) {
      row(
        "Keeps",
        <ul className="flex flex-col gap-1">
          {deploy.volumes.map((volume, index) => (
            <li key={volume.path} className="flex items-center gap-2">
              <Code>{volume.path}</Code>
              {index === 0 ? (
                <span className="type-meta text-muted-foreground">
                  shown in Files
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )
    }
    if (deploy.files?.length) {
      row(
        "Writes",
        <ul className="flex flex-col gap-2">
          {deploy.files.map((file) => (
            <li key={file.path} className="flex flex-col gap-1">
              <span className="flex items-center gap-2">
                <Code>{file.path}</Code>
                <span className="type-meta text-muted-foreground">
                  {file.once ? "once" : "every start"}
                </span>
              </span>
              <CodeBlock text={render(file.content)} />
            </li>
          ))}
        </ul>
      )
    }
  }
  if (deploy.type !== "static" && deploy.ready) {
    const ready = deploy.ready
    row(
      "Ready when",
      ready.type === "log" ? (
        <span className="flex flex-col gap-1">
          the log shows
          {ready.match.map((line) => (
            <Code key={line}>{line}</Code>
          ))}
        </span>
      ) : ready.type === "command" ? (
        <span className="flex flex-col gap-1">
          this succeeds <Code>{render(ready.command)}</Code>
        </span>
      ) : (
        <span>
          <Code>GET {ready.path}</Code> answers
          {ready.port ? <> on {ready.port}</> : null}
        </span>
      )
    )
  }
  if (deploy.type !== "static" && deploy.resources) {
    const { cpu, memory, pids } = deploy.resources
    const parts = [
      memory ? `${memory} memory` : null,
      cpu ? `${cpu} CPU` : null,
      pids ? `${pids} processes` : null,
    ].filter(Boolean)
    if (parts.length > 0) row("Starts with", parts.join(", "))
  }
  if (brick.platforms?.length) {
    row("Runs on", brick.platforms.join(", "))
  }

  if (brick.game) {
    const game = brick.game
    row("Game", game.title || "Untitled")
    row(
      "Players connect",
      game.routing === "minecraft"
        ? "Through Kiln's Minecraft routing, with SRV records"
        : "Straight to its published ports"
    )
    if (game.hostname) {
      row("Address", <Code>{render(game.hostname)}</Code>, game.hostname)
    }
    if (game.stop?.length) {
      row(
        "Stops with",
        <span className="flex flex-wrap gap-1.5">
          {game.stop.map((command) => (
            <Code key={command}>{command}</Code>
          ))}
        </span>
      )
    }
  }
  if (brick.database) {
    const database = brick.database
    row("Engine", <Code>{database.engine}</Code>)
    row(
      "Connect with",
      <Code>{render(database.connection)}</Code>,
      database.connection
    )
    row(
      "Viewer",
      database.viewer
        ? `Hearth's ${database.viewer === "mysql" ? "MySQL" : "PostgreSQL"} viewer`
        : "None, connect a client of your own"
    )
    row(
      "Backups",
      database.backup ? (
        <span className="flex flex-col gap-1">
          <Code>{render(database.backup.command)}</Code>
          <span className="type-meta text-muted-foreground">
            saved as .{database.backup.extension}
            {database.restore ? ", restorable" : ""}
          </span>
        </span>
      ) : (
        "Snapshots of its volume"
      )
    )
  }

  return <dl className="divide-y divide-border">{rows}</dl>
})

function Row({
  children,
  label,
  template,
}: {
  children: React.ReactNode
  label: string
  template?: string | undefined
}) {
  return (
    <div className="grid gap-1 px-5 py-3 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-4">
      <dt className="type-label pt-0.5 text-muted-foreground">{label}</dt>
      <dd className="type-support min-w-0">
        {children}
        {template?.includes("{{") ? (
          <span className="type-meta mt-1 block truncate font-mono text-muted-foreground/80">
            from {template}
          </span>
        ) : null}
      </dd>
    </div>
  )
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="type-code break-all text-foreground">{children}</code>
}

function CodeBlock({ text }: { text: string }) {
  return (
    <pre className="type-code max-h-56 overflow-auto border border-border bg-card/60 p-2.5 whitespace-pre-wrap text-foreground">
      {text}
    </pre>
  )
}

function KeyValues({
  entries,
}: {
  entries: ReadonlyArray<readonly [string, string]>
}) {
  return (
    <ul className="flex flex-col gap-1">
      {entries.map(([key, value]) => (
        <li key={key} className="type-code min-w-0 break-all">
          <span className="text-muted-foreground">{key}=</span>
          <span className="text-foreground">
            {value === "" ? (
              <span className="text-muted-foreground/70">""</span>
            ) : (
              value
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

const exposureLabels = {
  public: "Public port",
  http: "HTTPS domain",
  private: "Private",
} as const

function Exposure({ exposure }: { exposure: keyof typeof exposureLabels }) {
  return (
    <span
      className={cn(
        "type-label inline-flex items-center gap-1 border px-1.5",
        exposure === "private"
          ? "border-border text-muted-foreground"
          : "border-primary/40 text-primary-ink"
      )}
    >
      {exposure === "private" ? <KeyRound className="size-3" /> : null}
      {exposureLabels[exposure]}
    </span>
  )
}
