import * as React from "react"
import { Result } from "effect"
import { ExternalLink, ImageOff } from "lucide-react"
import { useLocation } from "@tanstack/react-router"
import ReactMarkdown from "react-markdown"
import type { Components } from "react-markdown"
import remarkGfm from "remark-gfm"

import { FilePageContent } from "@/components/files/file-page-content"
import type { FileTextViewProps } from "@/components/files/file-text-view"
import { imageTypeForPath } from "@/lib/file-media-types"
import { remarkLimitTables } from "@/lib/markdown-limits"
import {
  DocumentImagesContext,
  useDocumentImage,
  useDocumentImages,
} from "@/components/files/markdown-images"

const remarkPlugins = [remarkGfm, remarkLimitTables]

/**
 * A Markdown file rendered from the editor's text, unsaved changes
 * included. Raw HTML is never rendered, links to the document's own files
 * open in the workspace, and images elsewhere on the web aren't fetched.
 */
export function MarkdownPreview({
  displayPath,
  instance,
  onOpenPath,
  path,
  sessionStore,
}: FileTextViewProps) {
  const value = React.useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getValueSnapshot,
    sessionStore.getValueSnapshot
  )
  const source = React.useDeferredValue(value)
  // Where a link to another of the workspace's files goes: its Files page,
  // with the same root open, so a new tab opens what a click does.
  const filesBase = useLocation({
    select: (location) =>
      /^\/(?:server|app|relay)\/[^/]+\/files/u.exec(location.pathname)?.[0] ??
      null,
  })
  const filesSearch = useLocation({ select: (location) => location.searchStr })
  const { id: instanceId, relayId } = instance
  const images = useDocumentImages({ instanceId, path, relayId })
  const components = React.useMemo(
    () =>
      markdownComponents({
        fileHref: (target) =>
          filesBase === null
            ? undefined
            : `${filesBase}/${target.split("/").map(encodeURIComponent).join("/")}${filesSearch}`,
        onOpenPath,
        path,
      }),
    [filesBase, filesSearch, onOpenPath, path]
  )
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <article className="mx-auto max-w-3xl px-5 py-6 text-sm leading-relaxed text-foreground sm:px-8 sm:py-8">
        <DocumentImagesContext value={images}>
          <ReactMarkdown components={components} remarkPlugins={remarkPlugins}>
            {source}
          </ReactMarkdown>
        </DocumentImagesContext>
      </article>
      <FilePageContent path={displayPath} view="markdown" />
    </div>
  )
}

function markdownComponents({
  fileHref,
  onOpenPath,
  path,
}: {
  fileHref: (path: string) => string | undefined
  onOpenPath: (path: string) => void
  path: string
}): Components {
  return {
    a: ({ href, children }) => {
      const target = href ? linkTarget(path, href) : null
      if (!target) return <span className="text-primary-ink">{children}</span>
      if (target.kind === "external") {
        return (
          <a
            className="text-primary-ink underline-offset-2 hover:underline"
            href={target.href}
            rel="noopener noreferrer nofollow"
            target="_blank"
          >
            {children}
          </a>
        )
      }
      if (target.kind === "anchor") {
        return (
          <a
            className="text-primary-ink underline-offset-2 hover:underline"
            href={target.href}
          >
            {children}
          </a>
        )
      }
      return (
        <a
          className="text-primary-ink underline-offset-2 hover:underline"
          href={fileHref(target.path)}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey) return
            event.preventDefault()
            onOpenPath(target.path)
          }}
        >
          {children}
        </a>
      )
    },
    blockquote: ({ children }) => (
      <blockquote className="my-4 border-l-2 border-primary/40 pl-4 text-muted-foreground">
        {children}
      </blockquote>
    ),
    code: ({ children, className }) => (
      <code
        className={
          className
            ? "font-mono text-[0.8125rem]"
            : "border bg-muted/40 px-1 py-0.5 font-mono text-[0.8125rem]"
        }
      >
        {children}
      </code>
    ),
    h1: ({ children }) => (
      <h1 className="mt-2 mb-4 border-b pb-2 text-2xl font-semibold">
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2 className="mt-8 mb-3 border-b pb-1.5 text-xl font-semibold">
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className="mt-6 mb-2 text-base font-semibold">{children}</h3>
    ),
    h4: ({ children }) => (
      <h4 className="mt-5 mb-2 text-sm font-semibold">{children}</h4>
    ),
    h5: ({ children }) => (
      <h5 className="mt-4 mb-2 text-sm font-semibold">{children}</h5>
    ),
    h6: ({ children }) => (
      <h6 className="mt-4 mb-2 text-sm font-semibold text-muted-foreground">
        {children}
      </h6>
    ),
    hr: () => <hr className="my-6 border-border" />,
    img: ({ alt, src }) => (
      <DocumentImage
        alt={alt ?? ""}
        fileHref={fileHref}
        onOpenPath={onOpenPath}
        path={path}
        src={typeof src === "string" ? src : ""}
      />
    ),
    input: ({ checked, type }) =>
      type === "checkbox" ? (
        <input
          type="checkbox"
          checked={checked ?? false}
          className="mr-1.5 align-middle"
          disabled
          readOnly
        />
      ) : null,
    li: ({ children }) => <li className="my-1">{children}</li>,
    ol: ({ children }) => (
      <ol className="my-3 list-decimal space-y-1 pl-6">{children}</ol>
    ),
    p: ({ children }) => <p className="my-3">{children}</p>,
    pre: ({ children }) => (
      <pre className="my-4 overflow-x-auto border bg-muted/30 p-3 leading-snug">
        {children}
      </pre>
    ),
    table: ({ children }) => (
      <div className="my-4 overflow-x-auto">
        <table className="w-full border-collapse text-left text-xs">
          {children}
        </table>
      </div>
    ),
    td: ({ children }) => (
      <td className="border px-3 py-1.5 align-top">{children}</td>
    ),
    th: ({ children }) => (
      <th className="border bg-muted/30 px-3 py-1.5 font-semibold">
        {children}
      </th>
    ),
    ul: ({ children, className }) => (
      <ul
        className={
          className?.includes("contains-task-list")
            ? "my-3 space-y-1 pl-1"
            : "my-3 list-disc space-y-1 pl-6"
        }
      >
        {children}
      </ul>
    ),
  }
}

function DocumentImage({
  alt,
  fileHref,
  onOpenPath,
  path,
  src,
}: {
  alt: string
  fileHref: (path: string) => string | undefined
  onOpenPath: (path: string) => void
  path: string
  src: string
}) {
  const target = src ? linkTarget(path, src) : null
  const own = target?.kind === "workspace" ? target.path : null
  const type = own ? imageTypeForPath(own) : undefined
  const image = useDocumentImage(own && type ? own : null, type)
  if (own && type && image?.status === "ready") {
    return (
      <img alt={alt} className="my-2 inline-block max-w-full" src={image.url} />
    )
  }
  if (own && type && (!image || image.status === "loading")) {
    return (
      <span className="my-2 inline-block h-24 w-40 animate-pulse bg-muted/40" />
    )
  }
  // Images from elsewhere would tell that site who reads the document, and
  // a document's own past its budget are only linked.
  return (
    <span className="my-1 inline-flex max-w-full items-center gap-1.5 border border-dashed px-2 py-1 align-middle text-xs text-muted-foreground">
      <ImageOff className="size-3.5 shrink-0" />
      <span className="truncate">{alt || "Image"}</span>
      {target?.kind === "external" ? (
        <a
          className="inline-flex shrink-0 items-center gap-1 text-primary-ink hover:underline"
          href={target.href}
          rel="noopener noreferrer nofollow"
          target="_blank"
        >
          Open
          <ExternalLink className="size-3" />
        </a>
      ) : own ? (
        <a
          className="shrink-0 text-primary-ink hover:underline"
          href={fileHref(own)}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey) return
            event.preventDefault()
            onOpenPath(own)
          }}
        >
          Open
        </a>
      ) : null}
    </span>
  )
}

type LinkTarget =
  | { readonly kind: "anchor"; readonly href: string }
  | { readonly kind: "external"; readonly href: string }
  | { readonly kind: "workspace"; readonly path: string }

/**
 * Where a document's link leads: a page on the web, a heading in the
 * document, or another of the workspace's files, resolved against the
 * document's folder. Null for a link that leaves the workspace's root.
 */
function linkTarget(documentPath: string, href: string): LinkTarget | null {
  if (href.startsWith("#")) return { kind: "anchor", href }
  if (/^[a-z][a-z\d+.-]*:/iu.test(href) || href.startsWith("//")) {
    return /^(?:https?|mailto):/iu.test(href)
      ? { kind: "external", href }
      : null
  }
  const pathPart = href.split(/[?#]/u, 1)[0] ?? ""
  if (!pathPart) return null
  const segments = pathPart.startsWith("/")
    ? []
    : documentPath.split("/").filter(Boolean).slice(0, -1)
  for (const encoded of pathPart.split("/")) {
    if (!encoded || encoded === ".") continue
    const segment = Result.getOrElse(
      Result.try(() => decodeURIComponent(encoded)),
      () => encoded
    )
    if (segment === "..") {
      if (!segments.length) return null
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  if (!segments.length) return null
  return {
    kind: "workspace",
    path: segments.join("/") + (pathPart.endsWith("/") ? "/" : ""),
  }
}
