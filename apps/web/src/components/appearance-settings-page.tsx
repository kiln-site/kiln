import * as React from "react"
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query"
import { Check, Monitor, Moon, Pencil, Sun } from "lucide-react"

import { ColorPicker } from "@workspace/ui/components/color-picker"
import { Switch } from "@workspace/ui/components/switch"
import { cn } from "@workspace/ui/lib/utils"

import { enqueueAppearancePersistence } from "@/lib/appearance-persistence"
import { defaultAppearance, saveAppearanceCache } from "@/lib/appearance"
import type {
  AppearanceOverride,
  AppearancePreferences,
  ColorScheme,
} from "@/lib/appearance"
import { queryKeys, uiPreferencesQueryOptions } from "@/lib/query-options"
import type { UiPreferences } from "@/lib/query-options"
import { updateAppearancePreferences } from "@/server/preferences"

const persistDelay = 300
const defaultPreset = { color: "#f97316", name: "Orange" } as const
const presets = [
  { color: "#ef4444", name: "Ember" },
  { color: "#f4ff3b", name: "Yellow" },
  { color: "#38bdf8", name: "Blue" },
  { color: "#f5f5f4", name: "White" },
] as const
const customColorSeeds = ["#497dff", "#14b8a6", "#d946ef"] as const
const customColorSlotIndexes = [0, 1, 2]
const emptyPersistQueue = Promise.resolve()

type AppearanceUpdate = AppearanceOverride & {
  defaultForNewUsers?: boolean
}

function selectAppearanceSettingsPreferences(preferences: UiPreferences) {
  return {
    appearance: preferences.appearance,
    canManageAppearanceDefault: preferences.canManageAppearanceDefault,
    customAccentColor: preferences.customAccentColor,
    customColors: preferences.customColors,
  }
}

function fillCustomColorSlots(
  customColors: AppearanceOverride["customColors"]
): AppearanceOverride["customColors"] {
  return [
    customColors[0] ?? null,
    customColors[1] ?? null,
    customColors[2] ?? null,
  ]
}

function useAppearanceSettings() {
  const queryClient = useQueryClient()
  const uiPreferencesOptions = uiPreferencesQueryOptions()
  const { data: uiPreferences } = useSuspenseQuery({
    ...uiPreferencesOptions,
    select: selectAppearanceSettingsPreferences,
  })
  const initialPreferences = queryClient.getQueryData(
    uiPreferencesOptions.queryKey
  )
  const [appearance, setAppearance] = React.useState<AppearancePreferences>(
    uiPreferences.appearance
  )
  const [customAccentColor, setCustomAccentColor] = React.useState<
    string | null
  >(uiPreferences.customAccentColor)
  const [customColors, setCustomColors] = React.useState<
    AppearanceOverride["customColors"]
  >(() => fillCustomColorSlots(uiPreferences.customColors))
  const [activeCustomIndex, setActiveCustomIndex] = React.useState<
    number | null
  >(null)
  const appearanceRef = React.useRef(appearance)
  const customAccentColorRef = React.useRef(customAccentColor)
  const customColorsRef = React.useRef(customColors)
  const defaultForNewUsersRef = React.useRef(
    initialPreferences?.defaultForNewUsers ?? false
  )
  const appearanceDefaultRef = React.useRef(
    initialPreferences?.appearanceDefault ?? defaultAppearance
  )
  const persistTimeout = React.useRef<number | null>(null)
  const pendingUpdate = React.useRef<AppearanceUpdate | null>(null)
  const persistQueue = React.useRef(emptyPersistQueue)

  const persist = React.useCallback((update: AppearanceUpdate) => {
    persistQueue.current = enqueueAppearancePersistence(
      persistQueue.current,
      () => updateAppearancePreferences({ data: update })
    )
  }, [])

  const schedulePersist = React.useCallback(
    (update: AppearanceUpdate) => {
      pendingUpdate.current = update
      if (persistTimeout.current !== null) {
        window.clearTimeout(persistTimeout.current)
      }
      persistTimeout.current = window.setTimeout(() => {
        persistTimeout.current = null
        const pending = pendingUpdate.current
        pendingUpdate.current = null
        if (pending) persist(pending)
      }, persistDelay)
    },
    [persist]
  )

  React.useEffect(() => {
    return () => {
      if (persistTimeout.current !== null) {
        window.clearTimeout(persistTimeout.current)
        const pending = pendingUpdate.current
        if (pending) {
          persist(pending)
        }
      }
    }
  }, [persist])

  const persistedUpdate = React.useCallback(
    (
      override: AppearanceOverride,
      nextDefaultForNewUsers = defaultForNewUsersRef.current
    ): AppearanceUpdate => ({
      ...override,
      ...(uiPreferences.canManageAppearanceDefault
        ? { defaultForNewUsers: nextDefaultForNewUsers }
        : {}),
    }),
    [uiPreferences.canManageAppearanceDefault]
  )

  const updateAppearance = React.useCallback(
    (
      next: AppearancePreferences,
      customColor: string | null,
      nextCustomColors = customColorsRef.current
    ) => {
      const currentAppearance = appearanceRef.current
      const appearanceChanged =
        currentAppearance.accentColor !== next.accentColor ||
        currentAppearance.colorScheme !== next.colorScheme
      const customAccentChanged = customAccentColorRef.current !== customColor
      const customColorsChanged = customColorsRef.current !== nextCustomColors

      if (!appearanceChanged && !customAccentChanged && !customColorsChanged) {
        return
      }
      if (appearanceChanged && !saveAppearanceCache(next)) return

      const resolvedAppearance = appearanceChanged ? next : currentAppearance
      appearanceRef.current = resolvedAppearance
      customAccentColorRef.current = customColor
      customColorsRef.current = nextCustomColors
      if (defaultForNewUsersRef.current) {
        appearanceDefaultRef.current = resolvedAppearance
      }
      if (appearanceChanged) setAppearance(resolvedAppearance)
      if (customAccentChanged) setCustomAccentColor(customColor)
      if (customColorsChanged) setCustomColors(nextCustomColors)

      queryClient.setQueryData<UiPreferences>(
        queryKeys.uiPreferences,
        (current) =>
          current
            ? {
                ...current,
                appearance: resolvedAppearance,
                appearanceDefault: defaultForNewUsersRef.current
                  ? resolvedAppearance
                  : current.appearanceDefault,
                customAccentColor: customColor,
                customColors: nextCustomColors,
              }
            : current
      )
      schedulePersist(
        persistedUpdate({
          accentColor: customColor,
          colorScheme: resolvedAppearance.colorScheme,
          customColors: nextCustomColors,
        })
      )
    },
    [persistedUpdate, queryClient, schedulePersist]
  )

  const updateAccent = React.useCallback(
    (color: string, nextCustomColors = customColorsRef.current) => {
      const normalizedColor = color.toLowerCase()
      const currentAppearance = appearanceRef.current
      updateAppearance(
        { ...currentAppearance, accentColor: normalizedColor },
        normalizedColor,
        nextCustomColors
      )
    },
    [updateAppearance]
  )

  const updateColorScheme = React.useCallback(
    (colorScheme: ColorScheme) => {
      const currentAppearance = appearanceRef.current
      updateAppearance(
        { ...currentAppearance, colorScheme },
        customAccentColorRef.current,
        customColorsRef.current
      )
    },
    [updateAppearance]
  )

  const updateCustomColor = React.useCallback(
    (index: number, color: string) => {
      const nextCustomColors = fillCustomColorSlots(
        customColorsRef.current
      ).map((customColor, colorIndex) =>
        colorIndex === index ? color.toLowerCase() : customColor
      )
      updateAccent(color, nextCustomColors)
    },
    [updateAccent]
  )

  const removeCustomColor = React.useCallback(
    (index: number) => {
      const currentAppearance = appearanceRef.current
      const currentCustomColors = fillCustomColorSlots(customColorsRef.current)
      const removedColor = currentCustomColors[index]
      const nextCustomColors = currentCustomColors.map(
        (customColor, colorIndex) => (colorIndex === index ? null : customColor)
      )
      setActiveCustomIndex(null)
      if (
        removedColor !== null &&
        currentAppearance.accentColor === removedColor
      ) {
        updateAppearance(
          {
            ...currentAppearance,
            accentColor: appearanceDefaultRef.current.accentColor,
          },
          null,
          nextCustomColors
        )
        return
      }
      updateAppearance(
        currentAppearance,
        customAccentColorRef.current,
        nextCustomColors
      )
    },
    [updateAppearance]
  )

  const updateDefaultForNewUsers = React.useCallback(
    (enabled: boolean) => {
      const currentAppearance = appearanceRef.current
      const shouldResetAccent =
        !enabled &&
        customAccentColorRef.current === null &&
        currentAppearance.accentColor !== defaultAppearance.accentColor
      const nextAppearance = shouldResetAccent
        ? {
            ...currentAppearance,
            accentColor: defaultAppearance.accentColor,
          }
        : currentAppearance
      const nextAppearanceDefault = enabled
        ? currentAppearance
        : defaultAppearance

      defaultForNewUsersRef.current = enabled
      appearanceDefaultRef.current = nextAppearanceDefault
      if (shouldResetAccent && saveAppearanceCache(nextAppearance)) {
        appearanceRef.current = nextAppearance
        setAppearance(nextAppearance)
      }
      queryClient.setQueryData<UiPreferences>(
        queryKeys.uiPreferences,
        (current) =>
          current
            ? {
                ...current,
                appearance: nextAppearance,
                appearanceDefault: nextAppearanceDefault,
                defaultForNewUsers: enabled,
              }
            : current
      )
      schedulePersist(
        persistedUpdate(
          {
            accentColor: customAccentColorRef.current,
            colorScheme: currentAppearance.colorScheme,
            customColors: customColorsRef.current,
          },
          enabled
        )
      )
    },
    [persistedUpdate, queryClient, schedulePersist]
  )

  return {
    activeCustomIndex,
    appearance,
    canManageAppearanceDefault: uiPreferences.canManageAppearanceDefault,
    customColors,
    defaultForNewUsers: defaultForNewUsersRef.current,
    setActiveCustomIndex,
    removeCustomColor,
    updateAccent,
    updateColorScheme,
    updateCustomColor,
    updateDefaultForNewUsers,
  }
}

export const AppearanceSettingsPage = React.memo(
  function AppearanceSettingsPage() {
    const settings = useAppearanceSettings()

    return (
      <div className="w-full max-w-2xl px-5 pb-12">
        <section className="border-b">
          <ModeControl
            colorScheme={settings.appearance.colorScheme}
            onSelect={settings.updateColorScheme}
          />

          <AccentColorControl
            accentColor={settings.appearance.accentColor}
            activeCustomIndex={settings.activeCustomIndex}
            customColors={settings.customColors}
            onCustomChange={settings.updateCustomColor}
            onCustomOpenChange={settings.setActiveCustomIndex}
            onCustomRemove={settings.removeCustomColor}
            onSelect={settings.updateAccent}
          />

          {settings.canManageAppearanceDefault ? (
            <SettingRow label="Default for new users">
              <Switch
                aria-label="Default for new users"
                defaultChecked={settings.defaultForNewUsers}
                onCheckedChange={settings.updateDefaultForNewUsers}
              />
            </SettingRow>
          ) : null}
        </section>
      </div>
    )
  }
)

const AccentColorControl = React.memo(function AccentColorControl({
  accentColor,
  activeCustomIndex,
  customColors,
  onCustomChange,
  onCustomOpenChange,
  onCustomRemove,
  onSelect,
}: {
  accentColor: string
  activeCustomIndex: number | null
  customColors: AppearanceOverride["customColors"]
  onCustomChange: (index: number, color: string) => void
  onCustomOpenChange: (index: number | null) => void
  onCustomRemove: (index: number) => void
  onSelect: (color: string) => void
}) {
  return (
    <SettingRow label="Accent Color">
      <div className="flex max-w-md flex-wrap items-stretch gap-x-3 gap-y-4">
        <SwatchGroup label="Default">
          <PresetColorSwatch
            preset={defaultPreset}
            selected={accentColor === defaultPreset.color}
            onSelect={onSelect}
          />
        </SwatchGroup>

        <SwatchGroup label="Presets" separated>
          {presets.map((preset) => (
            <PresetColorSwatch
              key={preset.name}
              preset={preset}
              selected={accentColor === preset.color}
              onSelect={onSelect}
            />
          ))}
        </SwatchGroup>

        <SwatchGroup label="Custom" separated>
          {customColorSlotIndexes.map((index) => (
            <CustomColorControl
              key={`custom-color-${index}`}
              color={customColors[index] ?? null}
              index={index}
              open={activeCustomIndex === index}
              selected={
                customColors[index] !== null &&
                accentColor === customColors[index]
              }
              onChange={onCustomChange}
              onOpenChange={onCustomOpenChange}
              onRemove={onCustomRemove}
              onSelect={onSelect}
            />
          ))}
        </SwatchGroup>
      </div>
    </SettingRow>
  )
})

function SwatchGroup({
  children,
  label,
  separated = false,
}: {
  children: React.ReactNode
  label: string
  separated?: boolean
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "relative flex min-w-0 flex-col gap-2",
        separated && "pl-3"
      )}
    >
      {separated ? (
        <span
          role="separator"
          aria-orientation="vertical"
          className="absolute inset-y-0 left-0 w-px bg-border"
        />
      ) : null}
      <div className="flex min-h-9 flex-wrap items-center justify-center gap-2">
        {children}
      </div>
      <p className="type-technical-label text-center text-muted-foreground">
        {label}
      </p>
    </div>
  )
}

const PresetColorSwatch = React.memo(function PresetColorSwatch({
  onSelect,
  preset,
  selected,
}: {
  onSelect: (color: string) => void
  preset: (typeof presets)[number] | typeof defaultPreset
  selected: boolean
}) {
  const select = React.useCallback(
    () => onSelect(preset.color),
    [onSelect, preset.color]
  )

  return (
    <ColorSwatch
      color={preset.color}
      label={preset.name}
      selected={selected}
      onClick={select}
    />
  )
})

const CustomColorControl = React.memo(function CustomColorControl({
  color,
  index,
  onChange,
  onOpenChange,
  onRemove,
  onSelect,
  open,
  selected,
}: {
  color: string | null
  index: number
  onChange: (index: number, color: string) => void
  onOpenChange: (index: number | null) => void
  onRemove: (index: number) => void
  onSelect: (color: string) => void
  open: boolean
  selected: boolean
}) {
  const change = React.useCallback(
    (nextColor: string) => onChange(index, nextColor),
    [index, onChange]
  )
  const changeOpen = React.useCallback(
    (nextOpen: boolean) => onOpenChange(nextOpen ? index : null),
    [index, onOpenChange]
  )
  const remove = React.useCallback(() => onRemove(index), [index, onRemove])
  const select = React.useCallback(() => {
    if (color !== null) onSelect(color)
  }, [color, onSelect])

  return (
    <ColorPicker
      defaultValue={color ?? customColorSeeds[index] ?? customColorSeeds[0]}
      onValueChange={change}
      onRemove={color === null ? undefined : remove}
      open={open}
      onOpenChange={changeOpen}
    >
      {color === null ? (
        <button
          type="button"
          aria-label={`Edit custom color ${index + 1}`}
          className="grid size-9 place-items-center border border-dashed border-input bg-input/10 text-muted-foreground transition-[color,background-color,border-color,transform] outline-none hover:scale-105 hover:border-primary/50 hover:bg-primary/6 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/45"
        >
          <Pencil className="size-3.5" aria-hidden="true" />
        </button>
      ) : (
        <ColorSwatch
          color={color}
          label={`Custom color ${index + 1}`}
          selected={selected}
          onClick={select}
        />
      )}
    </ColorPicker>
  )
})

type ColorSwatchProps = Omit<
  React.ComponentPropsWithoutRef<"button">,
  "color"
> & {
  color: string
  label: string
  selected: boolean
}

const ColorSwatch = React.forwardRef<HTMLButtonElement, ColorSwatchProps>(
  function ColorSwatch(
    { className, color, label, selected, style, ...props },
    ref
  ) {
    return (
      <button
        ref={ref}
        type="button"
        {...props}
        aria-label={label}
        aria-pressed={selected}
        className={cn(
          "relative size-9 border border-black/15 transition-[border-color,box-shadow,transform] outline-none hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring/45 aria-pressed:border-primary aria-pressed:ring-2 aria-pressed:ring-primary/50 aria-pressed:ring-offset-2 aria-pressed:ring-offset-background",
          className
        )}
        style={{ ...style, backgroundColor: color }}
      >
        {selected ? (
          <span className="absolute -top-1.5 -right-1.5 grid size-4 place-items-center border-2 border-background bg-primary text-primary-foreground shadow-sm">
            <Check className="size-2.5" aria-hidden="true" />
          </span>
        ) : null}
      </button>
    )
  }
)

function SettingRow({
  children,
  label,
}: {
  children: React.ReactNode
  label: string
}) {
  return (
    <div className="grid gap-3 border-b py-5 last:border-b-0 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center">
      <p className="text-xs font-medium text-foreground">{label}</p>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

const ModeControl = React.memo(function ModeControl({
  colorScheme,
  onSelect,
}: {
  colorScheme: ColorScheme
  onSelect: (colorScheme: ColorScheme) => void
}) {
  return (
    <SettingRow label="Mode">
      <div className="grid max-w-md grid-cols-3 gap-1.5">
        <ModeButton
          active={colorScheme === "dark"}
          colorScheme="dark"
          icon={Moon}
          label="Dark"
          onSelect={onSelect}
        />
        <ModeButton
          active={colorScheme === "light"}
          colorScheme="light"
          icon={Sun}
          label="Light"
          onSelect={onSelect}
        />
        <ModeButton
          active={colorScheme === "system"}
          colorScheme="system"
          icon={Monitor}
          label="System"
          onSelect={onSelect}
        />
      </div>
    </SettingRow>
  )
})

const ModeButton = React.memo(function ModeButton({
  active,
  colorScheme,
  icon: Icon,
  label,
  onSelect,
}: {
  active: boolean
  colorScheme: ColorScheme
  icon: typeof Moon
  label: string
  onSelect: (colorScheme: ColorScheme) => void
}) {
  const select = React.useCallback(
    () => onSelect(colorScheme),
    [colorScheme, onSelect]
  )

  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={select}
      className="flex h-9 items-center justify-center gap-2 border bg-input/15 px-2 text-xs font-medium text-muted-foreground transition-[color,background-color,border-color,box-shadow] outline-none hover:border-primary/35 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/35 aria-pressed:border-primary/55 aria-pressed:bg-primary/8 aria-pressed:text-primary"
    >
      <Icon className="size-3.5" aria-hidden="true" />
      <span>{label}</span>
    </button>
  )
})
