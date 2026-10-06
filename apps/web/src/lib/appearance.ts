import { Option, Result, Schema } from "effect"

export const appearanceCacheCookieName = "kiln_appearance"
const stableDefaultAccentColor = "#f97316"
export const maximumCustomAccentColors = 3

const appearanceCacheMaxAge = 60 * 60 * 24 * 365
const hexColorPattern = /^#[\da-f]{6}$/i
const decodeJsonString = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Unknown)
)

export type ColorScheme = "dark" | "light" | "system"
export type ResolvedColorScheme = Exclude<ColorScheme, "system">

export interface AppearancePreferences {
  accentColor: string
  colorScheme: ColorScheme
}

export interface AppearanceOverride {
  accentColor: string | null
  colorScheme: ColorScheme
  customColors: Array<string | null>
}

export type AccentHsl = {
  hue: number
  saturation: number
}

const defaultAccentColor = stableDefaultAccentColor
export const defaultColorScheme: ColorScheme = "dark"

export const defaultAppearance: AppearancePreferences = {
  accentColor: defaultAccentColor,
  colorScheme: defaultColorScheme,
}

function parseAccentColor(color: string): AccentHsl | null {
  if (!hexColorPattern.test(color)) return null

  const red = Number.parseInt(color.slice(1, 3), 16) / 255
  const green = Number.parseInt(color.slice(3, 5), 16) / 255
  const blue = Number.parseInt(color.slice(5, 7), 16) / 255
  const maximum = Math.max(red, green, blue)
  const minimum = Math.min(red, green, blue)
  const delta = maximum - minimum
  const lightness = (maximum + minimum) / 2

  let hue = 0
  if (delta > 0) {
    if (maximum === red) hue = ((green - blue) / delta) % 6
    else if (maximum === green) hue = (blue - red) / delta + 2
    else hue = (red - green) / delta + 4
    hue *= 60
    if (hue < 0) hue += 360
  }

  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1))

  return {
    hue: Math.round(hue * 10) / 10,
    saturation: Math.round(saturation * 1_000) / 10,
  }
}

export function normalizeAppearancePreferences(
  value: unknown,
  fallbackAccentColor = defaultAccentColor
): AppearancePreferences {
  if (!value || typeof value !== "object") {
    return {
      accentColor: fallbackAccentColor,
      colorScheme: defaultColorScheme,
    }
  }

  const accentColor =
    "accentColor" in value &&
    typeof value.accentColor === "string" &&
    hexColorPattern.test(value.accentColor)
      ? value.accentColor.toLowerCase()
      : fallbackAccentColor
  const colorScheme =
    "colorScheme" in value &&
    (value.colorScheme === "dark" ||
      value.colorScheme === "light" ||
      value.colorScheme === "system")
      ? value.colorScheme
      : defaultColorScheme

  return { accentColor, colorScheme }
}

export function normalizeAppearanceOverride(
  value: unknown
): AppearanceOverride {
  if (!value || typeof value !== "object") {
    return {
      accentColor: null,
      colorScheme: defaultColorScheme,
      customColors: [null, null, null],
    }
  }

  const accentColor =
    "accentColor" in value &&
    typeof value.accentColor === "string" &&
    hexColorPattern.test(value.accentColor)
      ? value.accentColor.toLowerCase()
      : null
  const colorScheme =
    "colorScheme" in value &&
    (value.colorScheme === "dark" ||
      value.colorScheme === "light" ||
      value.colorScheme === "system")
      ? value.colorScheme
      : defaultColorScheme
  const customColors: Array<string | null> = [null, null, null]
  const customColorSet = new Set<string>()
  const rawCustomColors =
    "customColors" in value && Array.isArray(value.customColors)
      ? value.customColors
      : []
  for (let index = 0; index < maximumCustomAccentColors; index += 1) {
    const customColor = rawCustomColors[index]
    if (typeof customColor !== "string" || !hexColorPattern.test(customColor)) {
      continue
    }
    const normalizedColor = customColor.toLowerCase()
    if (!customColorSet.has(normalizedColor)) {
      customColorSet.add(normalizedColor)
      customColors[index] = normalizedColor
    }
  }

  return { accentColor, colorScheme, customColors }
}

export function resolveAppearance(
  override: AppearanceOverride | null,
  platformDefault: AppearancePreferences | null
): AppearancePreferences {
  const fallback = platformDefault ?? defaultAppearance
  return {
    accentColor: override?.accentColor ?? fallback.accentColor,
    colorScheme: override?.colorScheme ?? fallback.colorScheme,
  }
}

function resolveColorScheme(
  colorScheme: ColorScheme,
  prefersDark = systemPrefersDark()
): ResolvedColorScheme {
  return colorScheme === "system"
    ? prefersDark
      ? "dark"
      : "light"
    : colorScheme
}

function systemPrefersDark() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  )
}

export function applyAppearance(preferences: AppearancePreferences) {
  const accent = parseAccentColor(preferences.accentColor)
  if (!accent || typeof document === "undefined") return false

  const root = document.documentElement
  const colorScheme = resolveColorScheme(preferences.colorScheme)
  const accentHue = String(accent.hue)
  const accentSaturation = `${accent.saturation}%`
  if (root.style.getPropertyValue("--accent-hue") !== accentHue) {
    root.style.setProperty("--accent-hue", accentHue)
  }
  if (root.style.getPropertyValue("--accent-saturation") !== accentSaturation) {
    root.style.setProperty("--accent-saturation", accentSaturation)
  }

  const oppositeColorScheme = colorScheme === "dark" ? "light" : "dark"
  if (root.classList.contains(oppositeColorScheme)) {
    root.classList.replace(oppositeColorScheme, colorScheme)
  } else if (!root.classList.contains(colorScheme)) {
    root.classList.add(colorScheme)
  }
  return true
}

export function readAppearanceCache(): AppearancePreferences {
  if (typeof document === "undefined") {
    return {
      accentColor: defaultAccentColor,
      colorScheme: defaultColorScheme,
    }
  }

  const encodedPreferences = document.cookie
    .split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${appearanceCacheCookieName}=`))
    ?.slice(appearanceCacheCookieName.length + 1)

  if (!encodedPreferences) {
    return {
      accentColor: defaultAccentColor,
      colorScheme: defaultColorScheme,
    }
  }

  return Result.try(() => decodeURIComponent(encodedPreferences)).pipe(
    Result.match({
      onFailure: () => defaultAppearance,
      onSuccess: (decoded) =>
        decodeJsonString(decoded).pipe(
          Option.map(normalizeAppearancePreferences),
          Option.getOrElse(() => defaultAppearance)
        ),
    })
  )
}

export function saveAppearanceCache(preferences: AppearancePreferences) {
  const normalized = normalizeAppearancePreferences(preferences)
  if (!applyAppearance(normalized)) return false

  document.cookie = `${appearanceCacheCookieName}=${encodeURIComponent(
    JSON.stringify(normalized)
  )}; path=/; max-age=${appearanceCacheMaxAge}; SameSite=Lax`
  return true
}

export function clearAppearanceCache() {
  if (typeof document === "undefined") return
  document.cookie = `${appearanceCacheCookieName}=; path=/; max-age=0; SameSite=Lax`
  applyAppearance({
    accentColor: defaultAccentColor,
    colorScheme: defaultColorScheme,
  })
}

const bootDefault = JSON.stringify(defaultAppearance)

export const appearanceBootScript = `(()=>{try{const n="${appearanceCacheCookieName}=",e=document.cookie.split(";").map(e=>e.trim()).find(e=>e.startsWith(n));let t=${bootDefault};if(e)try{const n=JSON.parse(decodeURIComponent(e.slice(${appearanceCacheCookieName.length + 1})));if(n&&/^#[\\da-f]{6}$/i.test(n.accentColor)&&(n.colorScheme==="dark"||n.colorScheme==="light"||n.colorScheme==="system"))t=n}catch{}const c=t.accentColor,r=parseInt(c.slice(1,3),16)/255,o=parseInt(c.slice(3,5),16)/255,a=parseInt(c.slice(5,7),16)/255,s=Math.max(r,o,a),i=Math.min(r,o,a),l=s-i,d=(s+i)/2;let u=0;l>0&&(s===r?u=(o-a)/l%6:s===o?u=(a-r)/l+2:u=(r-o)/l+4,u*=60,u<0&&(u+=360));const m=l===0?0:l/(1-Math.abs(2*d-1)),p=document.documentElement,h=t.colorScheme==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):t.colorScheme;p.style.setProperty("--accent-hue",String(Math.round(10*u)/10)),p.style.setProperty("--accent-saturation",Math.round(1e3*m)/10+"%"),p.classList.toggle("dark",h==="dark"),p.classList.toggle("light",h==="light")}catch{}})()`
