import { readFileSync } from "node:fs"

// Email clients ignore CSS custom properties, so emails get Hearth's colors
// as hex, read from the stylesheet when Vite loads its config. The contract:
// each token below is declared in the `:root, .dark` block, `.light` may
// override it, and it resolves through var() references to hsl(h s% l%).
// Anything else fails the build, dev server, and tests instead of a send.
const emailColors = [
  "card",
  "surface-raised",
  "border",
  "foreground",
  "muted-foreground",
  "primary",
  "primary-foreground",
] as const

export type EmailColor = (typeof emailColors)[number]
export type EmailTheme = Record<"dark" | "light", Record<EmailColor, string>>

export function emailTheme(stylesheetPath: string): EmailTheme {
  const stylesheet = readFileSync(stylesheetPath, "utf8").replace(
    /\/\*[\s\S]*?\*\//gu,
    ""
  )
  const dark = declarations(stylesheet, ":root, .dark")
  const light = new Map([...dark, ...declarations(stylesheet, ".light")])
  return { dark: resolveColors(dark), light: resolveColors(light) }
}

function declarations(stylesheet: string, selector: string) {
  const blocks = [...stylesheet.matchAll(/([^{};]+)\{([^{}]*)\}/gu)].filter(
    ([, prelude]) => prelude.trim().replace(/\s+/gu, " ") === selector
  )
  if (blocks.length !== 1)
    throw new Error(
      `Expected one "${selector}" block in globals.css, found ${blocks.length}`
    )
  return new Map(
    [...blocks[0][2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)].map(
      ([, name, value]) => [name, value.trim().replace(/\s+/gu, " ")]
    )
  )
}

function resolveColors(variables: Map<string, string>) {
  return Object.fromEntries(
    emailColors.map((color) => [
      color,
      hex(color, resolve(`--${color}`, variables, [])),
    ])
  ) as Record<EmailColor, string>
}

function resolve(
  name: string,
  variables: Map<string, string>,
  seen: Array<string>
): string {
  if (seen.includes(name))
    throw new Error(`globals.css: ${[...seen, name].join(" -> ")} is circular`)
  const value = variables.get(name)
  if (value === undefined) throw new Error(`globals.css doesn't define ${name}`)
  return value.replace(/var\((--[\w-]+)\)/gu, (_, reference: string) =>
    resolve(reference, variables, [...seen, name])
  )
}

function hex(color: EmailColor, value: string) {
  const match = /^hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%\)$/u.exec(value)
  if (!match)
    throw new Error(
      `Email color --${color} must resolve to hsl(h s% l%) in globals.css, got ${value}`
    )
  const hue = Number(match[1])
  const saturation = Number(match[2]) / 100
  const lightness = Number(match[3]) / 100
  const chroma = saturation * Math.min(lightness, 1 - lightness)
  const channel = (offset: number) => {
    const k = (offset + hue / 30) % 12
    const value = lightness - chroma * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, "0")
  }
  return `#${channel(0)}${channel(8)}${channel(4)}`
}
