import * as React from "react"
import { createLink } from "@tanstack/react-router"
import {
  ArrowRight,
  Check,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  Info,
  Trash2,
} from "lucide-react"

import { Button, buttonVariants } from "@workspace/ui/components/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import { DangerZone } from "@/components/info-card"
import { useCopyFeedback } from "@/components/workspace-header"

// Building blocks for Info pages: sections of facts in the main column and a
// rail on the right that sums up what the resource is. Rarely needed values
// sit behind popovers.

export function InfoPage({
  children,
  rail,
}: {
  children: React.ReactNode
  rail: React.ReactNode
}) {
  const pageRef = React.useRef<HTMLElement>(null)
  const railRef = React.useRef<HTMLDivElement>(null)
  // The rail sticks to the top of the page as it scrolls. A rail taller than
  // the page scrolls with it until its end is in view, then sticks there.
  // Set on the element, so resizes don't render.
  React.useEffect(() => {
    const page = pageRef.current
    const railElement = railRef.current
    if (!page || !railElement) return
    const observer = new ResizeObserver(() => {
      const top = Math.min(0, page.clientHeight - railElement.offsetHeight)
      railElement.style.top = `${top}px`
    })
    observer.observe(page)
    observer.observe(railElement)
    return () => observer.disconnect()
  }, [])
  return (
    <section ref={pageRef} className="min-h-0 flex-1 overflow-y-auto bg-card">
      <div className="grid min-h-full lg:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="flex min-w-0 flex-col gap-4 px-5 py-6 sm:px-7">
          {children}
        </div>
        {/* Rail labels are short, so they take only their width and leave the
            rest to values. */}
        <aside className="min-w-0 border-t bg-background/30 lg:border-t-0 lg:border-l [&_dt]:min-w-0">
          <div ref={railRef} className="top-0 px-4 py-6 lg:sticky">
            {rail}
          </div>
        </aside>
      </div>
    </section>
  )
}

// A titled group of facts, with its actions in the header.
export function InfoSection({
  action,
  children,
  content = false,
  icon,
  status,
  title,
}: {
  action?: React.ReactNode
  // Left out when the header says it all, such as actions alone.
  children?: React.ReactNode
  // Holds something other than facts, such as a drop zone; "flush" runs it
  // to the section's edges, such as a table.
  content?: boolean | "flush"
  icon?: React.ReactNode
  // Beside the title, such as a status indicator.
  status?: React.ReactNode
  title: string
}) {
  return (
    <section className="min-w-0 border bg-background/45">
      {/* On narrow screens, actions that don't fit beside the title wrap
          below it rather than squeezing it out. */}
      <header
        className={cn(
          "flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2",
          children != null && "border-b"
        )}
      >
        <h3 className="flex shrink-0 items-center gap-2 text-sm font-semibold [&_svg]:size-4 [&_svg]:shrink-0 [&_svg:not([class*='text-'])]:text-muted-foreground">
          {icon}
          <span>{title}</span>
        </h3>
        {status}
        {action ? (
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            {action}
          </div>
        ) : null}
      </header>
      {children == null ? null : content === "flush" ? (
        <div className="min-w-0">{children}</div>
      ) : content ? (
        <div className="p-4">{children}</div>
      ) : (
        <dl className="@container px-4">{children}</dl>
      )}
    </section>
  )
}

// What the resource is, as a profile: its icon, which those who may change
// it click to, its name and Kiln ID, and its actions, such as Rename. Facts
// about it follow below.
export function InfoProfile({
  actions,
  children,
  icon,
  id,
  idLabel,
  name,
}: {
  actions?: React.ReactNode
  children?: React.ReactNode
  icon: React.ReactNode
  id: string
  // Lowercase noun, for example "server ID".
  idLabel: string
  name: string
}) {
  return (
    <section className="min-w-0 border bg-background/45">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-3 p-4">
        {icon}
        <div className="min-w-0 flex-1 basis-40">
          <h3
            className="truncate font-heading text-lg font-semibold tracking-[-0.02em]"
            title={name}
          >
            {name}
          </h3>
          <div className="type-meta mt-1 flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <span className="shrink-0">Kiln ID</span>
            <InfoCopyValue
              className="text-muted-foreground"
              display={id.slice(0, 12)}
              label={idLabel}
              value={id}
            />
          </div>
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {actions}
          </div>
        ) : null}
      </header>
      {children == null ? null : (
        <dl className="@container border-t px-4">{children}</dl>
      )}
    </section>
  )
}

// A section action that opens the page where more of it changes, such as
// Network.
const InfoSectionLinkAnchor = React.forwardRef<
  HTMLAnchorElement,
  React.ComponentPropsWithoutRef<"a">
>(function InfoSectionLinkAnchor({ children, className, ...props }, ref) {
  return (
    <a
      ref={ref}
      {...props}
      className={cn(
        buttonVariants({ size: "sm", variant: "outline" }),
        className
      )}
    >
      {children}
      <ArrowRight />
    </a>
  )
})

export const InfoSectionLink = createLink(InfoSectionLinkAnchor)

export function InfoFact({
  children,
  label,
}: {
  children: React.ReactNode
  label: string
}) {
  return (
    <div className="flex min-h-10 items-center gap-3 border-b border-border/60 py-1.5 text-[0.8125rem] last:border-b-0">
      <dt className="min-w-28 shrink-0 whitespace-nowrap text-muted-foreground">
        {label}
      </dt>
      <dd className="flex min-w-0 flex-1 items-center justify-end gap-1.5 text-right">
        {children}
      </dd>
    </div>
  )
}

// Two InfoFacts side by side when their section has room, stacked when it
// doesn't.
export function InfoFactPair({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b border-border/60 last:border-b-0 @lg:grid @lg:grid-cols-2 @lg:gap-x-8 [&>div]:border-b-0 @lg:[&>div]:min-w-0 @max-lg:[&>div:first-child]:border-b">
      {children}
    </div>
  )
}

// A fact value that opens the details behind it.
export function InfoDetails({
  children,
  title,
  trigger,
}: {
  children: React.ReactNode
  title: string
  trigger: React.ReactNode
}) {
  return (
    <Popover>
      <PopoverTrigger className="min-w-0 truncate border-b border-dashed border-muted-foreground/45 transition-colors outline-none hover:border-primary focus-visible:border-primary data-[state=open]:border-primary">
        {trigger}
      </PopoverTrigger>
      <InfoDetailsContent title={title}>{children}</InfoDetailsContent>
    </Popover>
  )
}

// An info icon that opens an explanation, for labels rather than values.
export function InfoHint({
  children,
  label,
  title,
}: {
  children: React.ReactNode
  // What the icon explains, for screen readers: "About this proxy mode".
  label: string
  title: string
}) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        className="grid size-5 shrink-0 place-items-center text-muted-foreground/70 transition-colors outline-none hover:text-primary-ink focus-visible:text-primary-ink data-[state=open]:text-primary-ink light:text-muted-foreground/85"
      >
        <Info className="size-3.5" />
      </PopoverTrigger>
      <InfoDetailsContent title={title}>{children}</InfoDetailsContent>
    </Popover>
  )
}

export function InfoDetailsContent({
  children,
  title,
}: {
  children: React.ReactNode
  title: string
}) {
  return (
    <PopoverContent align="end" sideOffset={8} className="w-80 text-xs">
      <p className="font-semibold text-foreground">{title}</p>
      <div className="mt-2 flex flex-col gap-2 leading-relaxed text-muted-foreground">
        {children}
      </div>
    </PopoverContent>
  )
}

export function InfoDetailRow({
  label,
  value,
}: {
  label: string
  value: React.ReactNode
}) {
  return (
    <div className="flex justify-between gap-4">
      <span className="shrink-0">{label}</span>
      <span className="min-w-0 text-right font-mono break-all text-foreground">
        {value}
      </span>
    </div>
  )
}

export function InfoCopyValue({
  className,
  display,
  label,
  mono = true,
  value,
}: {
  // Such as a quieter hover where the value isn't a link-like accent.
  className?: string
  // Shown in place of a value too long to read in the row, such as "Copy
  // path"; the value is still what's copied, and shows on hover.
  display?: string
  // Lowercase noun, for example "Relay address".
  label: string
  // Identifiers and addresses are monospaced; names aren't.
  mono?: boolean
  value: string
}) {
  const { copied, copy } = useCopyFeedback(value)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`Copy ${label} ${value}`}
          className={cn(
            "flex min-w-0 items-center gap-1.5 transition-colors",
            mono && "font-mono text-xs",
            copied
              ? "text-emerald-400 light:text-emerald-700"
              : "hover:text-primary-ink",
            !copied && className
          )}
          onClick={() => void copy()}
        >
          <span className="truncate" title={value}>
            {display ?? value}
          </span>
          {copied ? (
            <Check className="size-3 shrink-0" />
          ) : (
            <Copy className="size-3 shrink-0 opacity-55" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {copied ? `${capitalize(label)} copied` : `Copy ${label}`}
      </TooltipContent>
    </Tooltip>
  )
}

// The Danger zone at the bottom of an Info page, or after the sections when
// they're taller, holding InfoDangerActions.
export function InfoDangerZone({ children }: { children: React.ReactNode }) {
  return (
    <DangerZone
      className="mt-auto"
      action={
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {children}
        </div>
      }
    />
  )
}

// A Danger zone button and the dialog it opens, mounted only while open.
export function InfoDangerAction({
  children,
  dialog,
  disabledReason,
  icon = <Trash2 />,
}: {
  // The button's label, such as "Delete server".
  children: string
  dialog: (onOpenChange: (open: boolean) => void) => React.ReactNode
  // Why the action can't run right now, such as a disconnected Relay.
  disabledReason?: string
  icon?: React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button
        type="button"
        variant="destructive"
        disabled={Boolean(disabledReason)}
        title={disabledReason}
        onClick={() => setOpen(true)}
      >
        {icon}
        {children}
      </Button>
      {open ? dialog(setOpen) : null}
    </>
  )
}

// A secret, masked until revealed, that copies without being revealed.
export function InfoSecretValue({
  label,
  masked,
  value,
}: {
  // Lowercase noun, for example "password".
  label: string
  // Shown in place of the value, such as dots, or a URL with its password
  // dotted out.
  masked: string
  value: string
}) {
  const [revealed, setRevealed] = React.useState(false)
  const { copied, copy } = useCopyFeedback(value)
  return (
    <>
      <span
        className={cn(
          "min-w-0 truncate font-mono text-xs",
          !revealed && "text-muted-foreground"
        )}
        title={revealed ? value : undefined}
      >
        {revealed ? value : masked}
      </span>
      <InfoIconButton
        label={revealed ? `Hide ${label}` : `Reveal ${label}`}
        pressed={revealed}
        onClick={() => setRevealed((current) => !current)}
      >
        {revealed ? <EyeOff /> : <Eye />}
      </InfoIconButton>
      <InfoIconButton
        label={copied ? `${capitalize(label)} copied` : `Copy ${label}`}
        tone={copied ? "success" : undefined}
        onClick={() => void copy()}
      >
        {copied ? <Check /> : <Copy />}
      </InfoIconButton>
    </>
  )
}

function InfoIconButton({
  children,
  label,
  onClick,
  pressed,
  tone,
}: {
  children: React.ReactNode
  label: string
  onClick: () => void
  pressed?: boolean
  tone?: "success"
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={pressed}
          className={cn(
            "grid size-6 shrink-0 place-items-center transition-colors outline-none focus-visible:text-primary-ink [&_svg]:size-3.5",
            tone === "success"
              ? "text-emerald-400 light:text-emerald-700"
              : "text-muted-foreground hover:text-primary-ink"
          )}
          onClick={onClick}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`
}

// Rows in a card take its padding rather than lining up with the rail.
const InfoRailInCardContext = React.createContext(false)

export function InfoRailGroup({
  card = false,
  children,
  title,
}: {
  // Boxes the rows in a card, divided by rules.
  card?: boolean
  children: React.ReactNode
  // Left out when the rows say what they are, such as a list of links.
  title?: string
}) {
  return (
    <section className="mt-6 first:mt-0">
      {title ? (
        <h3 className="type-technical-label mb-1 text-muted-foreground/80 light:text-muted-foreground/90">
          {title}
        </h3>
      ) : null}
      {card ? (
        <div className="divide-y divide-border/60 border bg-background/45">
          <InfoRailInCardContext.Provider value>
            {children}
          </InfoRailInCardContext.Provider>
        </div>
      ) : (
        children
      )}
    </section>
  )
}

const infoRailRowClassName =
  "group flex min-w-0 items-center gap-2.5 text-[0.8125rem]"
const infoRailRowSpacing = {
  card: "px-3 py-2.5",
  rail: "-mx-2 px-2 py-1.5",
}
const infoRailLinkClassName =
  "transition-colors outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"

function useInfoRailRowClassName() {
  return cn(
    infoRailRowClassName,
    React.useContext(InfoRailInCardContext)
      ? infoRailRowSpacing.card
      : infoRailRowSpacing.rail
  )
}

// A row in a rail group: what leads it, such as a count, then its label, a
// detail, and an action on the right.
function InfoRailRowContent({
  action,
  children,
  detail,
  leading,
}: {
  action?: React.ReactNode
  children: React.ReactNode
  detail?: React.ReactNode
  leading: React.ReactNode
}) {
  const inCard = React.useContext(InfoRailInCardContext)
  return (
    <>
      <span className="flex w-6 shrink-0 items-center font-semibold tabular-nums [&_svg]:size-3.5 [&_svg:not([class*='text-'])]:text-muted-foreground">
        {leading}
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground transition-colors group-hover:text-foreground">
        {children}
      </span>
      {/* Inset as far as an action's padding, so details and actions in a
          group end in line. */}
      {/* In a card, the detail is the row's count, such as how many backups
          it keeps. */}
      {detail != null ? (
        <span
          className={cn(
            "shrink-0 pr-2",
            inCard
              ? "text-[0.8125rem] font-semibold text-foreground tabular-nums"
              : "text-xs text-muted-foreground/80 light:text-muted-foreground/90"
          )}
        >
          {detail}
        </span>
      ) : null}
      {/* Above a row's link, so it takes its own clicks, and the row's full
          height so it's easy to hit. */}
      {action ? (
        <span
          className={cn(
            "relative z-10 flex shrink-0 self-stretch",
            inCard ? "-my-2.5" : "-my-1.5"
          )}
        >
          {action}
        </span>
      ) : null}
    </>
  )
}

// A rail row that doesn't open anything, such as one the viewer can't open.
export function InfoRailRow(props: {
  action?: React.ReactNode
  children: React.ReactNode
  detail?: React.ReactNode
  leading: React.ReactNode
}) {
  return (
    <div className={useInfoRailRowClassName()}>
      <InfoRailRowContent {...props} />
    </div>
  )
}

// A rail row that opens a page. With an action, the link spans the row under
// its content, since a button can't sit inside a link.
const InfoRailLinkAnchor = React.forwardRef<
  HTMLAnchorElement,
  React.ComponentPropsWithoutRef<"a"> & {
    action?: React.ReactNode
    detail?: React.ReactNode
    leading: React.ReactNode
  }
>(function InfoRailLinkAnchor(
  { action, children, className, detail, leading, ...props },
  ref
) {
  const rowClassName = useInfoRailRowClassName()
  const chevron = (
    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-hover:translate-x-0.5 light:text-muted-foreground/85" />
  )
  if (action) {
    return (
      <div
        className={cn(
          rowClassName,
          "relative transition-colors hover:bg-muted/60 has-[a:focus-visible]:bg-muted/60",
          className
        )}
      >
        <a
          ref={ref}
          {...props}
          aria-label={
            props["aria-label"] ??
            (typeof children === "string" ? children : undefined)
          }
          className="absolute inset-0 outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
        />
        <InfoRailRowContent action={action} detail={detail} leading={leading}>
          {children}
        </InfoRailRowContent>
        {chevron}
      </div>
    )
  }
  return (
    <a
      ref={ref}
      {...props}
      className={cn(rowClassName, infoRailLinkClassName, className)}
    >
      <InfoRailRowContent detail={detail} leading={leading}>
        {children}
      </InfoRailRowContent>
      {chevron}
    </a>
  )
})

export const InfoRailLink = createLink(InfoRailLinkAnchor)

// A rail row that opens something in place, such as a dialog, rather than a
// page.
export function InfoRailButton({
  children,
  className,
  detail,
  leading,
  ...props
}: Omit<React.ComponentPropsWithoutRef<"button">, "type"> & {
  detail?: React.ReactNode
  leading: React.ReactNode
}) {
  return (
    <button
      {...props}
      type="button"
      className={cn(
        useInfoRailRowClassName(),
        infoRailLinkClassName,
        "w-full text-left",
        className
      )}
    >
      <InfoRailRowContent detail={detail} leading={leading}>
        {children}
      </InfoRailRowContent>
      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-hover:translate-x-0.5 light:text-muted-foreground/85" />
    </button>
  )
}

export function InfoRailCard({
  action,
  children,
  className,
  icon,
  sections,
  summary,
  title,
}: {
  // At the end of the title row, such as a pager between containers.
  action?: React.ReactNode
  children: React.ReactNode
  // Such as stretching the card to the rail's height.
  className?: string
  icon: React.ReactNode
  // Titled parts below the facts, such as an InfoRailCardSection.
  sections?: React.ReactNode
  // Shown above the facts, such as usage bars.
  summary?: React.ReactNode
  // Text, or text with a hint icon beside it.
  title: React.ReactNode
}) {
  return (
    <section
      className={cn("mt-6 border bg-background/45 first:mt-0", className)}
    >
      <div className="flex min-h-10 items-center gap-2 border-b px-3 py-1.5">
        <h3 className="flex min-w-0 items-center gap-2 text-[0.8125rem] font-semibold [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg:not([class*='text-'])]:text-muted-foreground">
          {icon}
          <span className="truncate">{title}</span>
        </h3>
        {action ? (
          <div className="ml-auto flex shrink-0 items-center">{action}</div>
        ) : null}
      </div>
      {summary ? (
        <div className="border-b border-border/60 px-3">{summary}</div>
      ) : null}
      <dl className="px-3">{children}</dl>
      {sections}
    </section>
  )
}

// A titled part of a rail card below its facts, such as a list: a small-caps
// label, then its content under a rule, inset by the card's padding.
export function InfoRailCardSection({
  action,
  children,
  className,
  contentClassName,
  title,
}: {
  // At the end of the label row, such as a count.
  action?: React.ReactNode
  // Its own markup, such as a list, rather than facts.
  children: React.ReactNode
  className?: string
  // Such as a height cap that scrolls a long list.
  contentClassName?: string
  title: string
}) {
  return (
    <section className={cn("border-t px-3 pb-3", className)}>
      <div className="flex h-9 shrink-0 items-center gap-2">
        <h4 className="type-technical-label text-muted-foreground/80 light:text-muted-foreground/90">
          {title}
        </h4>
        {action ? (
          <div className="ml-auto flex shrink-0 items-center">{action}</div>
        ) : null}
      </div>
      <div className={cn("border-t border-border/60", contentClassName)}>
        {children}
      </div>
    </section>
  )
}
