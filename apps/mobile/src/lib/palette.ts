import { useColorScheme } from "react-native"

// Native props (navigation chrome, symbol tints, refresh spinners) take
// colors, not class names. Keep these aligned with global.css.
const dark = {
  screen: "#12100f",
  card: "#191715",
  border: "#312a26",
  foreground: "#eceae9",
  muted: "#aca29a",
  primary: "#fa822e",
  primaryText: "#fa822e",
  primaryForeground: "#191410",
  danger: "#f45249",
  success: "#47b777",
  warning: "#daa843",
  info: "#4896d3",
  // Hearth's instance kind tones (instance-kind-icon.tsx): fixed per kind.
  kindRelay: "#f97316",
  kindServer: "#6ee7b7",
  kindDatabase: "#93c5fd",
  kindApp: "#f87171",
  kindTunnel: "#67e8f9",
}

const light: typeof dark = {
  screen: "#f0e8e3",
  card: "#f9f5f3",
  border: "#dac9be",
  foreground: "#211b17",
  muted: "#544840",
  primary: "#fa822e",
  primaryText: "#c75505",
  primaryForeground: "#191410",
  danger: "#d01d21",
  success: "#007e46",
  warning: "#aa6a00",
  info: "#2f6fa3",
  kindRelay: "#f97316",
  kindServer: "#047857",
  kindDatabase: "#2563eb",
  kindApp: "#dc2626",
  kindTunnel: "#0e7490",
}

export type Palette = typeof dark
export type PaletteColor = keyof Palette

export function usePalette(): Palette {
  return useColorScheme() === "light" ? light : dark
}
