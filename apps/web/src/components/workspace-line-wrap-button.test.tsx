import * as React from "react"
import { describe, expect, it, vi } from "vite-plus/test"

import { Button } from "@workspace/ui/components/button"

import { WorkspaceLineWrapButton } from "./workspace-line-wrap-button"

describe("WorkspaceLineWrapButton", () => {
  it("forwards tooltip trigger props and its ref to Button", () => {
    const onFocus = vi.fn()
    const onPointerMove = vi.fn()
    const ref = React.createRef<HTMLButtonElement>()

    const element = WorkspaceLineWrapButton({
      ariaLabel: "Disable Line Wrap",
      wrapLines: true,
      onToggle: vi.fn(),
      "aria-describedby": "wrap-tooltip",
      onFocus,
      onPointerMove,
      ref,
    })
    const props = element.props as React.ComponentProps<typeof Button>

    expect(props["aria-describedby"]).toBe("wrap-tooltip")
    expect(props.onFocus).toBe(onFocus)
    expect(props.onPointerMove).toBe(onPointerMove)
    expect(props.ref).toBe(ref)
  })
})
