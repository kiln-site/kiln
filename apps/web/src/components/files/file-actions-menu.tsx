import * as React from "react"
import type { ContextMenuAnchorRect } from "@pierre/trees"
import {
  ALargeSmall,
  Archive,
  ArchiveRestore,
  Copy,
  Download,
  EllipsisVertical,
  FileIcon,
  Folder,
  Trash2,
} from "lucide-react"
import { createPortal } from "react-dom"

import { Button } from "@workspace/ui/components/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@workspace/ui/components/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { floatingSurfaceClassName } from "@workspace/ui/lib/surface-styles"

import {
  isUnarchiveSupportedPath,
  type FileActionsController,
  type FileWorkspaceAction,
} from "@/components/files/file-tree-utils"

const floatingMenuCursorGap = 4
const floatingMenuViewportPadding = 8

interface FileActionsMenuCommonProps {
  controller: FileActionsController
  directory?: boolean
  label?: string
  onOpen?: () => void
  paths: ReadonlyArray<string>
}

type FileActionsMenuProps = FileActionsMenuCommonProps &
  (
    | {
        surface: "context"
        children: React.ReactElement
      }
    | {
        surface: "dropdown"
      }
    | {
        surface: "tree"
        anchorRect: ContextMenuAnchorRect
        close: (options?: { restoreFocus?: boolean }) => void
      }
  )

type FileActionsMenuSurface = FileActionsMenuProps["surface"]
type CloseFileActionsMenu = (options?: { restoreFocus?: boolean }) => void

function FileActionMenuItem({
  close,
  disabled,
  icon,
  label,
  onSelect,
  restoreFocus = false,
  surface,
  variant = "default",
}: {
  close?: CloseFileActionsMenu
  disabled?: boolean
  icon: React.ReactNode
  label: string
  onSelect: () => void
  restoreFocus?: boolean
  surface: FileActionsMenuSurface
  variant?: "default" | "destructive"
}) {
  if (surface === "dropdown") {
    return (
      <DropdownMenuItem
        disabled={disabled}
        variant={variant}
        onSelect={onSelect}
      >
        {icon} {label}
      </DropdownMenuItem>
    )
  }

  if (surface === "context") {
    return (
      <ContextMenuItem
        disabled={disabled}
        variant={variant}
        onSelect={onSelect}
      >
        {icon} {label}
      </ContextMenuItem>
    )
  }

  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className="type-menu flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left outline-hidden transition-colors duration-100 select-none hover:bg-popover-accent focus-visible:bg-popover-accent focus-visible:text-popover-accent-foreground focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 data-[variant=destructive]:text-destructive data-[variant=destructive]:hover:bg-destructive/10 data-[variant=destructive]:focus-visible:bg-destructive/10 data-[variant=destructive]:focus-visible:text-destructive [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
      data-variant={variant}
      onClick={() => {
        close?.({ restoreFocus })
        onSelect()
      }}
    >
      {icon} {label}
    </button>
  )
}

function FileActionMenuSeparator({
  surface,
}: {
  surface: FileActionsMenuSurface
}) {
  if (surface === "dropdown") return <DropdownMenuSeparator />
  if (surface === "context") return <ContextMenuSeparator />
  return <hr className="-mx-1 my-1 h-px border-0 bg-border" />
}

function FileActionMenuItems({
  close,
  controller,
  directory = false,
  onOpen,
  paths,
  surface,
}: FileActionsMenuCommonProps & {
  close?: CloseFileActionsMenu
  surface: FileActionsMenuSurface
}) {
  const request = (action: FileWorkspaceAction) => () =>
    controller.request(action, paths)

  return (
    <>
      {onOpen ? (
        <FileActionMenuItem
          surface={surface}
          close={close}
          icon={directory ? <Folder /> : <FileIcon />}
          label="Open"
          onSelect={onOpen}
          restoreFocus
        />
      ) : null}
      <FileActionMenuItem
        surface={surface}
        close={close}
        disabled={!controller.canWrite || paths.length !== 1}
        icon={<ALargeSmall />}
        label="Rename"
        onSelect={request("rename")}
      />
      <FileActionMenuItem
        surface={surface}
        close={close}
        icon={<Download />}
        label="Download"
        onSelect={request("download")}
      />
      <FileActionMenuItem
        surface={surface}
        close={close}
        disabled={!controller.canWrite}
        icon={<Archive />}
        label="Archive"
        onSelect={request("archive")}
      />
      {paths.length === 1 && isUnarchiveSupportedPath(paths[0] ?? "") ? (
        <FileActionMenuItem
          surface={surface}
          close={close}
          disabled={!controller.canWrite}
          icon={<ArchiveRestore />}
          label="Unarchive"
          onSelect={request("unarchive")}
        />
      ) : null}
      <FileActionMenuItem
        surface={surface}
        close={close}
        disabled={!controller.canWrite}
        icon={<Copy />}
        label="Duplicate"
        onSelect={request("duplicate")}
        restoreFocus
      />
      <FileActionMenuSeparator surface={surface} />
      <FileActionMenuItem
        surface={surface}
        close={close}
        disabled={!controller.canWrite}
        icon={<Trash2 />}
        label="Delete"
        onSelect={request("delete")}
        variant="destructive"
      />
    </>
  )
}

function menuLabel(paths: ReadonlyArray<string>, label?: string): string {
  if (label) return label
  if (paths.length !== 1) return "File actions"
  const name = paths[0]?.split("/").filter(Boolean).at(-1)
  return name ? `Actions for ${name}` : "File actions"
}

function FloatingFileActionsMenu({
  anchorRect,
  children,
  label,
}: {
  anchorRect: ContextMenuAnchorRect
  children: React.ReactNode
  label: string
}) {
  const menuRef = React.useRef<HTMLDivElement>(null)
  const portalTarget = typeof document === "undefined" ? null : document.body
  const [position, setPosition] = React.useState<{
    left: number
    top: number
  } | null>(null)

  React.useLayoutEffect(() => {
    if (!portalTarget) return

    const updatePosition = () => {
      const menu = menuRef.current
      if (!menu) return

      const { height, width } = menu.getBoundingClientRect()
      const maxLeft = Math.max(
        floatingMenuViewportPadding,
        window.innerWidth - width - floatingMenuViewportPadding
      )
      const maxTop = Math.max(
        floatingMenuViewportPadding,
        window.innerHeight - height - floatingMenuViewportPadding
      )
      const fitsRight =
        anchorRect.right + floatingMenuCursorGap + width <=
        window.innerWidth - floatingMenuViewportPadding
      const fitsBelow =
        anchorRect.bottom + floatingMenuCursorGap + height <=
        window.innerHeight - floatingMenuViewportPadding
      const preferredLeft = fitsRight
        ? anchorRect.right + floatingMenuCursorGap
        : anchorRect.left - width - floatingMenuCursorGap
      const preferredTop = fitsBelow
        ? anchorRect.bottom + floatingMenuCursorGap
        : anchorRect.top - height - floatingMenuCursorGap

      setPosition({
        left: Math.min(
          maxLeft,
          Math.max(floatingMenuViewportPadding, preferredLeft)
        ),
        top: Math.min(
          maxTop,
          Math.max(floatingMenuViewportPadding, preferredTop)
        ),
      })
    }

    updatePosition()
    window.addEventListener("resize", updatePosition)
    return () => window.removeEventListener("resize", updatePosition)
  }, [
    anchorRect.bottom,
    anchorRect.left,
    anchorRect.right,
    anchorRect.top,
    portalTarget,
  ])

  if (!portalTarget) return null

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      data-file-actions-menu-root="true"
      data-file-tree-context-menu-root="true"
      className={`${floatingSurfaceClassName} fixed z-[100] w-44 rounded-lg p-1 ring-1 ring-accent-border/22`}
      style={
        position
          ? { left: position.left, top: position.top }
          : { top: 0, left: 0, visibility: "hidden" }
      }
    >
      {children}
    </div>,
    portalTarget
  )
}

export function FileActionsMenu(props: FileActionsMenuProps) {
  const label = menuLabel(props.paths, props.label)

  if (props.surface === "tree") {
    return (
      <FloatingFileActionsMenu anchorRect={props.anchorRect} label={label}>
        <FileActionMenuItems
          surface="tree"
          close={props.close}
          controller={props.controller}
          directory={props.directory}
          paths={props.paths}
          onOpen={props.onOpen}
        />
      </FloatingFileActionsMenu>
    )
  }

  if (props.surface === "context") {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{props.children}</ContextMenuTrigger>
        <ContextMenuContent
          className="w-44 [&_[data-slot=context-menu-item]]:cursor-pointer"
          aria-label={label}
        >
          <FileActionMenuItems
            surface="context"
            controller={props.controller}
            directory={props.directory}
            paths={props.paths}
            onOpen={props.onOpen}
          />
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="File actions"
          disabled={!props.paths.length || props.controller.busy}
        >
          <EllipsisVertical className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        aria-label={label}
        className="w-44 [&_[data-slot=dropdown-menu-item]]:cursor-pointer"
      >
        <FileActionMenuItems
          surface="dropdown"
          controller={props.controller}
          directory={props.directory}
          paths={props.paths}
          onOpen={props.onOpen}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
