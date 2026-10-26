import * as React from "react"
import { ArrowDown, ArrowUp, Plus, Trash2, Wand2, X } from "lucide-react"

import {
  type BrickV2Input,
  type BrickV2InputType,
  type BrickV2Option,
  brickV2OptionLabel,
  brickV2OptionValue,
} from "@workspace/contracts"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { cn } from "@workspace/ui/lib/utils"

import {
  FieldShell,
  NumberField,
  SelectField,
  SwitchField,
  TextField,
} from "~/components/bricks/creator/creator-fields"
import type { Edit } from "~/components/bricks/creator/creator-edit"
import { setIn } from "~/components/bricks/creator/creator-state"
import {
  inputTypeMeta,
  inputTypes,
  removeInput,
} from "~/components/bricks/creator/inputs-card"
import {
  DialogGroup,
  PanelDialog,
} from "~/components/bricks/creator/panel-dialog"

function keyFor(label: string): string {
  const key = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 48)
  return /^[a-z]/u.test(key) ? key : key ? `input_${key}`.slice(0, 48) : ""
}

// Changes an input's type, keeping what still fits.
function changeType(input: BrickV2Input, type: BrickV2InputType): BrickV2Input {
  const {
    default: value,
    generate,
    max,
    min,
    options,
    pattern,
    placeholder,
    suggest,
    ...rest
  } = input
  const fits =
    type === "number"
      ? typeof value === "number"
      : type === "boolean"
        ? typeof value === "boolean"
        : type !== "select" && typeof value === "string"
  const textual = type === "text" || type === "secret"
  return {
    ...rest,
    type,
    ...(fits ? { default: value } : {}),
    ...(textual || type === "number" ? { max, min, placeholder } : {}),
    ...(textual ? { pattern } : {}),
    ...(type === "secret" ? { generate: generate ?? true } : {}),
    ...(type === "select" ? { options: options ?? ["one", "two"] } : {}),
    ...(type === input.type ? { suggest } : {}),
  }
}

// Everything about one question in the install form.
export function InputDialog({
  edit,
  index,
  input,
  keys,
  onClose,
  onMove,
}: {
  edit: Edit
  index: number
  input: BrickV2Input | undefined
  keys: ReadonlyArray<string>
  onClose: () => void
  // Moves the question and follows it, so the dialog keeps editing it.
  onMove: (offset: number) => void
}) {
  if (!input) return null
  // The key follows the label until it's given one of its own.
  const keyFollows = !input.label || input.key === keyFor(input.label)
  const path = `inputs.${index}`
  const update = (next: BrickV2Input) =>
    edit((brick) => setIn(brick, ["inputs", index], next))
  const patch = (fields: Partial<BrickV2Input>) =>
    update({ ...input, ...fields })
  const textual = input.type === "text" || input.type === "secret"
  const others = keys.filter((key) => key && key !== input.key)
  const Icon = inputTypeMeta[input.type].icon

  return (
    <PanelDialog
      onClose={onClose}
      icon={Icon}
      title={input.label || "New question"}
      description="One field of the install form. Its answer is {{ key }} anywhere in the Brick."
      className="sm:max-w-2xl"
      footer={
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            aria-label="Move up"
            title="Move up"
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            <ArrowUp />
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="Move down"
            title="Move down"
            disabled={index === keys.length - 1}
            onClick={() => onMove(1)}
          >
            <ArrowDown />
          </Button>
          <Button
            variant="destructive"
            className="ml-2"
            onClick={() => {
              removeInput(edit, index)
              onClose()
            }}
          >
            <Trash2 />
            Remove
          </Button>
        </div>
      }
    >
      <div
        role="group"
        aria-label="Type"
        className="grid grid-cols-5 gap-px border border-border bg-border"
      >
        {inputTypes.map((type) => {
          const meta = inputTypeMeta[type]
          return (
            <button
              key={type}
              type="button"
              aria-pressed={input.type === type}
              onClick={() => update(changeType(input, type))}
              className="flex flex-col items-center gap-1 bg-background px-1 py-2.5 text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset aria-pressed:bg-accent aria-pressed:text-foreground"
            >
              <meta.icon className="size-4" />
              <span className="type-label">{meta.label}</span>
            </button>
          )
        })}
      </div>

      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <TextField
          label="Label"
          path={`${path}.label`}
          value={input.label}
          placeholder="Minecraft version"
          onChange={(label) =>
            patch({
              label: label ?? "",
              ...(keyFollows ? { key: keyFor(label ?? "") || input.key } : {}),
            })
          }
        />
        <TextField
          label="Key"
          mono
          path={`${path}.key`}
          value={input.key}
          onChange={(key) => patch({ key: key ?? "" })}
        />
      </div>
      <TextField
        label="Help"
        optional
        path={`${path}.help`}
        value={input.help}
        placeholder="A line under the field"
        onChange={(help) => patch({ help })}
      />

      {input.type === "select" ? (
        <OptionsEditor
          options={input.options ?? []}
          onChange={(options) =>
            patch({ options: options.length > 0 ? options : undefined })
          }
        />
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <DefaultField input={input} path={path} onChange={patch} />
        {input.type === "boolean" || input.type === "select" ? null : (
          <TextField
            label="Placeholder"
            optional
            path={`${path}.placeholder`}
            value={input.placeholder}
            onChange={(placeholder) => patch({ placeholder })}
          />
        )}
      </div>

      <div className="grid gap-3 border border-border bg-card/40 p-3 sm:grid-cols-3">
        <SwitchField
          label="Required"
          help="They must answer"
          checked={input.optional !== true}
          onChange={(on) => patch({ optional: on ? undefined : true })}
        />
        <SwitchField
          label="Advanced"
          help="Folded away"
          checked={input.advanced === true}
          onChange={(on) => patch({ advanced: on ? true : undefined })}
        />
        {input.type === "secret" ? (
          <SwitchField
            label="Generate"
            help="Kiln makes one"
            checked={input.generate === true}
            onChange={(on) =>
              patch(
                on
                  ? { generate: true, default: undefined }
                  : { generate: undefined }
              )
            }
          />
        ) : null}
      </div>

      {textual || input.type === "number" ? (
        <DialogGroup title="Validation">
          <div
            className={cn(
              "grid gap-4",
              textual
                ? "sm:grid-cols-[minmax(0,1fr)_7rem_7rem]"
                : "sm:grid-cols-2"
            )}
          >
            {textual ? (
              <TextField
                label="Pattern"
                mono
                optional
                path={`${path}.pattern`}
                value={input.pattern}
                placeholder="^[a-z0-9-]+$"
                onChange={(pattern) => patch({ pattern })}
              />
            ) : null}
            <NumberField
              label={textual ? "Min length" : "Lowest"}
              path={`${path}.min`}
              value={input.min}
              onChange={(min) => patch({ min })}
            />
            <NumberField
              label={textual ? "Max length" : "Highest"}
              path={`${path}.max`}
              value={input.max}
              onChange={(max) => patch({ max })}
            />
          </div>
        </DialogGroup>
      ) : null}

      {others.length > 0 || input.suggest ? (
        <Suggestions
          input={input}
          others={others}
          path={path}
          onChange={patch}
        />
      ) : null}
    </PanelDialog>
  )
}

function DefaultField({
  input,
  onChange,
  path,
}: {
  input: BrickV2Input
  onChange: (fields: Partial<BrickV2Input>) => void
  path: string
}) {
  const set = (value: BrickV2Input["default"]) => onChange({ default: value })
  if (input.type === "boolean") {
    return (
      <SwitchField
        label="On by default"
        checked={input.default === true}
        onChange={(on) => set(on)}
      />
    )
  }
  if (input.type === "number") {
    return (
      <NumberField
        label="Default"
        path={`${path}.default`}
        value={typeof input.default === "number" ? input.default : undefined}
        onChange={set}
      />
    )
  }
  if (input.type === "select") {
    const none = "\u0000none"
    return (
      <SelectField
        label="Default"
        path={`${path}.default`}
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
          set(option === undefined ? undefined : brickV2OptionValue(option))
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
      path={`${path}.default`}
      value={typeof input.default === "string" ? input.default : undefined}
      onChange={set}
    />
  )
}

function OptionsEditor({
  onChange,
  options,
}: {
  onChange: (options: Array<BrickV2Option>) => void
  options: ReadonlyArray<BrickV2Option>
}) {
  const [draft, setDraft] = React.useState("")
  const add = () => {
    const value = draft.trim()
    if (
      !value ||
      options.some((option) => String(brickV2OptionValue(option)) === value)
    ) {
      return
    }
    onChange([...options, value])
    setDraft("")
  }
  const relabel = (index: number, label: string) =>
    onChange(
      options.map((option, other) => {
        if (other !== index) return option
        const value = brickV2OptionValue(option)
        return label.trim() ? { value, label } : value
      })
    )
  return (
    <DialogGroup title="Options">
      <ul className="flex flex-col gap-1.5">
        {options.map((option, index) => (
          <li
            key={String(brickV2OptionValue(option))}
            className="grid grid-cols-[7rem_minmax(0,1fr)_auto] items-center gap-2"
          >
            <code className="type-code truncate border border-border bg-card/60 px-2 py-1.5">
              {String(brickV2OptionValue(option))}
            </code>
            <Input
              value={typeof option === "object" ? option.label : ""}
              placeholder="Label, if it needs one"
              onChange={(event) => relabel(index, event.target.value)}
              className="h-8 text-sm"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Remove option"
              onClick={() =>
                onChange(options.filter((_, other) => other !== index))
              }
            >
              <X />
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Input
          value={draft}
          placeholder="Add an option"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              add()
            }
          }}
          className="h-8 font-mono text-sm"
        />
        <Button variant="outline" onClick={add} disabled={!draft.trim()}>
          <Plus />
          Add
        </Button>
      </div>
    </DialogGroup>
  )
}

function Suggestions({
  input,
  onChange,
  others,
  path,
}: {
  input: BrickV2Input
  onChange: (fields: Partial<BrickV2Input>) => void
  others: ReadonlyArray<string>
  path: string
}) {
  const rules = input.suggest ?? []
  const write = (next: typeof rules) =>
    onChange({ suggest: next.length > 0 ? next : undefined })
  const valueOf = (text: string) =>
    input.type === "number"
      ? Number(text)
      : input.type === "boolean"
        ? text === "true"
        : text
  return (
    <DialogGroup
      title="Smart defaults"
      action={
        <Button
          variant="ghost"
          size="sm"
          disabled={others.length === 0}
          onClick={() =>
            write([
              ...rules,
              {
                when: others[0] ?? "",
                matches: "",
                value:
                  input.type === "select"
                    ? brickV2OptionValue(input.options?.[0] ?? "")
                    : valueOf(""),
              },
            ])
          }
        >
          <Wand2 />
          Add rule
        </Button>
      }
    >
      {rules.length === 0 ? (
        <p className="type-support text-muted-foreground">
          Start this answer at a different value when another one matches, like
          Java 25 for Minecraft 26.
        </p>
      ) : null}
      {rules.map((rule, ruleIndex) => (
        <div
          key={ruleIndex}
          className="grid items-end gap-2 border border-border bg-card/40 p-2.5 sm:grid-cols-[8.5rem_minmax(0,1fr)_7rem_auto]"
        >
          <SelectField
            label="When"
            path={`${path}.suggest.${ruleIndex}.when`}
            value={rule.when}
            options={[...new Set([...others, rule.when])]
              .filter(Boolean)
              .map((key) => ({ value: key, label: key }))}
            onChange={(when) =>
              write(
                rules.map((entry, other) =>
                  other === ruleIndex ? { ...entry, when } : entry
                )
              )
            }
          />
          <TextField
            label="matches"
            mono
            path={`${path}.suggest.${ruleIndex}.matches`}
            value={rule.matches}
            placeholder="^1\.21"
            onChange={(matches) =>
              write(
                rules.map((entry, other) =>
                  other === ruleIndex
                    ? { ...entry, matches: matches ?? "" }
                    : entry
                )
              )
            }
          />
          <TextField
            label="use"
            mono
            path={`${path}.suggest.${ruleIndex}.value`}
            value={String(rule.value)}
            onChange={(value) =>
              write(
                rules.map((entry, other) =>
                  other === ruleIndex
                    ? { ...entry, value: valueOf(value ?? "") }
                    : entry
                )
              )
            }
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Remove rule"
            onClick={() =>
              write(rules.filter((_, other) => other !== ruleIndex))
            }
          >
            <Trash2 />
          </Button>
        </div>
      ))}
    </DialogGroup>
  )
}
