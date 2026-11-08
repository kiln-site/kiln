export type FileLanguage = {
  id:
    | "dockerfile"
    | "ini"
    | "json"
    | "log"
    | "properties"
    | "shell"
    | "snbt"
    | "sql"
    | "text"
    | "toml"
    | "valve-keyvalues"
    | "xml"
    | "yaml"
  label: string
}

export function fileLanguageForPath(path: string): FileLanguage {
  const lowerPath = path.toLowerCase()
  const filename = lowerPath.split("/").at(-1) ?? lowerPath
  if (
    lowerPath.endsWith(".snbt") ||
    lowerPath.endsWith(".nbt") ||
    lowerPath.endsWith(".dat") ||
    lowerPath.endsWith(".dat_old")
  ) {
    return { id: "snbt", label: "SNBT" }
  }
  if (
    filename === "dockerfile" ||
    filename.startsWith("dockerfile.") ||
    filename.endsWith(".dockerfile")
  ) {
    return { id: "dockerfile", label: "Dockerfile" }
  }
  if (lowerPath.endsWith(".json")) return { id: "json", label: "JSON" }
  if (lowerPath.endsWith(".json5")) return { id: "json", label: "JSON5" }
  if (lowerPath.endsWith(".mcmeta")) return { id: "json", label: "MCMETA" }
  if (lowerPath.endsWith(".yml") || lowerPath.endsWith(".yaml")) {
    return { id: "yaml", label: "YAML" }
  }
  if (lowerPath.endsWith(".xml")) return { id: "xml", label: "XML" }
  if (lowerPath.endsWith(".toml")) return { id: "toml", label: "TOML" }
  if (lowerPath.endsWith(".log") || lowerPath.endsWith(".log.gz")) {
    return { id: "log", label: "LOG" }
  }
  if (lowerPath.endsWith(".ini")) return { id: "ini", label: "INI" }
  if (lowerPath.endsWith(".sql")) return { id: "sql", label: "SQL" }
  if (
    lowerPath.endsWith(".sh") ||
    lowerPath.endsWith(".bash") ||
    lowerPath.endsWith(".zsh")
  ) {
    return { id: "shell", label: "Shell" }
  }
  if (lowerPath.endsWith(".vdf")) {
    return { id: "valve-keyvalues", label: "VDF" }
  }
  if (lowerPath.endsWith(".acf")) {
    return { id: "valve-keyvalues", label: "ACF" }
  }
  if (lowerPath.endsWith(".properties")) {
    return { id: "properties", label: "Properties" }
  }
  if (lowerPath.endsWith(".cfg")) return { id: "properties", label: "CFG" }
  if (lowerPath.endsWith(".conf")) {
    return { id: "properties", label: "CONF" }
  }
  if (filename === ".env" || filename.startsWith(".env.")) {
    return { id: "properties", label: "Environment" }
  }
  if (lowerPath.endsWith(".txt")) return { id: "text", label: "Text" }

  // The editor highlights these with CodeMirror's own languages; `text` here
  // means none of Kiln's modes covers them.
  const extension = filename.match(/\.([a-z0-9][a-z0-9_+-]{0,11})$/)?.[1]
  if (extension) {
    return {
      id: "text",
      label: extensionLabels[extension] ?? extension.toUpperCase(),
    }
  }

  return { id: "text", label: "Plain Text" }
}

const extensionLabels: Record<string, string> = {
  c: "C",
  cc: "C++",
  cjs: "JavaScript",
  cpp: "C++",
  cs: "C#",
  css: "CSS",
  go: "Go",
  gradle: "Groovy",
  groovy: "Groovy",
  h: "C",
  hpp: "C++",
  htm: "HTML",
  html: "HTML",
  java: "Java",
  js: "JavaScript",
  jsx: "JSX",
  kt: "Kotlin",
  kts: "Kotlin",
  less: "Less",
  lua: "Lua",
  markdown: "Markdown",
  md: "Markdown",
  mjs: "JavaScript",
  php: "PHP",
  pl: "Perl",
  ps1: "PowerShell",
  py: "Python",
  rb: "Ruby",
  rs: "Rust",
  sass: "Sass",
  scala: "Scala",
  scss: "SCSS",
  svg: "SVG",
  swift: "Swift",
  ts: "TypeScript",
  tsx: "TSX",
  vue: "Vue",
}
