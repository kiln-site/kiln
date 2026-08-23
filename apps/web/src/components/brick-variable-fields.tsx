import * as React from "react"
import type { BrickVariable, BrickVariableValue } from "@workspace/contracts"

import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Textarea } from "@workspace/ui/components/textarea"

import { usesLongStringBrickField } from "@/lib/brick-variables"

const NOT_SET_SELECT_VALUE = "not-set"
const optionSelectValue = (index: number) => `option:${index}`

export const BrickVariableField = React.memo(function BrickVariableField({
  description,
  name,
  definition,
  value,
  onChange,
}: {
  description?: string
  name: string
  definition: BrickVariable
  value: BrickVariableValue | undefined
  onChange: (value: BrickVariableValue | undefined) => void
}) {
  const labelId = React.useId()
  const fieldDescription = description ?? definition.description

  if (definition.type === "boolean") {
    return (
      <label className="flex cursor-pointer items-center justify-between rounded-lg border border-border/75 bg-background/45 px-3 py-2.5 text-xs">
        <span>
          <span className="block font-medium">{definition.label}</span>
          <span className="mt-0.5 block text-[0.5625rem] leading-4 text-muted-foreground">
            {fieldDescription}
          </span>
        </span>
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
          className="accent-primary"
        />
      </label>
    )
  }

  const selectedOptionIndex = definition.options?.findIndex((option) =>
    Object.is(option, value)
  )
  const selectValue =
    value === undefined
      ? definition.required
        ? ""
        : NOT_SET_SELECT_VALUE
      : selectedOptionIndex !== undefined && selectedOptionIndex >= 0
        ? optionSelectValue(selectedOptionIndex)
        : ""

  return (
    <div className="block space-y-1.5 text-[0.625rem] font-medium text-muted-foreground">
      <span className="flex items-center justify-between gap-2">
        <span id={labelId}>{definition.label}</span>
        <span className="font-mono text-[0.5rem] text-muted-foreground/55">
          {name}
        </span>
      </span>
      {definition.options ? (
        <Select
          value={selectValue}
          onValueChange={(nextValue) => {
            if (nextValue === NOT_SET_SELECT_VALUE && !definition.required) {
              onChange(undefined)
              return
            }
            const optionIndex = definition.options?.findIndex(
              (_, index) => optionSelectValue(index) === nextValue
            )
            const option =
              optionIndex === undefined
                ? undefined
                : definition.options?.[optionIndex]
            if (option !== undefined) onChange(option)
          }}
          required={definition.required}
        >
          <SelectTrigger
            aria-labelledby={labelId}
            aria-required={definition.required}
            className="h-8 w-full overflow-hidden px-3 text-xs [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate"
          >
            <SelectValue placeholder="Select an option" />
          </SelectTrigger>
          <SelectContent className="w-max max-w-(--radix-select-content-available-width) min-w-(--radix-select-trigger-width)">
            {!definition.required ? (
              <SelectItem
                className="whitespace-nowrap"
                value={NOT_SET_SELECT_VALUE}
              >
                Not set
              </SelectItem>
            ) : null}
            {definition.options.map((option, index) => (
              <SelectItem
                key={optionSelectValue(index)}
                className="whitespace-nowrap"
                value={optionSelectValue(index)}
              >
                {String(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : usesLongStringBrickField(definition) ? (
        <Textarea
          aria-labelledby={labelId}
          value={value === undefined ? "" : String(value)}
          onBlur={(event) => onChange(event.currentTarget.value)}
          onChange={(event) => onChange(event.target.value)}
          minLength={definition.rules?.minLength}
          maxLength={definition.rules?.maxLength}
          required={definition.required}
          className="min-h-24 bg-input/18 font-mono text-xs md:text-xs"
        />
      ) : (
        <Input
          aria-labelledby={labelId}
          type={
            definition.sensitive
              ? "password"
              : definition.type === "number"
                ? "number"
                : "text"
          }
          value={value === undefined ? "" : String(value)}
          onBlur={(event) => {
            const next = event.currentTarget.value
            onChange(
              definition.type === "number"
                ? next === ""
                  ? undefined
                  : Number(next)
                : next
            )
          }}
          onChange={(event) => {
            const next = event.target.value
            onChange(
              definition.type === "number"
                ? next === ""
                  ? undefined
                  : Number(next)
                : next
            )
          }}
          pattern={definition.rules?.pattern}
          min={definition.rules?.min}
          max={definition.rules?.max}
          minLength={definition.rules?.minLength}
          maxLength={definition.rules?.maxLength}
          required={definition.required}
        />
      )}
      <span className="block text-[0.5625rem] leading-4 font-normal">
        {fieldDescription}
      </span>
    </div>
  )
})
