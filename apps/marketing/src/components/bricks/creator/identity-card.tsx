import * as React from "react"
import {
  Box,
  Cpu,
  Gamepad2,
  Hash,
  Link2,
  Pencil,
  Plus,
  RotateCcw,
  Tags,
  X,
} from "lucide-react"

import type { BrickV2, BrickV2Kind, BrickV2Links } from "@workspace/contracts"
import { Button } from "@workspace/ui/components/button"
import { ColorPicker } from "@workspace/ui/components/color-picker"
import { Input } from "@workspace/ui/components/input"
import { cn } from "@workspace/ui/lib/utils"

import { BRICK_COLOR_PALETTE } from "@/components/brick-icon"

import {
  LinkIcon,
  linkKinds,
  linkLabels,
} from "~/components/bricks/attribution"
import { BrickGlyph, brickColorFor } from "~/components/bricks/brick-glyph"
import { BrickKindIcon } from "~/components/bricks/kind-icon"
import {
  useIssue,
  useIssueCount,
} from "~/components/bricks/creator/creator-fields"
import {
  CreatorPopover,
  useCreatorPopoverIsDrawer,
} from "~/components/bricks/creator/creator-popover"
import {
  changeKind,
  fieldDomId,
  kindLabels,
} from "~/components/bricks/creator/creator-state"
import type { Edit } from "~/components/bricks/creator/creator-edit"
import { useSetter } from "~/components/bricks/creator/creator-edit"
import { brickIconUrl, catalogTags, officialIcons } from "~/lib/bricks"

const kinds: ReadonlyArray<BrickV2Kind> = ["game-server", "app", "database"]

function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64)
}

// Who the Brick is: its mark, name, line, kind, and the details around them.
// Everything edits in place or in a small popover, so it stays one section.
export const IdentityCard = React.memo(function IdentityCard({
  author,
  color,
  edit,
  game,
  icon,
  id,
  kind,
  links,
  name,
  platforms,
  summary,
  tags,
}: {
  author: string | undefined
  color: string | undefined
  edit: Edit
  game: string | undefined
  icon: string | undefined
  id: string | undefined
  kind: BrickV2Kind
  links: BrickV2Links | undefined
  name: string | undefined
  platforms: BrickV2["platforms"]
  summary: string | undefined
  tags: ReadonlyArray<string> | undefined
}) {
  const set = useSetter(edit)
  const onName = React.useCallback(
    (next: string) =>
      edit((brick) => ({
        ...brick,
        name: next,
        // The id follows the name until it's given one of its own.
        id:
          !brick.id || brick.id === slug(brick.name ?? "")
            ? slug(next)
            : brick.id,
      })),
    [edit]
  )
  const nameIssue = useIssue("name")
  const summaryIssue = useIssue("summary")

  return (
    <section aria-label="Basics" className="flex flex-col gap-3 p-4">
      <div className="flex gap-4">
        <IconPicker
          color={color}
          icon={icon}
          id={id || "brick"}
          onColor={set("color")}
          onIcon={set("icon")}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-start gap-4">
            <input
              id={fieldDomId("name")}
              aria-label="Name"
              aria-invalid={nameIssue ? true : undefined}
              value={name ?? ""}
              placeholder="Name your Brick"
              onChange={(event) => onName(event.target.value)}
              className="-mx-1 min-w-0 flex-1 border-b border-transparent bg-transparent px-1 font-heading text-[1.625rem] leading-tight font-semibold tracking-[-0.035em] transition-colors outline-none placeholder:text-muted-foreground/50 hover:border-border focus:border-primary aria-invalid:border-destructive/60"
            />
            <KindSwitch
              className="mt-0.5 hidden sm:flex"
              kind={kind}
              onChange={(next) => edit((brick) => changeKind(brick, next))}
            />
          </div>
          <input
            id={fieldDomId("summary")}
            aria-label="Summary"
            aria-invalid={summaryIssue ? true : undefined}
            value={summary ?? ""}
            placeholder="One line on what it runs"
            onChange={(event) => set("summary")(event.target.value)}
            className="-mx-1 mt-1 min-w-0 border-b border-transparent bg-transparent px-1 text-[0.9375rem] text-muted-foreground transition-colors outline-none placeholder:text-muted-foreground/45 hover:border-border focus:border-primary focus:text-foreground aria-invalid:border-destructive/60"
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <IdChip id={id} onChange={set("id")} />
        <AttributionPopover
          author={author}
          links={links}
          onAuthor={set("author")}
          onLink={(key, value) => set("links", key)(value)}
        />
        {kind === "game-server" ? (
          <GamePopover game={game} onChange={set("game")} />
        ) : null}
        <TagsPopover tags={tags} onChange={set("tags")} />
        <PlatformsPopover platforms={platforms} onChange={set("platforms")} />
      </div>
      <KindSwitch
        className="sm:hidden [&>button]:flex-1 [&>button]:justify-center"
        kind={kind}
        onChange={(next) => edit((brick) => changeKind(brick, next))}
      />
    </section>
  )
})

// Game server, app, or database. Inactive kinds show only their icon where
// there's little room.
function KindSwitch({
  className,
  kind,
  onChange,
}: {
  className?: string
  kind: BrickV2Kind
  onChange: (kind: BrickV2Kind) => void
}) {
  return (
    <div
      role="group"
      aria-label="Kind"
      className={cn(
        "flex shrink-0 border border-border bg-background p-0.5",
        className
      )}
    >
      {kinds.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={kind === option}
          title={kindLabels[option]}
          onClick={() => onChange(option)}
          className="type-control-sm flex h-7 items-center gap-1.5 px-2 text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset active:bg-accent/60 aria-pressed:bg-accent aria-pressed:text-foreground"
        >
          <BrickKindIcon kind={option} className="size-3.5" />
          <span
            className={cn(
              kind === option
                ? "inline"
                : "sr-only sm:not-sr-only lg:sr-only xl:not-sr-only"
            )}
          >
            {kindLabels[option]}
          </span>
        </button>
      ))}
    </div>
  )
}

function IconPicker({
  color,
  icon,
  id,
  onColor,
  onIcon,
}: {
  color: string | undefined
  icon: string | undefined
  id: string
  onColor: (color: string | undefined) => void
  onIcon: (icon: string | undefined) => void
}) {
  const iconUrl = brickIconUrl(icon)
  const resolved = color ?? brickColorFor(id)
  const issues = useIssueCount("icon,color")
  const [link, setLink] = React.useState("")
  const customLink =
    icon &&
    !officialIcons.some((entry) => entry.link === icon) &&
    !icon.startsWith("../")
      ? icon
      : ""

  return (
    <CreatorPopover
      title="Icon and color"
      className="w-80 p-0"
      onOpenChange={(open) => open && setLink(customLink)}
      trigger={
        <button
          type="button"
          aria-label="Change icon and color"
          id={fieldDomId("icon")}
          className={cn(
            "group relative grid size-16 shrink-0 place-items-center border transition-[border-color,transform] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 active:scale-[0.98] sm:size-[4.5rem]",
            issues > 0 && "ring-1 ring-destructive/60"
          )}
          style={{
            backgroundColor: `color-mix(in oklab, ${resolved} 14%, transparent)`,
            borderColor: `color-mix(in oklab, ${resolved} 32%, transparent)`,
          }}
        >
          <BrickGlyph
            className="size-8 sm:size-9"
            color={resolved}
            iconUrl={iconUrl}
            id={id}
          />
          <span className="absolute right-0 bottom-0 grid size-5 translate-x-1/3 translate-y-1/3 place-items-center border border-border bg-background text-muted-foreground transition-colors group-hover:text-foreground group-focus-visible:text-foreground">
            <Pencil className="size-2.5" />
          </span>
        </button>
      }
    >
      <div className="p-3">
        <p className="type-label mb-2 text-muted-foreground">Icon</p>
        <div className="grid grid-cols-8 gap-1">
          <IconChoice
            active={!icon}
            label="No icon"
            onClick={() => onIcon(undefined)}
          >
            <Box className="size-4" style={{ color: resolved }} />
          </IconChoice>
          {officialIcons.map((entry) => (
            <IconChoice
              key={entry.name}
              active={
                icon === entry.link || icon === `../icons/${entry.name}.svg`
              }
              label={entry.name}
              onClick={() => onIcon(entry.link)}
            >
              <BrickGlyph
                className="size-4"
                color={resolved}
                iconUrl={entry.url}
                id={id}
              />
            </IconChoice>
          ))}
        </div>
        <label className="type-label mt-3 mb-1.5 block text-muted-foreground">
          Or link your own SVG
        </label>
        <div className="flex gap-1.5">
          <Input
            value={link}
            placeholder="https://…/icon.svg"
            spellCheck={false}
            onChange={(event) => setLink(event.target.value)}
            className="h-8 font-mono text-sm"
          />
          <Button
            variant="outline"
            disabled={!/^https:\/\/\S+$/iu.test(link)}
            onClick={() => onIcon(link)}
          >
            Use
          </Button>
        </div>
        <p className="type-meta mt-1.5 text-muted-foreground">
          Square, one colour, no text. Kiln tints it.
        </p>
      </div>
      <div className="border-t border-border p-3">
        <p className="type-label mb-2 text-muted-foreground">Color</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            aria-label="Automatic color"
            aria-pressed={!color}
            onClick={() => onColor(undefined)}
            className="grid size-7 place-items-center border border-dashed border-border text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 aria-pressed:border-primary aria-pressed:text-foreground"
          >
            <RotateCcw className="size-3.5" />
          </button>
          {BRICK_COLOR_PALETTE.map((swatch) => (
            <button
              key={swatch}
              type="button"
              aria-label={swatch}
              aria-pressed={color?.toLowerCase() === swatch}
              onClick={() => onColor(swatch)}
              className="size-7 border-2 border-transparent transition-transform outline-none hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring/60 aria-pressed:border-foreground"
              style={{ backgroundColor: swatch }}
            />
          ))}
          <ColorPicker defaultValue={resolved} onValueChange={onColor}>
            <button
              type="button"
              aria-label="Custom color"
              className="size-7 border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              style={{
                background:
                  "conic-gradient(#e67e7e, #c49528, #6aa54f, #4b98b0, #7763a3, #e67e7e)",
              }}
            />
          </ColorPicker>
        </div>
      </div>
    </CreatorPopover>
  )
}

function IconChoice({
  active,
  children,
  label,
  onClick,
}: {
  active: boolean
  children: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className="grid aspect-square place-items-center border border-transparent transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 aria-pressed:border-primary aria-pressed:bg-accent"
    >
      {children}
    </button>
  )
}

const chipClassName =
  "type-label inline-flex h-7 max-w-full items-center gap-1.5 border border-border bg-background px-2 text-muted-foreground transition-colors outline-none hover:border-primary/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 active:bg-accent/60 aria-expanded:border-primary/40 aria-expanded:bg-accent/60 aria-expanded:text-foreground data-[invalid=true]:border-destructive/60 data-[invalid=true]:text-destructive"

// A field that takes focus when its popover opens on desktop. On a phone the
// drawer opens without raising the keyboard.
function FocusInput(props: React.ComponentProps<typeof Input>) {
  const drawer = useCreatorPopoverIsDrawer()
  return <Input autoFocus={!drawer} {...props} />
}

function IdChip({
  id,
  onChange,
}: {
  id: string | undefined
  onChange: (id: string) => void
}) {
  const issue = useIssue("id")
  return (
    <CreatorPopover
      title="Id"
      className="w-72"
      trigger={
        <button
          type="button"
          id={fieldDomId("id")}
          data-invalid={issue ? true : undefined}
          className={cn(chipClassName, "font-mono")}
        >
          <Hash className="size-3" />
          <span className="truncate">{id || "no-id"}</span>
        </button>
      }
    >
      <label className="type-label mb-1.5 block">Id</label>
      <FocusInput
        value={id ?? ""}
        spellCheck={false}
        aria-invalid={issue ? true : undefined}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 font-mono text-sm"
      />
      <p
        className={cn(
          "type-meta mt-1.5",
          issue ? "text-destructive" : "text-muted-foreground"
        )}
      >
        {issue ??
          "Lowercase letters, numbers, and dashes. It follows the name until you change it."}
      </p>
    </CreatorPopover>
  )
}

function AttributionPopover({
  author,
  links,
  onAuthor,
  onLink,
}: {
  author: string | undefined
  links: BrickV2Links | undefined
  onAuthor: (author: string) => void
  onLink: (key: keyof BrickV2Links, value: string | undefined) => void
}) {
  const issues = useIssueCount("author,links")
  const authorIssue = useIssue("author")
  const set = linkKinds.filter((kind) => links?.[kind])
  return (
    <CreatorPopover
      title="Attribution"
      className="w-80"
      trigger={
        <button
          type="button"
          id={fieldDomId("author")}
          data-invalid={issues > 0 ? true : undefined}
          className={chipClassName}
        >
          by{" "}
          <span className="truncate text-foreground">
            {author || "someone"}
          </span>
          {set.length > 0 ? (
            <span className="ml-0.5 flex items-center gap-1 border-l border-border pl-1.5">
              {set.map((kind) => (
                <LinkIcon
                  key={kind}
                  kind={kind}
                  href={links?.[kind]}
                  className="size-3"
                />
              ))}
            </span>
          ) : (
            <Link2 className="size-3" />
          )}
        </button>
      }
    >
      <p className="type-section-title">Attribution</p>
      <p className="type-meta mb-3 text-muted-foreground">
        Who made it, and where people find more.
      </p>
      <label className="type-label mb-1.5 block">Author</label>
      <Input
        value={author ?? ""}
        placeholder="Your name or team"
        aria-invalid={authorIssue ? true : undefined}
        onChange={(event) => onAuthor(event.target.value)}
        className="h-8 text-sm"
      />
      <div className="mt-3 flex flex-col gap-1.5">
        {linkKinds.map((kind) => (
          <LinkRow
            key={kind}
            kind={kind}
            value={links?.[kind]}
            onChange={(value) => onLink(kind, value)}
          />
        ))}
      </div>
    </CreatorPopover>
  )
}

function LinkRow({
  kind,
  onChange,
  value,
}: {
  kind: keyof BrickV2Links
  onChange: (value: string | undefined) => void
  value: string | undefined
}) {
  const issue = useIssue(`links.${kind}`)
  return (
    <label className="flex items-center gap-2">
      <span className="type-label flex w-20 shrink-0 items-center gap-1.5 text-muted-foreground">
        <LinkIcon kind={kind} href={value} className="size-3.5" />
        {linkLabels[kind]}
      </span>
      <Input
        value={value ?? ""}
        placeholder="https://"
        spellCheck={false}
        aria-invalid={issue ? true : undefined}
        title={issue}
        onChange={(event) => onChange(event.target.value || undefined)}
        className="h-8 font-mono text-xs"
      />
    </label>
  )
}

function GamePopover({
  game,
  onChange,
}: {
  game: string | undefined
  onChange: (game: string) => void
}) {
  const issue = useIssue("game")
  return (
    <CreatorPopover
      title="Game"
      className="w-64"
      trigger={
        <button
          type="button"
          id={fieldDomId("game")}
          data-invalid={issue ? true : undefined}
          className={chipClassName}
        >
          <Gamepad2 className="size-3.5" />
          <span className="truncate">{game || "Which game?"}</span>
        </button>
      }
    >
      <label className="type-label mb-1.5 block">Game</label>
      <FocusInput
        value={game ?? ""}
        placeholder="Minecraft"
        onChange={(event) => onChange(event.target.value)}
        className="h-8 text-sm"
      />
      <p className="type-meta mt-1.5 text-muted-foreground">
        Groups it with other servers for the same game, and names its DNS
        record.
      </p>
    </CreatorPopover>
  )
}

function TagsPopover({
  onChange,
  tags,
}: {
  onChange: (tags: Array<string> | undefined) => void
  tags: ReadonlyArray<string> | undefined
}) {
  const [draft, setDraft] = React.useState("")
  const list = tags ?? []
  const add = (tag: string) => {
    const clean = slug(tag).slice(0, 32)
    if (!clean || list.includes(clean)) return
    onChange([...list, clean])
    setDraft("")
  }
  const remove = (tag: string) => {
    const next = list.filter((entry) => entry !== tag)
    onChange(next.length > 0 ? next : undefined)
  }
  const query = slug(draft)
  const suggestions = catalogTags
    .filter((tag) => !list.includes(tag) && tag.includes(query))
    .slice(0, 12)

  return (
    <CreatorPopover
      title="Tags"
      className="w-72 p-2"
      trigger={
        <button
          type="button"
          id={fieldDomId("tags")}
          className={cn(chipClassName, "max-w-64")}
        >
          <Tags className="size-3.5 shrink-0" />
          <span className="truncate">
            {list.length === 0 ? "Add tags" : list.join(", ")}
          </span>
        </button>
      }
    >
      {list.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1">
          {list.map((tag) => (
            <span
              key={tag}
              className="type-label inline-flex h-6 items-center gap-0.5 border border-primary/30 bg-primary/10 pr-0.5 pl-1.5 text-foreground"
            >
              {tag}
              <button
                type="button"
                aria-label={`Remove ${tag}`}
                onClick={() => remove(tag)}
                className="grid size-5 place-items-center text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <FocusInput
        value={draft}
        placeholder="Add a tag"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault()
            add(draft)
          }
        }}
        className="h-8 text-sm"
      />
      <div className="mt-2 flex max-h-40 flex-wrap gap-1 overflow-y-auto">
        {query && !list.includes(query) && !catalogTags.includes(query) ? (
          <button
            type="button"
            onClick={() => add(query)}
            className="type-label inline-flex h-6 items-center gap-1 border border-primary/40 px-1.5 text-primary-ink outline-none hover:bg-primary/10"
          >
            <Plus className="size-3" />
            {query}
          </button>
        ) : null}
        {suggestions.map((tag) => (
          <button
            key={tag}
            type="button"
            onClick={() => add(tag)}
            className="type-label inline-flex h-6 items-center border border-border px-1.5 text-muted-foreground outline-none hover:border-primary/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {tag}
          </button>
        ))}
      </div>
      <p className="type-meta mt-2 text-muted-foreground">
        {list.length} of 12. Enter adds one.
      </p>
    </CreatorPopover>
  )
}

function PlatformsPopover({
  onChange,
  platforms,
}: {
  onChange: (platforms: BrickV2["platforms"]) => void
  platforms: BrickV2["platforms"]
}) {
  const label =
    !platforms || platforms.length === 2 ? "Any CPU" : `${platforms[0]} only`
  const toggle = (platform: "amd64" | "arm64", on: boolean) => {
    const current = new Set(platforms ?? ["amd64", "arm64"])
    if (on) current.add(platform)
    else current.delete(platform)
    const next = (["amd64", "arm64"] as const).filter((entry) =>
      current.has(entry)
    )
    onChange(next.length === 2 || next.length === 0 ? undefined : next)
  }
  return (
    <CreatorPopover
      title="Runs on"
      align="end"
      className="w-60"
      trigger={
        <button type="button" className={cn(chipClassName, "sm:ml-auto")}>
          <Cpu className="size-3.5" />
          {label}
        </button>
      }
    >
      <p className="type-label mb-2">Runs on</p>
      {(["amd64", "arm64"] as const).map((platform) => (
        <label
          key={platform}
          className="type-support flex items-center gap-2 py-1"
        >
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={!platforms || platforms.includes(platform)}
            onChange={(event) => toggle(platform, event.target.checked)}
          />
          <code className="type-code">{platform}</code>
          <span className="type-meta text-muted-foreground">
            {platform === "amd64"
              ? "Intel and AMD"
              : "ARM, like Apple and Ampere"}
          </span>
        </label>
      ))}
    </CreatorPopover>
  )
}
