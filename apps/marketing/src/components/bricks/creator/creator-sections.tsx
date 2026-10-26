import * as React from "react"
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react"

import {
  type BrickV2,
  type BrickV2Database,
  type BrickV2Deploy,
  type BrickV2DeployType,
  type BrickV2Game,
  type BrickV2Input,
  type BrickV2InputType,
  type BrickV2Kind,
  type BrickV2Links,
  type BrickV2Option,
  type BrickV2Port,
  type BrickV2Ready,
  brickV2Builtins,
  brickV2OptionLabel,
  brickV2OptionValue,
  brickV2PortExposure,
} from "@workspace/contracts"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Textarea } from "@workspace/ui/components/textarea"

import { BrickKindIcon } from "~/components/bricks/kind-icon"
import {
  FieldShell,
  LinesField,
  NumberField,
  SectionCard,
  Segmented,
  SelectField,
  Subheading,
  SwitchField,
  TextField,
  useIssue,
  useSyncedText,
} from "~/components/bricks/creator/creator-fields"
import {
  changeKind,
  convertDeploy,
  deployAllowed,
  kindLabels,
  setIn,
} from "~/components/bricks/creator/creator-state"
import { brickDeployLabels } from "~/lib/bricks"

export type Edit = (update: (brick: BrickV2) => BrickV2) => void
type Path = ReadonlyArray<string | number>
// Declared as a method so it's checked bivariantly: one setter serves
// fields of every value type.
type Setter = { set(value: unknown): void }["set"]

// One stable setter per path, so a memoized field keeps its props while
// another field changes.
function useSetter(edit: Edit) {
  const cache = React.useRef(new Map<string, (value: unknown) => void>())
  return React.useCallback(
    (...path: Path) => {
      const key = path.join(".")
      let setter = cache.current.get(key)
      if (!setter) {
        setter = (value: unknown) => edit((brick) => setIn(brick, path, value))
        cache.current.set(key, setter)
      }
      return setter as Setter
    },
    [edit]
  )
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64)
}

const kinds: ReadonlyArray<BrickV2Kind> = ["game-server", "app", "database"]

export const BasicsSection = React.memo(function BasicsSection({
  author,
  color,
  edit,
  icon,
  id,
  kind,
  links,
  name,
  platforms,
  summary,
  tags,
}: {
  author: string | undefined
  color: string | undefined
  edit: Edit
  icon: string | undefined
  id: string | undefined
  kind: BrickV2Kind
  links: BrickV2Links | undefined
  name: string | undefined
  platforms: BrickV2["platforms"]
  summary: string | undefined
  tags: ReadonlyArray<string> | undefined
}) {
  const set = useSetter(edit)
  const onName = React.useCallback(
    (next: string | undefined) =>
      edit((brick) => ({
        ...brick,
        name: next ?? "",
        // The id follows the name until it's given one of its own.
        id:
          !brick.id || brick.id === slug(brick.name ?? "")
            ? slug(next ?? "")
            : brick.id,
      })),
    [edit]
  )
  const onKind = React.useCallback(
    (next: BrickV2Kind) => edit((brick) => changeKind(brick, next)),
    [edit]
  )
  const onPlatform = (platform: "amd64" | "arm64", on: boolean) =>
    edit((brick) => {
      const current = new Set(brick.platforms ?? [])
      if (on) current.add(platform)
      else current.delete(platform)
      const next = (["amd64", "arm64"] as const).filter((entry) =>
        current.has(entry)
      )
      return { ...brick, platforms: next.length > 0 ? next : undefined }
    })

  return (
    <SectionCard
      id="basics"
      title="Basics"
      description="What it's called, what it is, and how it looks in the catalog."
    >
      <FieldShell label="Kind" path="kind">
        <Segmented
          label="Kind"
          value={kind}
          onChange={onKind}
          options={kinds.map((value) => ({
            value,
            label: kindLabels[value],
            icon: <BrickKindIcon kind={value} className="size-3.5" />,
          }))}
        />
      </FieldShell>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Name"
          path="name"
          value={name}
          onChange={onName}
          placeholder="Paper"
        />
        <TextField
          label="Id"
          path="id"
          mono
          value={id}
          onChange={set("id")}
          help="Lowercase letters, numbers, and dashes."
          placeholder="paper"
        />
      </div>
      <TextField
        label="Summary"
        path="summary"
        value={summary}
        onChange={set("summary")}
        help="One line for the catalog."
        placeholder="Fast, plugin-compatible Minecraft server."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Author"
          path="author"
          value={author}
          onChange={set("author")}
          placeholder="Your name"
        />
        <TagsField tags={tags} onChange={set("tags")} />
      </div>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <TextField
          label="Icon"
          path="icon"
          mono
          optional
          value={icon}
          onChange={set("icon")}
          help="An https:// link to a square, single-colour SVG."
          placeholder="https://example.com/icon.svg"
        />
        <ColorField color={color} onChange={set("color")} />
      </div>
      <FieldShell label="Runs on" path="platforms">
        <div className="flex gap-6">
          {(["amd64", "arm64"] as const).map((platform) => (
            <label
              key={platform}
              className="type-support flex items-center gap-2"
            >
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={platforms?.includes(platform) ?? false}
                onChange={(event) => onPlatform(platform, event.target.checked)}
              />
              <code className="type-code">{platform}</code>
            </label>
          ))}
          <span className="type-meta self-center text-muted-foreground">
            {platforms?.length ? null : "Leave both off for any"}
          </span>
        </div>
      </FieldShell>
      <Subheading>Links</Subheading>
      <div className="grid gap-4 sm:grid-cols-2">
        {(["homepage", "docs", "source", "support"] as const).map((key) => (
          <TextField
            key={key}
            label={key[0]!.toUpperCase() + key.slice(1)}
            path={`links.${key}`}
            mono
            optional
            value={links?.[key]}
            onChange={set("links", key)}
            placeholder="https://"
          />
        ))}
      </div>
    </SectionCard>
  )
})

function TagsField({
  onChange,
  tags,
}: {
  onChange: (tags: Array<string> | undefined) => void
  tags: ReadonlyArray<string> | undefined
}) {
  const id = React.useId()
  const parse = (text: string) =>
    text
      .split(/[,\s]+/u)
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean)
  const [text, setText] = useSyncedText((tags ?? []).join(", "), (current) =>
    parse(current).join(", ")
  )
  const issue = useIssue("tags")
  return (
    <FieldShell
      label="Tags"
      htmlFor={id}
      path="tags"
      help="Comma-separated, for search."
    >
      <Input
        id={id}
        value={text}
        placeholder="minecraft, java"
        aria-invalid={issue ? true : undefined}
        onChange={(event) => {
          setText(event.target.value)
          const next = parse(event.target.value)
          onChange(next.length > 0 ? next : undefined)
        }}
      />
    </FieldShell>
  )
}

function ColorField({
  color,
  onChange,
}: {
  color: string | undefined
  onChange: (color: string | undefined) => void
}) {
  const id = React.useId()
  const issue = useIssue("color")
  return (
    <FieldShell label="Color" htmlFor={id} path="color">
      <div className="flex gap-2">
        <input
          type="color"
          aria-label="Pick a color"
          value={/^#[\da-f]{6}$/iu.test(color ?? "") ? color : "#888888"}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 w-10 shrink-0 cursor-pointer border border-input bg-transparent p-0.5"
        />
        <Input
          id={id}
          value={color ?? ""}
          placeholder="Automatic"
          aria-invalid={issue ? true : undefined}
          className="font-mono text-sm"
          onChange={(event) => onChange(event.target.value || undefined)}
        />
      </div>
    </FieldShell>
  )
}

const inputTypes: ReadonlyArray<{ label: string; value: BrickV2InputType }> = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Toggle" },
  { value: "select", label: "Choice" },
  { value: "secret", label: "Secret" },
]

export const InputsSection = React.memo(function InputsSection({
  edit,
  inputs,
}: {
  edit: Edit
  inputs: ReadonlyArray<BrickV2Input> | undefined
}) {
  const list = inputs ?? []
  const keys = list.map((input) => input.key).join(",")
  const add = () =>
    edit((brick) => {
      const taken = new Set((brick.inputs ?? []).map((input) => input.key))
      let index = (brick.inputs?.length ?? 0) + 1
      while (taken.has(`input_${index}`)) index += 1
      return {
        ...brick,
        inputs: [
          ...(brick.inputs ?? []),
          { key: `input_${index}`, label: "", type: "text" },
        ],
      }
    })
  return (
    <SectionCard
      id="inputs"
      title="Inputs"
      description="The install form. Each answer can be used anywhere as {{ key }}."
      actions={
        <Button variant="outline" size="sm" onClick={add}>
          <Plus />
          Add input
        </Button>
      }
    >
      {list.length === 0 ? (
        <p className="type-support text-muted-foreground">
          No inputs. Installing it asks only for a name.
        </p>
      ) : (
        <ol className="flex flex-col gap-4">
          {list.map((input, index) => (
            <InputEditor
              key={index}
              count={list.length}
              edit={edit}
              index={index}
              input={input}
              keys={keys}
            />
          ))}
        </ol>
      )}
    </SectionCard>
  )
})

function changeInputType(
  input: BrickV2Input,
  type: BrickV2InputType
): BrickV2Input {
  const {
    default: value,
    generate,
    max,
    min,
    options,
    pattern,
    placeholder,
    ...rest
  } = input
  const fits =
    type === "number"
      ? typeof value === "number"
      : type === "boolean"
        ? typeof value === "boolean"
        : type === "select"
          ? false
          : typeof value === "string"
  const textual = type === "text" || type === "secret"
  return {
    ...rest,
    type,
    ...(fits ? { default: value } : {}),
    ...(textual || type === "number" ? { max, min, placeholder } : {}),
    ...(textual ? { pattern } : {}),
    ...(type === "secret" ? { generate } : {}),
    ...(type === "select" ? { options: options ?? ["one", "two"] } : {}),
  }
}

const InputEditor = React.memo(function InputEditor({
  count,
  edit,
  index,
  input,
  keys,
}: {
  count: number
  edit: Edit
  index: number
  input: BrickV2Input
  keys: string
}) {
  const set = useSetter(edit)
  const base = `inputs.${index}`
  const otherKeys = keys.split(",").filter((key) => key && key !== input.key)
  const move = (offset: number) =>
    edit((brick) => {
      const next = [...(brick.inputs ?? [])]
      const [moved] = next.splice(index, 1)
      next.splice(index + offset, 0, moved!)
      return { ...brick, inputs: next }
    })
  const remove = () =>
    edit((brick) => ({
      ...brick,
      inputs: (brick.inputs ?? []).filter((_, other) => other !== index),
    }))
  const update = (next: BrickV2Input) =>
    edit((brick) => setIn(brick, ["inputs", index], next))
  const textual = input.type === "text" || input.type === "secret"

  return (
    <li className="border border-border">
      <details open className="group">
        <summary className="flex cursor-pointer list-none items-center gap-3 bg-card/50 px-4 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/60 [&::-webkit-details-marker]:hidden">
          <code className="type-code text-primary-ink">
            {input.key || "untitled"}
          </code>
          <span className="type-support truncate text-muted-foreground">
            {input.label || "No label"}
          </span>
          <span className="type-label ml-auto border border-border px-1.5 text-muted-foreground">
            {inputTypes.find((type) => type.value === input.type)?.label}
          </span>
        </summary>
        <div className="flex flex-col gap-4 p-4">
          <div className="grid gap-4 sm:grid-cols-[10rem_minmax(0,1fr)_9rem]">
            <TextField
              label="Key"
              mono
              path={`${base}.key`}
              value={input.key}
              onChange={set("inputs", index, "key")}
            />
            <TextField
              label="Label"
              path={`${base}.label`}
              value={input.label}
              onChange={set("inputs", index, "label")}
            />
            <SelectField
              label="Type"
              path={`${base}.type`}
              value={input.type}
              options={inputTypes}
              onChange={(type) => update(changeInputType(input, type))}
            />
          </div>
          <TextField
            label="Help"
            optional
            path={`${base}.help`}
            value={input.help}
            onChange={set("inputs", index, "help")}
            placeholder="A line under the field"
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <DefaultField index={index} input={input} edit={edit} />
            {input.type === "boolean" || input.type === "select" ? null : (
              <TextField
                label="Placeholder"
                optional
                path={`${base}.placeholder`}
                value={input.placeholder}
                onChange={set("inputs", index, "placeholder")}
              />
            )}
          </div>
          {input.type === "select" ? (
            <OptionsField
              options={input.options}
              path={`${base}.options`}
              onChange={set("inputs", index, "options")}
            />
          ) : null}
          {textual ? (
            <TextField
              label="Pattern"
              optional
              mono
              path={`${base}.pattern`}
              value={input.pattern}
              onChange={set("inputs", index, "pattern")}
              help="A regular expression the answer must match."
              placeholder="^[a-z0-9-]+$"
            />
          ) : null}
          {textual || input.type === "number" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField
                label={textual ? "Shortest" : "Lowest"}
                path={`${base}.min`}
                value={input.min}
                onChange={set("inputs", index, "min")}
              />
              <NumberField
                label={textual ? "Longest" : "Highest"}
                path={`${base}.max`}
                value={input.max}
                onChange={set("inputs", index, "max")}
              />
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-3">
            <SwitchField
              label="Optional"
              checked={input.optional === true}
              onChange={(on) =>
                set("inputs", index, "optional")(on ? true : undefined)
              }
            />
            <SwitchField
              label="Advanced"
              help="Folded away"
              checked={input.advanced === true}
              onChange={(on) =>
                set("inputs", index, "advanced")(on ? true : undefined)
              }
            />
            {input.type === "secret" ? (
              <SwitchField
                label="Generate"
                help="Kiln makes one"
                checked={input.generate === true}
                onChange={(on) =>
                  update(
                    on
                      ? { ...input, generate: true, default: undefined }
                      : { ...input, generate: undefined }
                  )
                }
              />
            ) : null}
          </div>
          <Suggestions
            edit={edit}
            index={index}
            input={input}
            otherKeys={otherKeys}
          />
          <div className="flex flex-wrap justify-end gap-1 border-t border-border pt-3">
            <Button
              variant="ghost"
              size="sm"
              disabled={index === 0}
              onClick={() => move(-1)}
            >
              <ArrowUp />
              Up
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={index === count - 1}
              onClick={() => move(1)}
            >
              <ArrowDown />
              Down
            </Button>
            <Button variant="destructive" size="sm" onClick={remove}>
              <Trash2 />
              Remove
            </Button>
          </div>
        </div>
      </details>
    </li>
  )
})

function DefaultField({
  edit,
  index,
  input,
}: {
  edit: Edit
  index: number
  input: BrickV2Input
}) {
  const set = useSetter(edit)
  const path = `inputs.${index}.default`
  const onDefault = set("inputs", index, "default") as (value: unknown) => void
  if (input.type === "boolean") {
    return (
      <SwitchField
        label="On by default"
        checked={input.default === true}
        onChange={onDefault}
      />
    )
  }
  if (input.type === "number") {
    return (
      <NumberField
        label="Default"
        path={path}
        value={typeof input.default === "number" ? input.default : undefined}
        onChange={onDefault}
      />
    )
  }
  if (input.type === "select") {
    const none = "\u0000none"
    return (
      <SelectField
        label="Default"
        path={path}
        value={input.default === undefined ? none : String(input.default)}
        options={[
          { value: none, label: "None" },
          ...(input.options ?? []).map((option) => ({
            value: String(brickV2OptionValue(option)),
            label: brickV2OptionLabel(option),
          })),
        ]}
        onChange={(next) => {
          const option = input.options?.find(
            (candidate) => String(brickV2OptionValue(candidate)) === next
          )
          onDefault(
            option === undefined ? undefined : brickV2OptionValue(option)
          )
        }}
      />
    )
  }
  if (input.type === "secret" && input.generate) {
    return (
      <FieldShell label="Default">
        <p className="type-support flex h-8 items-center text-muted-foreground">
          Generated at install
        </p>
      </FieldShell>
    )
  }
  return (
    <TextField
      label="Default"
      mono
      optional
      path={path}
      value={typeof input.default === "string" ? input.default : undefined}
      onChange={onDefault}
    />
  )
}

function OptionsField({
  onChange,
  options,
  path,
}: {
  onChange: (options: Array<BrickV2Option> | undefined) => void
  options: ReadonlyArray<BrickV2Option> | undefined
  path: string
}) {
  const id = React.useId()
  const write = (list: ReadonlyArray<BrickV2Option>) =>
    list
      .map((option) =>
        typeof option === "object"
          ? `${option.value} | ${option.label}`
          : String(option)
      )
      .join("\n")
  const read = (text: string): Array<BrickV2Option> =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [value, ...label] = line.split("|")
        const written = label.join("|").trim()
        return written
          ? { value: value!.trim(), label: written }
          : value!.trim()
      })
  const [text, setText] = useSyncedText(write(options ?? []), (current) =>
    write(read(current))
  )
  const issue = useIssue(path)
  return (
    <FieldShell
      label="Options"
      htmlFor={id}
      path={path}
      help="One per line. Add a label after a bar: 21 | Java 21"
    >
      <Textarea
        id={id}
        rows={4}
        value={text}
        spellCheck={false}
        aria-invalid={issue ? true : undefined}
        className="min-h-0 font-mono text-sm"
        onChange={(event) => {
          setText(event.target.value)
          const next = read(event.target.value)
          onChange(next.length > 0 ? next : undefined)
        }}
      />
    </FieldShell>
  )
}

function Suggestions({
  edit,
  index,
  input,
  otherKeys,
}: {
  edit: Edit
  index: number
  input: BrickV2Input
  otherKeys: ReadonlyArray<string>
}) {
  const set = useSetter(edit)
  const rules = input.suggest ?? []
  const add = () =>
    set(
      "inputs",
      index,
      "suggest"
    )([
      ...rules,
      {
        when: otherKeys[0] ?? "",
        matches: "",
        value:
          input.type === "number" ? 0 : input.type === "boolean" ? true : "",
      },
    ])
  const remove = (ruleIndex: number) =>
    set(
      "inputs",
      index,
      "suggest"
    )(rules.filter((_, other) => other !== ruleIndex))
  if (otherKeys.length === 0 && rules.length === 0) return null
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="type-label">Suggested defaults</p>
          <p className="type-meta text-muted-foreground">
            When another answer matches, start this one at a different value.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={add}
          disabled={otherKeys.length === 0}
        >
          <Plus />
          Add rule
        </Button>
      </div>
      {rules.map((rule, ruleIndex) => (
        <div
          key={ruleIndex}
          className="grid items-end gap-2 sm:grid-cols-[9rem_minmax(0,1fr)_7rem_auto]"
        >
          <SelectField
            label="When"
            path={`inputs.${index}.suggest.${ruleIndex}.when`}
            value={rule.when}
            options={[...new Set([...otherKeys, rule.when])]
              .filter(Boolean)
              .map((key) => ({ value: key, label: key }))}
            onChange={set("inputs", index, "suggest", ruleIndex, "when")}
          />
          <TextField
            label="Matches"
            mono
            path={`inputs.${index}.suggest.${ruleIndex}.matches`}
            value={rule.matches}
            onChange={(value) =>
              set("inputs", index, "suggest", ruleIndex, "matches")(value ?? "")
            }
            placeholder="^1\.21"
          />
          <TextField
            label="Use"
            mono
            path={`inputs.${index}.suggest.${ruleIndex}.value`}
            value={String(rule.value)}
            onChange={(value) =>
              set(
                "inputs",
                index,
                "suggest",
                ruleIndex,
                "value"
              )(
                input.type === "number"
                  ? Number(value ?? 0)
                  : input.type === "boolean"
                    ? value === "true"
                    : (value ?? "")
              )
            }
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Remove rule"
            onClick={() => remove(ruleIndex)}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
    </div>
  )
}

const deployTypes: ReadonlyArray<BrickV2DeployType> = [
  "image",
  "dockerfile",
  "compose",
  "static",
]

export const DeploySection = React.memo(function DeploySection({
  deploy,
  edit,
  inputKeys,
  kind,
}: {
  deploy: BrickV2Deploy
  edit: Edit
  inputKeys: string
  kind: BrickV2Kind
}) {
  const set = useSetter(edit)
  const onType = (type: BrickV2DeployType) =>
    edit((brick) => ({ ...brick, deploy: convertDeploy(brick.deploy, type) }))
  const container = deploy.type === "image" || deploy.type === "dockerfile"

  return (
    <SectionCard
      id="deploy"
      title="Deploy"
      description="How Kiln runs it. Text fields take {{ templates }}."
    >
      <FieldShell label="Runs as" path="deploy.type">
        <Segmented
          label="Runs as"
          value={deploy.type}
          onChange={onType}
          options={deployTypes.map((type) => ({
            value: type,
            label: brickDeployLabels[type],
            disabled: !deployAllowed(kind, type),
          }))}
        />
      </FieldShell>
      <TemplateNames inputKeys={inputKeys} />

      {deploy.type === "image" ? (
        <TextField
          label="Image"
          mono
          path="deploy.image"
          value={deploy.image}
          onChange={(value) => set("deploy", "image")(value ?? "")}
          placeholder="ghcr.io/owner/image:{{ version }}"
          help="Pin a tag. Templates let an answer pick it."
        />
      ) : null}
      {deploy.type === "dockerfile" ? (
        <SourceFile
          edit={edit}
          file="dockerfile"
          fileLabel="Dockerfile"
          inline={deploy.dockerfile}
          path={deploy.path}
          placeholder={
            'FROM node:24-alpine\nCOPY . /app\nCMD ["node", "/app/server.js"]'
          }
          repositoryDefault="Dockerfile"
        >
          {deploy.path !== undefined ? (
            <TextField
              label="Build context"
              mono
              optional
              path="deploy.context"
              value={deploy.context}
              onChange={set("deploy", "context")}
              placeholder="."
              help="The folder the build sees, from the repository's root."
            />
          ) : null}
        </SourceFile>
      ) : null}
      {deploy.type === "compose" ? (
        <SourceFile
          edit={edit}
          file="compose"
          fileLabel="Compose file"
          inline={deploy.compose}
          path={deploy.path}
          placeholder={"services:\n  web:\n    image: nginx:1.29"}
          repositoryDefault="compose.yaml"
        >
          <TextField
            label="Main service"
            mono
            optional
            path="deploy.service"
            value={deploy.service}
            onChange={set("deploy", "service")}
            help="The one whose console and logs Hearth opens first."
          />
        </SourceFile>
      ) : null}
      {deploy.type === "static" ? (
        <>
          <TextField
            label="Folder to serve"
            mono
            optional
            path="deploy.root"
            value={deploy.root}
            onChange={set("deploy", "root")}
            placeholder="."
            help="Relative to the source, after the build."
          />
          <div className="grid gap-4 sm:grid-cols-[14rem_minmax(0,1fr)]">
            <TextField
              label="Build image"
              mono
              optional
              path="deploy.build.image"
              value={deploy.build?.image}
              onChange={(value) =>
                edit((brick) =>
                  setIn(
                    brick,
                    ["deploy", "build"],
                    value === undefined && !deploy.build?.command
                      ? undefined
                      : { command: "", ...deploy.build, image: value ?? "" }
                  )
                )
              }
              placeholder="node:24-alpine"
            />
            <TextField
              label="Build command"
              mono
              optional
              path="deploy.build.command"
              value={deploy.build?.command}
              onChange={(value) =>
                edit((brick) =>
                  setIn(
                    brick,
                    ["deploy", "build"],
                    value === undefined && !deploy.build?.image
                      ? undefined
                      : { image: "", ...deploy.build, command: value ?? "" }
                  )
                )
              }
              placeholder="npm ci && npm run build"
              help="Skipped when it's empty."
            />
          </div>
          <SwitchField
            label="Single-page app"
            help="Answer unknown paths with index.html."
            checked={deploy.spa === true}
            onChange={(on) => set("deploy", "spa")(on ? true : undefined)}
          />
          <PairsField
            label="Headers"
            path="deploy.headers"
            separator=": "
            value={deploy.headers}
            onChange={set("deploy", "headers")}
            placeholder="Cache-Control: public, max-age=3600"
          />
        </>
      ) : null}

      {deploy.type !== "static" ? (
        <>
          <Subheading>Environment</Subheading>
          <PairsField
            label="Variables"
            path="deploy.env"
            separator="="
            value={deploy.env}
            onChange={set("deploy", "env")}
            placeholder={"VERSION={{ version }}\nTZ=UTC"}
            help={
              deploy.type === "compose"
                ? "Written to the project's .env."
                : "One KEY=value per line."
            }
          />
          <PortsField
            edit={edit}
            kind={kind}
            compose={deploy.type === "compose"}
            ports={deploy.ports}
          />
        </>
      ) : null}

      {container ? (
        <>
          <VolumesField edit={edit} volumes={deploy.volumes} />
          <FilesField edit={edit} files={deploy.files} />
          <Subheading>Process</Subheading>
          <div className="grid gap-4 sm:grid-cols-2">
            <LinesField
              label="Command"
              path="deploy.command"
              value={deploy.command}
              onChange={set("deploy", "command")}
              help="One argument per line. Replaces the image's."
              placeholder={"redis-server\n--appendonly\nyes"}
            />
            <LinesField
              label="Entrypoint"
              path="deploy.entrypoint"
              value={deploy.entrypoint}
              onChange={set("deploy", "entrypoint")}
              help="One argument per line."
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField
              label="User"
              mono
              optional
              path="deploy.user"
              value={deploy.user}
              onChange={set("deploy", "user")}
              placeholder="1000:1000"
            />
            <TextField
              label="Working folder"
              mono
              optional
              path="deploy.workdir"
              value={deploy.workdir}
              onChange={set("deploy", "workdir")}
              placeholder="/app"
            />
            <TextField
              label="Stop signal"
              mono
              optional
              path="deploy.stopSignal"
              value={deploy.stopSignal}
              onChange={set("deploy", "stopSignal")}
              placeholder="SIGTERM"
            />
          </div>
        </>
      ) : null}

      {deploy.type !== "static" ? (
        <>
          <ReadyField
            edit={edit}
            ready={deploy.ready}
            portNames={(deploy.ports ?? []).map((port) => port.name)}
          />
          <Subheading>Starting resources</Subheading>
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField
              label="Memory"
              mono
              optional
              path="deploy.resources.memory"
              value={deploy.resources?.memory}
              onChange={set("deploy", "resources", "memory")}
              placeholder="2G"
              help="A suggestion. Hearth's limit wins."
            />
            <NumberField
              label="CPUs"
              path="deploy.resources.cpu"
              value={deploy.resources?.cpu}
              onChange={set("deploy", "resources", "cpu")}
            />
            <NumberField
              label="Processes"
              path="deploy.resources.pids"
              value={deploy.resources?.pids}
              onChange={set("deploy", "resources", "pids")}
              placeholder="512"
            />
          </div>
        </>
      ) : null}
    </SectionCard>
  )
})

function TemplateNames({ inputKeys }: { inputKeys: string }) {
  const names = [
    ...inputKeys.split(",").filter(Boolean),
    ...Object.keys(brickV2Builtins),
  ]
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="type-meta mr-1 text-muted-foreground">Templates</span>
      {names.map((name) => (
        <code
          key={name}
          title={
            name in brickV2Builtins
              ? brickV2Builtins[name as keyof typeof brickV2Builtins]
              : `The ${name} input's answer`
          }
          className="type-code border border-border bg-card/60 px-1.5 text-[0.75rem] text-muted-foreground"
        >
          {`{{ ${name} }}`}
        </code>
      ))}
    </div>
  )
}

function SourceFile({
  children,
  edit,
  file,
  fileLabel,
  inline,
  path,
  placeholder,
  repositoryDefault,
}: {
  children?: React.ReactNode
  edit: Edit
  file: "dockerfile" | "compose"
  fileLabel: string
  inline: string | undefined
  path: string | undefined
  placeholder: string
  repositoryDefault: string
}) {
  const fromRepository = inline === undefined
  const choose = (next: "repository" | "inline") =>
    edit((brick) => {
      const deploy = { ...brick.deploy } as Record<string, unknown>
      if (next === "repository") {
        delete deploy[file]
        delete deploy.context
        deploy.path = path ?? repositoryDefault
      } else {
        delete deploy.path
        delete deploy.context
        deploy[file] = inline ?? ""
      }
      return { ...brick, deploy: deploy as BrickV2Deploy }
    })
  const id = React.useId()
  return (
    <>
      <FieldShell
        label={`Where the ${fileLabel} is`}
        help={
          fromRepository
            ? "Installing it asks for a Git repository."
            : "Written here, so installing it needs no repository."
        }
      >
        <Segmented
          label={`Where the ${fileLabel} is`}
          value={fromRepository ? "repository" : "inline"}
          onChange={choose}
          options={[
            { value: "repository", label: "In the repository" },
            { value: "inline", label: "In this Brick" },
          ]}
        />
      </FieldShell>
      {fromRepository ? (
        <TextField
          label="Path"
          mono
          path="deploy.path"
          value={path}
          onChange={(value) =>
            edit((brick) => setIn(brick, ["deploy", "path"], value ?? ""))
          }
          placeholder={repositoryDefault}
        />
      ) : (
        <FieldShell label={fileLabel} htmlFor={id} path={`deploy.${file}`}>
          <Textarea
            id={id}
            rows={8}
            spellCheck={false}
            value={inline}
            placeholder={placeholder}
            className="min-h-0 font-mono text-sm"
            onChange={(event) =>
              edit((brick) =>
                setIn(brick, ["deploy", file], event.target.value)
              )
            }
          />
        </FieldShell>
      )}
      {children}
    </>
  )
}

// A string record edited as lines of key and value.
function PairsField({
  help,
  label,
  onChange,
  path,
  placeholder,
  separator,
  value,
}: {
  help?: string
  label: string
  onChange: (value: Record<string, string> | undefined) => void
  path: string
  placeholder?: string
  separator: "=" | ": "
  value: Readonly<Record<string, string>> | undefined
}) {
  const id = React.useId()
  const split = separator.trim()
  const write = (record: Readonly<Record<string, string>>) =>
    Object.entries(record)
      .map(([key, entry]) => `${key}${separator}${entry}`)
      .join("\n")
  const read = (text: string): Record<string, string> => {
    const record: Record<string, string> = {}
    for (const line of text.split("\n")) {
      if (!line.trim() || line.trimStart().startsWith("#")) continue
      const at = line.indexOf(split)
      const key = (at === -1 ? line : line.slice(0, at)).trim()
      if (!key) continue
      record[key] = at === -1 ? "" : line.slice(at + split.length).trim()
    }
    return record
  }
  const [text, setText] = useSyncedText(write(value ?? {}), (current) =>
    write(read(current))
  )
  const issue = useIssue(path)
  return (
    <FieldShell label={label} htmlFor={id} path={path} help={help}>
      <Textarea
        id={id}
        rows={Math.min(Math.max(text.split("\n").length, 3), 14)}
        value={text}
        spellCheck={false}
        placeholder={placeholder}
        aria-invalid={issue ? true : undefined}
        className="min-h-0 font-mono text-sm"
        onChange={(event) => {
          setText(event.target.value)
          const next = read(event.target.value)
          onChange(Object.keys(next).length > 0 ? next : undefined)
        }}
      />
    </FieldShell>
  )
}

function PortsField({
  compose,
  edit,
  kind,
  ports,
}: {
  compose: boolean
  edit: Edit
  kind: BrickV2Kind
  ports: ReadonlyArray<BrickV2Port> | undefined
}) {
  const set = useSetter(edit)
  const list = ports ?? []
  const add = () =>
    set(
      "deploy",
      "ports"
    )([
      ...list,
      {
        name: list.length === 0 ? "web" : `port-${list.length + 1}`,
        port: 8080,
      },
    ])
  const remove = (index: number) =>
    set("deploy", "ports")(list.filter((_, other) => other !== index))
  const defaultExposure = brickV2PortExposure(kind, { name: "x", port: 1 })
  const exposureLabel = {
    public: "Public port",
    http: "HTTPS domain",
    private: "Private",
  }
  return (
    <>
      <Subheading
        actions={
          <Button variant="ghost" size="sm" onClick={add}>
            <Plus />
            Add port
          </Button>
        }
      >
        Ports
      </Subheading>
      {list.length === 0 ? (
        <p
          className="type-support text-muted-foreground"
          id="brick-field-deploy-ports"
        >
          No ports. The first one you add is the one Hearth shows.
        </p>
      ) : null}
      {list.map((port, index) => (
        <div
          key={index}
          className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_6rem_6.5rem_9.5rem_auto]"
        >
          <TextField
            label={index === 0 ? "Name (primary)" : "Name"}
            mono
            path={`deploy.ports.${index}.name`}
            value={port.name}
            onChange={(value) =>
              set("deploy", "ports", index, "name")(value ?? "")
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
            value={port.expose ?? "default"}
            options={[
              {
                value: "default",
                label: `${exposureLabel[defaultExposure]} (default)`,
              },
              { value: "public", label: "Public port" },
              { value: "http", label: "HTTPS domain" },
              { value: "private", label: "Private" },
            ]}
            onChange={(value) =>
              set(
                "deploy",
                "ports",
                index,
                "expose"
              )(value === "default" ? undefined : value)
            }
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove ${port.name || "port"}`}
            onClick={() => remove(index)}
          >
            <Trash2 />
          </Button>
          {compose ? (
            <TextField
              className="sm:col-span-2"
              label="Service"
              mono
              optional
              path={`deploy.ports.${index}.service`}
              value={port.service}
              onChange={set("deploy", "ports", index, "service")}
            />
          ) : null}
        </div>
      ))}
    </>
  )
}

function VolumesField({
  edit,
  volumes,
}: {
  edit: Edit
  volumes: ReadonlyArray<{ name?: string; path: string }> | undefined
}) {
  const set = useSetter(edit)
  const list = volumes ?? []
  return (
    <>
      <Subheading
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              set("deploy", "volumes")([...list, { path: "/data" }])
            }
          >
            <Plus />
            Add volume
          </Button>
        }
      >
        Kept across restarts
      </Subheading>
      {list.length === 0 ? (
        <p className="type-support text-muted-foreground">
          Nothing is kept: every deploy starts clean.
        </p>
      ) : null}
      {list.map((volume, index) => (
        <div
          key={index}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2"
        >
          <TextField
            label={index === 0 ? "Folder (shown in Files)" : "Folder"}
            mono
            path={`deploy.volumes.${index}.path`}
            value={volume.path}
            onChange={(value) =>
              set("deploy", "volumes", index, "path")(value ?? "")
            }
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Remove volume"
            onClick={() =>
              set(
                "deploy",
                "volumes"
              )(list.filter((_, other) => other !== index))
            }
          >
            <Trash2 />
          </Button>
        </div>
      ))}
    </>
  )
}

function FilesField({
  edit,
  files,
}: {
  edit: Edit
  files:
    | ReadonlyArray<{ content: string; once?: boolean; path: string }>
    | undefined
}) {
  const set = useSetter(edit)
  const list = files ?? []
  return (
    <>
      <Subheading
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              set(
                "deploy",
                "files"
              )([...list, { path: "/data/config.txt", content: "" }])
            }
          >
            <Plus />
            Add file
          </Button>
        }
      >
        Files written before it starts
      </Subheading>
      {list.map((file, index) => (
        <div
          key={index}
          className="flex flex-col gap-2 border border-border p-3"
        >
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
            <TextField
              label="Path"
              mono
              path={`deploy.files.${index}.path`}
              value={file.path}
              onChange={(value) =>
                set("deploy", "files", index, "path")(value ?? "")
              }
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Remove file"
              onClick={() =>
                set(
                  "deploy",
                  "files"
                )(list.filter((_, other) => other !== index))
              }
            >
              <Trash2 />
            </Button>
          </div>
          <FieldShell label="Content" path={`deploy.files.${index}.content`}>
            <Textarea
              rows={3}
              spellCheck={false}
              value={file.content}
              className="min-h-0 font-mono text-sm"
              onChange={(event) =>
                set("deploy", "files", index, "content")(event.target.value)
              }
            />
          </FieldShell>
          <SwitchField
            label="Write once"
            help="Keep later edits instead of rewriting it on every start."
            checked={file.once === true}
            onChange={(on) =>
              set("deploy", "files", index, "once")(on ? true : undefined)
            }
          />
        </div>
      ))}
    </>
  )
}

function ReadyField({
  edit,
  portNames,
  ready,
}: {
  edit: Edit
  portNames: ReadonlyArray<string>
  ready: BrickV2Ready | undefined
}) {
  const set = useSetter(edit)
  const onType = (type: "none" | BrickV2Ready["type"]) =>
    set(
      "deploy",
      "ready"
    )(
      type === "none"
        ? undefined
        : type === "log"
          ? { type, match: ready?.type === "log" ? ready.match : ["Done"] }
          : type === "command"
            ? { type, command: ready?.type === "command" ? ready.command : "" }
            : { type, path: ready?.type === "http" ? ready.path : "/" }
    )
  return (
    <>
      <Subheading>Ready when</Subheading>
      <Segmented
        label="Ready when"
        value={ready?.type ?? "none"}
        onChange={onType}
        options={[
          { value: "none", label: "It starts" },
          { value: "log", label: "A log line" },
          { value: "command", label: "A command" },
          { value: "http", label: "An HTTP check" },
        ]}
      />
      {ready?.type === "log" ? (
        <LinesField
          label="Log lines"
          path="deploy.ready.match"
          value={ready.match}
          onChange={(value) => set("deploy", "ready", "match")(value ?? [])}
          help="Ready once the log shows any of these, one per line."
          rows={2}
        />
      ) : null}
      {ready?.type === "command" ? (
        <TextField
          label="Command"
          mono
          path="deploy.ready.command"
          value={ready.command}
          onChange={(value) => set("deploy", "ready", "command")(value ?? "")}
          help="Runs in the container until it succeeds."
          placeholder="pg_isready -h 127.0.0.1"
        />
      ) : null}
      {ready?.type === "http" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Path"
            mono
            path="deploy.ready.path"
            value={ready.path}
            onChange={(value) => set("deploy", "ready", "path")(value ?? "/")}
          />
          <SelectField
            label="Port"
            path="deploy.ready.port"
            value={ready.port ?? "\u0000primary"}
            options={[
              { value: "\u0000primary", label: "The primary port" },
              ...portNames.map((name) => ({ value: name, label: name })),
            ]}
            onChange={(value) =>
              set(
                "deploy",
                "ready",
                "port"
              )(value === "\u0000primary" ? undefined : value)
            }
          />
        </div>
      ) : null}
    </>
  )
}

export const GameSection = React.memo(function GameSection({
  edit,
  game,
}: {
  edit: Edit
  game: BrickV2Game | undefined
}) {
  const set = useSetter(edit)
  return (
    <SectionCard
      id="kind"
      title="Game"
      description="How players reach it, and how it stops on purpose."
    >
      <TextField
        label="Game"
        path="game.title"
        value={game?.title}
        onChange={(value) => set("game", "title")(value ?? "")}
        placeholder="Minecraft"
      />
      <FieldShell label="Players connect" path="game.routing">
        <Segmented
          label="Players connect"
          value={game?.routing ?? "direct"}
          onChange={set("game", "routing")}
          options={[
            { value: "minecraft", label: "Minecraft routing" },
            { value: "direct", label: "Directly" },
          ]}
        />
      </FieldShell>
      <TextField
        label="Hostname"
        mono
        optional
        path="game.hostname"
        value={game?.hostname}
        onChange={set("game", "hostname")}
        placeholder="{{ version }}.{{ kiln.brick }}"
        help="The address players see, under the Relay's domain."
      />
      <LinesField
        label="Stop commands"
        path="game.stop"
        value={game?.stop}
        onChange={set("game", "stop")}
        rows={2}
        help="Console commands that stop it on purpose, so Kiln doesn't restart it."
        placeholder={"stop\n/stop"}
      />
    </SectionCard>
  )
})

export const DatabaseSection = React.memo(function DatabaseSection({
  database,
  edit,
  portNames,
}: {
  database: BrickV2Database | undefined
  edit: Edit
  portNames: string
}) {
  const set = useSetter(edit)
  const ports = portNames.split(",").filter(Boolean)
  return (
    <SectionCard
      id="kind"
      title="Database"
      description="How apps connect to it, and how Kiln backs it up."
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          label="Engine"
          mono
          path="database.engine"
          value={database?.engine}
          onChange={(value) => set("database", "engine")(value ?? "")}
          placeholder="postgres"
        />
        <SelectField
          label="Language"
          path="database.language"
          value={database?.language}
          options={[
            { value: "sql", label: "SQL" },
            { value: "redis", label: "Redis" },
            { value: "mongodb", label: "MongoDB" },
            { value: "other", label: "Other" },
          ]}
          onChange={set("database", "language")}
        />
        <SelectField
          label="Port"
          path="database.port"
          value={database?.port}
          options={[...new Set([...ports, database?.port ?? ""])]
            .filter(Boolean)
            .map((name) => ({ value: name, label: name }))}
          onChange={set("database", "port")}
        />
      </div>
      <TextField
        label="Connection"
        mono
        path="database.connection"
        value={database?.connection}
        onChange={(value) => set("database", "connection")(value ?? "")}
        placeholder="postgres://{{ username }}:{{ password }}@{{ kiln.host }}:5432/{{ database }}"
        help="What Hearth hands to apps that connect."
      />
      <SelectField
        label="Viewer"
        value={database?.viewer ?? "none"}
        options={[
          { value: "none", label: "None" },
          { value: "mysql", label: "Hearth's MySQL viewer" },
          { value: "postgres", label: "Hearth's PostgreSQL viewer" },
        ]}
        onChange={(value) =>
          set("database", "viewer")(value === "none" ? undefined : value)
        }
        help="Hearth opens its viewer for official Bricks only."
      />
      <Subheading>Backups</Subheading>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_7rem]">
        <TextField
          label="Backup command"
          mono
          optional
          path="database.backup.command"
          value={database?.backup?.command}
          onChange={(value) =>
            set(
              "database",
              "backup"
            )(
              value === undefined
                ? undefined
                : { extension: "sql", ...database?.backup, command: value }
            )
          }
          help="Writes a dump to stdout. Without one, Kiln snapshots the volume."
        />
        <TextField
          label="Extension"
          mono
          path="database.backup.extension"
          value={database?.backup?.extension}
          onChange={(value) =>
            database?.backup
              ? set("database", "backup", "extension")(value ?? "")
              : undefined
          }
          placeholder="sql"
        />
      </div>
      <TextField
        label="Restore command"
        mono
        optional
        path="database.restore.command"
        value={database?.restore?.command}
        onChange={(value) =>
          set(
            "database",
            "restore"
          )(value === undefined ? undefined : { command: value })
        }
        help="Reads a dump from stdin."
      />
    </SectionCard>
  )
})
