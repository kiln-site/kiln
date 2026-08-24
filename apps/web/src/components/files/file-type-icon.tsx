import * as React from "react"
import {
  createFileTreeIconResolver,
  getBuiltInSpriteSheet,
} from "@pierre/trees"

const fileIconResolver = createFileTreeIconResolver()
const fileIconSpriteSheet = getBuiltInSpriteSheet("complete")

const iconPalette = {
  blue: "light-dark(#1a85d4, #69b1ff)",
  cyan: "light-dark(#1ca1c7, #68cdf2)",
  gray: "light-dark(#84848a, #adadb1)",
  green: "light-dark(#199f43, #5ecc71)",
  indigo: "light-dark(#693acf, #9d6afb)",
  mauve: "light-dark(#594c5b, #79697b)",
  orange: "light-dark(#d47628, #ffa359)",
  pink: "light-dark(#d32a61, #ff678d)",
  purple: "light-dark(#a631be, #d568ea)",
  red: "light-dark(#d52c36, #ff6762)",
  teal: "light-dark(#17a5af, #64d1db)",
  vermilion: "light-dark(#ff8c5b, #d5512f)",
  yellow: "light-dark(#d5a910, #ffd452)",
} as const

const fileIconColor: Record<string, string> = {
  astro: iconPalette.purple,
  babel: iconPalette.yellow,
  bash: iconPalette.green,
  biome: iconPalette.blue,
  bootstrap: iconPalette.indigo,
  browserslist: iconPalette.yellow,
  bun: iconPalette.mauve,
  c: iconPalette.blue,
  claude: iconPalette.orange,
  cpp: iconPalette.blue,
  css: iconPalette.indigo,
  database: iconPalette.purple,
  default: iconPalette.gray,
  docker: iconPalette.blue,
  eslint: iconPalette.indigo,
  font: iconPalette.gray,
  git: iconPalette.vermilion,
  go: iconPalette.cyan,
  graphql: iconPalette.pink,
  html: iconPalette.orange,
  image: iconPalette.pink,
  javascript: iconPalette.yellow,
  json: iconPalette.orange,
  markdown: iconPalette.green,
  mcp: iconPalette.teal,
  nextjs: iconPalette.gray,
  npm: iconPalette.red,
  oxc: iconPalette.cyan,
  postcss: iconPalette.red,
  prettier: iconPalette.teal,
  python: iconPalette.blue,
  react: iconPalette.cyan,
  ruby: iconPalette.red,
  rust: iconPalette.orange,
  sass: iconPalette.pink,
  stylelint: iconPalette.indigo,
  svelte: iconPalette.red,
  svg: iconPalette.orange,
  svgo: iconPalette.green,
  swift: iconPalette.orange,
  table: iconPalette.teal,
  tailwind: iconPalette.cyan,
  terraform: iconPalette.indigo,
  text: iconPalette.gray,
  typescript: iconPalette.blue,
  vite: iconPalette.purple,
  vscode: iconPalette.blue,
  vue: iconPalette.green,
  wasm: iconPalette.indigo,
  webpack: iconPalette.blue,
  yml: iconPalette.red,
  zig: iconPalette.orange,
  zip: iconPalette.orange,
}

export function FileTypeIconSprite() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute size-0 overflow-hidden"
      dangerouslySetInnerHTML={{ __html: fileIconSpriteSheet }}
    />
  )
}

export const FileTypeIcon = React.memo(function FileTypeIcon({
  path,
}: {
  path: string
}) {
  const icon = fileIconResolver.resolveIcon("file-tree-icon-file", path)

  return (
    <svg
      aria-hidden="true"
      className="size-4 shrink-0"
      data-icon-token={icon.token}
      style={{ color: fileIconColor[icon.token ?? "default"] }}
      viewBox={icon.viewBox ?? "0 0 16 16"}
    >
      <use href={`#${icon.name.replace(/^#/u, "")}`} />
    </svg>
  )
})
