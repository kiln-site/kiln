import { readdir, readFile } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"

import { Marked, type Token, type Tokens } from "marked"
import { createCssVariablesTheme, createHighlighter } from "shiki"
import { parseDocument } from "yaml"
import type { Plugin, ViteDevServer } from "vite-plus"

// Builds the docs from `content/**/*.md` at build time, so pages ship as HTML
// and the browser never parses Markdown. Each page compiles to its own module;
// three virtual modules add what spans pages:
//
// - `virtual:docs/manifest`: every page's path, title, and description.
// - `virtual:docs/search`: the search index, one entry per heading.
// - `virtual:docs/markdown`: every page's Markdown, for llms.txt and copying.

const contentDirectory = resolve(import.meta.dirname, "content")
const virtualIds = {
  manifest: "virtual:docs/manifest",
  search: "virtual:docs/search",
  markdown: "virtual:docs/markdown",
} as const
const resolvedPrefix = "\0"

const languages = [
  "bash",
  "diff",
  "dockerfile",
  "ini",
  "javascript",
  "json",
  "jsonc",
  "properties",
  "shellsession",
  "sql",
  "toml",
  "tsx",
  "typescript",
  "yaml",
]
const languageAliases: Record<string, string> = {
  console: "shellsession",
  js: "javascript",
  env: "properties",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  yml: "yaml",
  zsh: "bash",
}

export interface Heading {
  depth: 2 | 3
  id: string
  text: string
}

export interface CompiledPage {
  description: string
  headings: Array<Heading>
  html: string
  // The page's URL path without the base, like "/relays/add".
  path: string
  // Its file under content/, like "relays/add.md".
  source: string
  title: string
}

export interface SearchEntry {
  // The heading's anchor, or "" for the page's opening paragraphs.
  anchor: string
  heading: string
  path: string
  text: string
  title: string
}

interface Source {
  // Every heading's anchor, h4 included, for checking links to them.
  anchors: Set<string>
  file: string
  // Links to other docs pages or headings, as written.
  links: Array<string>
  markdown: string
  page: CompiledPage
  search: Array<SearchEntry>
}

export function docsContent(): Plugin {
  let base = "/"
  let building = false
  let highlighter: Awaited<ReturnType<typeof createHighlighter>> | null = null
  const cache = new Map<string, Source>()

  async function getHighlighter() {
    highlighter ??= await createHighlighter({
      // Colours come from CSS variables, so code follows the site's palette.
      themes: [
        createCssVariablesTheme({ name: "kiln", variablePrefix: "--code-" }),
      ],
      langs: languages,
    })
    return highlighter
  }

  async function compileFile(file: string): Promise<Source> {
    const source = await readFile(file, "utf8")
    const cached = cache.get(file)
    if (cached && cached.markdown === source) return cached
    const compiled = compile({
      base,
      file,
      highlighter: await getHighlighter(),
      source,
    })
    cache.set(file, compiled)
    return compiled
  }

  async function compileAll(): Promise<Array<Source>> {
    const files = await markdownFiles(contentDirectory)
    const sources = await Promise.all(files.map(compileFile))
    // A link to a page or heading that doesn't exist fails the build, and
    // warns while developing.
    const broken = brokenLinks(sources)
    if (broken.length > 0) {
      const message = `Broken links in the docs:\n${broken.join("\n")}`
      if (building) throw new Error(message)
      console.warn(message)
    }
    return sources
  }

  function invalidate(server: ViteDevServer) {
    for (const id of Object.values(virtualIds)) {
      const module = server.moduleGraph.getModuleById(resolvedPrefix + id)
      if (module) server.moduleGraph.invalidateModule(module)
    }
  }

  return {
    name: "kiln-docs:content",
    enforce: "pre",
    configResolved(config) {
      base = config.base
      building = config.command === "build"
    },
    configureServer(server) {
      server.watcher.add(contentDirectory)
      const onChange = (file: string) => {
        if (!file.startsWith(contentDirectory + sep) || !file.endsWith(".md")) {
          return
        }
        cache.delete(file)
        invalidate(server)
        server.ws.send({ type: "full-reload" })
      }
      server.watcher.on("add", onChange)
      server.watcher.on("unlink", onChange)
      server.watcher.on("change", onChange)
    },
    resolveId(id) {
      if ((Object.values(virtualIds) as Array<string>).includes(id)) {
        return resolvedPrefix + id
      }
      return null
    },
    async load(id) {
      if (id === resolvedPrefix + virtualIds.manifest) {
        const pages = (await compileAll()).map(({ page }) => ({
          description: page.description,
          path: page.path,
          title: page.title,
        }))
        return `export default ${JSON.stringify(pages)}`
      }
      if (id === resolvedPrefix + virtualIds.search) {
        const entries = (await compileAll()).flatMap(({ search }) => search)
        return `export default ${JSON.stringify(entries)}`
      }
      if (id === resolvedPrefix + virtualIds.markdown) {
        const pages = (await compileAll()).map(({ markdown, page }) => ({
          description: page.description,
          markdown: stripFrontmatter(markdown),
          path: page.path,
          title: page.title,
        }))
        return `export default ${JSON.stringify(pages)}`
      }
      const file = id.split("?")[0] ?? id
      if (file.startsWith(contentDirectory + sep) && file.endsWith(".md")) {
        this.addWatchFile(file)
        const { page } = await compileFile(file)
        return `export default ${JSON.stringify(page)}`
      }
      return null
    },
  }
}

function brokenLinks(sources: Array<Source>): Array<string> {
  const anchorsByPath = new Map(
    sources.map((source) => [source.page.path, source.anchors])
  )
  const broken: Array<string> = []
  for (const source of sources) {
    for (const link of source.links) {
      const [target = "", anchor] = link.split("#")
      const path =
        target.replace(/\/+$/, "") || (target ? "/" : source.page.path)
      const anchors = anchorsByPath.get(path)
      if (!anchors && path !== "/") {
        broken.push(`  ${source.page.source}: ${link} (no such page)`)
      } else if (anchor && anchors && !anchors.has(anchor)) {
        broken.push(`  ${source.page.source}: ${link} (no such heading)`)
      }
    }
  }
  return broken
}

async function markdownFiles(directory: string): Promise<Array<string>> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return markdownFiles(path)
      return Promise.resolve(entry.name.endsWith(".md") ? [path] : [])
    })
  )
  return nested.flat().sort()
}

const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function stripFrontmatter(source: string): string {
  return source.replace(frontmatterPattern, "").trim()
}

// YAML, but a plain `key: value` line also works when the value has a
// colon of its own, like "description: How it runs: …", which YAML refuses.
function parseFrontmatter(
  source: string,
  where: string
): { description?: unknown; title?: unknown } {
  const document = parseDocument(source)
  if (document.errors.length === 0) {
    const parsed: unknown = document.toJS()
    if (parsed && typeof parsed === "object") return parsed
  }
  const fields: Record<string, string> = {}
  for (const line of source.split(/\r?\n/)) {
    const field = /^([A-Za-z]+):\s*(.*)$/.exec(line)
    if (field?.[1])
      fields[field[1]] = (field[2] ?? "").replace(/^["']|["']$/g, "")
  }
  if (Object.keys(fields).length === 0) {
    throw new Error(`${where} has frontmatter that isn't valid YAML`)
  }
  return fields
}

function pagePath(file: string): string {
  const path = relative(contentDirectory, file)
    .split(sep)
    .join("/")
    .replace(/\.md$/, "")
    .replace(/(^|\/)index$/, "")
  return `/${path}`
}

function compile({
  base,
  file,
  highlighter,
  source,
}: {
  base: string
  file: string
  highlighter: Awaited<ReturnType<typeof createHighlighter>>
  source: string
}): Source {
  const match = frontmatterPattern.exec(source)
  const where = relative(contentDirectory, file).split(sep).join("/")
  const frontmatter = parseFrontmatter(match?.[1] ?? "", where)
  if (typeof frontmatter.title !== "string" || !frontmatter.title.trim()) {
    throw new Error(`${where} needs a title in its frontmatter`)
  }
  if (typeof frontmatter.description !== "string") {
    throw new Error(`${where} needs a description in its frontmatter`)
  }
  const title = frontmatter.title.trim()
  const description = frontmatter.description.trim()
  const path = pagePath(file)
  const body = stripFrontmatter(source)

  const headings: Array<Heading> = []
  const usedIds = new Map<string, number>()
  const uniqueId = (text: string) => {
    const slug = slugify(text) || "section"
    const count = usedIds.get(slug) ?? 0
    usedIds.set(slug, count + 1)
    return count === 0 ? slug : `${slug}-${count}`
  }
  const baseless = base.replace(/\/$/, "")
  const linkHref = (href: string) =>
    href.startsWith("/") && !href.startsWith("//") ? `${baseless}${href}` : href

  const anchors = new Set<string>()
  const links: Array<string> = []
  const marked = new Marked({ gfm: true })
  marked.use({
    walkTokens(token) {
      // GitHub's `> [!NOTE]` callouts.
      if (token.type !== "blockquote") return
      const quote = token as Tokens.Blockquote & { callout?: string }
      const first = quote.tokens[0]
      if (first?.type !== "paragraph") return
      const callout =
        /^\[!(NOTE|TIP|WARNING|CAUTION|IMPORTANT)\][ \t]*\n?/.exec(first.text)
      if (!callout) return
      quote.callout = callout[1]?.toLowerCase()
      first.text = first.text.slice(callout[0].length)
      first.tokens = marked.Lexer.lexInline(first.text)
      if (!first.text.trim()) quote.tokens.shift()
    },
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens)
        const text = plainText(inner)
        const level = Math.min(Math.max(depth, 2), 4)
        const id = uniqueId(text)
        anchors.add(id)
        if (level === 2 || level === 3) {
          headings.push({ depth: level, id, text })
        }
        return `<h${level} id="${id}"><a class="heading-anchor" href="#${id}">${inner}</a></h${level}>\n`
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens)
        if (
          href.startsWith("#") ||
          (href.startsWith("/") && !href.startsWith("//"))
        ) {
          links.push(href)
        }
        const external = /^https?:\/\//.test(href)
        const attributes = [
          `href="${escapeAttribute(linkHref(href))}"`,
          title ? `title="${escapeAttribute(title)}"` : "",
          external ? `rel="noreferrer" class="external"` : "",
        ]
        return `<a ${attributes.filter(Boolean).join(" ")}>${inner}</a>`
      },
      blockquote(token) {
        const inner = this.parser.parse(token.tokens)
        const callout = (token as Tokens.Blockquote & { callout?: string })
          .callout
        if (!callout) return `<blockquote>${inner}</blockquote>\n`
        const label = callout.charAt(0).toUpperCase() + callout.slice(1)
        return `<aside class="callout" data-callout="${callout}"><p class="callout-label">${label}</p>${inner}</aside>\n`
      },
      table(token) {
        const header = token.header
          .map(
            (cell, index) =>
              `<th${align(token.align[index])}>${this.parser.parseInline(cell.tokens)}</th>`
          )
          .join("")
        const rows = token.rows
          .map(
            (row) =>
              `<tr>${row
                .map(
                  (cell, index) =>
                    `<td${align(token.align[index])}>${this.parser.parseInline(cell.tokens)}</td>`
                )
                .join("")}</tr>`
          )
          .join("")
        return `<div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table></div>\n`
      },
      code({ text, lang }) {
        const info = lang ?? ""
        const name = (/^\S*/.exec(info)?.[0] ?? "").toLowerCase()
        // ```walkthrough <name>``` marks where an animated walkthrough
        // plays. The page's own steps say the same in words.
        if (name === "walkthrough") {
          return `<figure class="walkthrough" data-walkthrough="${escapeAttribute(text.trim())}"></figure>\n`
        }
        const titleMatch = /title="([^"]*)"/.exec(info)
        const language = languageAliases[name] ?? name
        const highlighted = highlighter.getLoadedLanguages().includes(language)
          ? highlighter.codeToHtml(text, { lang: language, theme: "kiln" })
          : `<pre class="shiki"><code>${escapeHtml(text)}</code></pre>`
        const label = titleMatch?.[1] ?? languageLabel(name)
        return `<figure class="code-block"><figcaption><span>${escapeHtml(label)}</span><button type="button" class="code-copy" data-copy-code aria-label="Copy code">Copy</button></figcaption>${highlighted}</figure>\n`
      },
    },
  })

  const tokens = marked.lexer(body)
  const html = marked.parser(tokens)
  return {
    anchors,
    file,
    links,
    markdown: source,
    page: { description, headings, html, path, source: where, title },
    search: searchEntries({ description, path, title, tokens }),
  }
}

// One entry for the page's opening, then one per `##` and `###` heading.
function searchEntries({
  description,
  path,
  title,
  tokens,
}: {
  description: string
  path: string
  title: string
  tokens: Array<Token>
}): Array<SearchEntry> {
  const entries: Array<SearchEntry> = []
  const usedIds = new Map<string, number>()
  let current: SearchEntry = {
    anchor: "",
    heading: title,
    path,
    text: description,
    title,
  }
  const flush = () => {
    current.text = current.text.replace(/\s+/g, " ").trim().slice(0, 1600)
    entries.push(current)
  }
  for (const token of tokens) {
    if (token.type === "heading") {
      const text = plainText(token.text)
      const slug = slugify(text) || "section"
      const count = usedIds.get(slug) ?? 0
      usedIds.set(slug, count + 1)
      if (token.depth > 3) {
        current.text += ` ${text}`
        continue
      }
      flush()
      current = {
        anchor: count === 0 ? slug : `${slug}-${count}`,
        heading: text,
        path,
        text: "",
        title,
      }
      continue
    }
    current.text += ` ${tokenText(token)}`
  }
  flush()
  return entries
}

function tokenText(token: Token): string {
  switch (token.type) {
    case "code":
      return /^walkthrough\b/.test(token.lang ?? "") ? "" : token.text
    case "space":
    case "hr":
    case "html":
      return ""
    case "table":
      return [
        ...token.header.map((cell: Tokens.TableCell) => cell.text),
        ...token.rows.flat().map((cell: Tokens.TableCell) => cell.text),
      ]
        .map(plainText)
        .join(" ")
    case "list":
      return token.items
        .map((item: Tokens.ListItem) =>
          item.tokens.map((child) => tokenText(child)).join(" ")
        )
        .join(" ")
    case "blockquote":
      return (token as Tokens.Blockquote).tokens
        .map((child: Token) => tokenText(child))
        .join(" ")
        .replace(/\[!(NOTE|TIP|WARNING|CAUTION|IMPORTANT)\]/g, "")
    default:
      return "text" in token && typeof token.text === "string"
        ? plainText(token.text)
        : ""
  }
}

// Markdown or HTML to the words a reader sees.
function plainText(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
}

function align(value: "center" | "left" | "right" | null | undefined) {
  return value ? ` style="text-align:${value}"` : ""
}

function languageLabel(name: string): string {
  if (!name || name === "text" || name === "txt") return "Text"
  if (["sh", "bash", "shell", "zsh", "console"].includes(name))
    return "Terminal"
  if (name === "yml" || name === "yaml") return "YAML"
  if (name === "env" || name === "properties") return "Environment"
  if (name === "json" || name === "jsonc") return "JSON"
  if (name === "ts" || name === "typescript") return "TypeScript"
  if (name === "dockerfile") return "Dockerfile"
  if (name === "sql") return "SQL"
  if (name === "toml") return "TOML"
  return name
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;")
}
