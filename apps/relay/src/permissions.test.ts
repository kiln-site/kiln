import { describe, expect, it } from "vite-plus/test"

import {
  actionsForRole,
  fileMutationAction,
  isActionAllowed,
} from "./permissions"

describe("machine file mutation ceiling", () => {
  it("does not admit deletion through write-only or read-only clients", () => {
    const action = fileMutationAction("delete")!
    expect(
      isActionAllowed(
        actionsForRole("custom", ["instance.files.write"]),
        action
      )
    ).toBe(false)
    expect(isActionAllowed(actionsForRole("read_only"), action)).toBe(false)
    expect(
      isActionAllowed(
        actionsForRole("custom", ["instance.files.delete"]),
        action
      )
    ).toBe(true)
    expect(isActionAllowed(actionsForRole("full_access"), action)).toBe(true)
  })

  it("rejects unknown mutation operations", () => {
    expect(fileMutationAction("anything")).toBeNull()
    expect(fileMutationAction(null)).toBeNull()
  })
})
