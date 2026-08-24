export type FileLanguage = {
  id:
    | "ini"
    | "json"
    | "log"
    | "properties"
    | "shell"
    | "snbt"
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
    lowerPath.endsWith(".dat")
  ) {
    return { id: "snbt", label: "SNBT" }
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

  const extension = filename.match(/\.([a-z0-9][a-z0-9_-]{0,11})$/)?.[1]
  if (extension) return { id: "text", label: extension.toUpperCase() }

  return { id: "text", label: "Plain Text" }
}
