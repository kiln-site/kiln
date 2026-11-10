import type { Brick } from "@workspace/contracts"
import { describe, expect, it } from "vite-plus/test"

import {
  brickFields,
  defaultBrickVariables,
  hydrateBrickVariables,
  withBrickVariableChanged,
} from "./brick-variables"

// An image tag that follows the channel chosen, with a default of its own.
const brick: Pick<Brick, "inputs"> = {
  inputs: [
    {
      key: "channel",
      label: "Channel",
      type: "select",
      options: ["old", "new"],
      default: "new",
    },
    {
      key: "tag",
      label: "Tag",
      type: "select",
      options: ["old", "new"],
      default: "old",
      suggest: [{ when: "channel", matches: "^new$", value: "new" }],
    },
  ],
}

describe("the answers Hearth sends for a Brick", () => {
  // Hearth sends every answer, so the Relay takes them as given: one that
  // should have followed another has to follow it here.
  it("start from each default, and what follows them", () => {
    expect(defaultBrickVariables(brick)).toEqual({
      channel: "new",
      tag: "new",
    })
  })

  it("keep what was answered, and follow it where nothing was", () => {
    expect(hydrateBrickVariables(brick, { channel: "old" })).toEqual({
      channel: "old",
      tag: "old",
    })
    expect(hydrateBrickVariables(brick, { tag: "old" })).toEqual({
      channel: "new",
      tag: "old",
    })
  })

  // A server keeps answers to inputs its next Brick may not have, as the
  // memory a kiln.brick/v1 recipe asked for. Its Relay would refuse them.
  it("leave out an answer to an input the Brick doesn't have", () => {
    expect(
      hydrateBrickVariables(brick, { channel: "old", memory: "2G" })
    ).toEqual({ channel: "old", tag: "old" })
  })

  it("follow an answer when it changes, and only what follows it", () => {
    const fields = brickFields(brick)
    expect(
      withBrickVariableChanged(
        fields,
        { channel: "new", tag: "old" },
        "channel"
      )
    ).toEqual({ channel: "new", tag: "new" })
    expect(
      withBrickVariableChanged(fields, { channel: "new", tag: "old" }, "tag")
    ).toEqual({ channel: "new", tag: "old" })
    // No rule applies to the old channel, so the tag's own default stands.
    expect(
      withBrickVariableChanged(
        fields,
        { channel: "old", tag: "new" },
        "channel"
      )
    ).toEqual({ channel: "old", tag: "old" })
  })

  // The version and Java fields sit side by side, but Java follows whatever
  // its rules name. Changing the version moves it only when a rule says so.
  it("work Java out from every answer, not the version alone", () => {
    const fields = brickFields({
      inputs: [
        { key: "version", label: "Version", type: "text", default: "1.0" },
        {
          key: "channel",
          label: "Channel",
          type: "select",
          options: ["classic", "modern"],
          default: "modern",
        },
        {
          key: "java_version",
          label: "Java",
          type: "select",
          options: ["21", "25"],
          default: "21",
          suggest: [
            { when: "channel", matches: "^modern$", value: "25" },
            { when: "version", from: "2", value: "25" },
          ],
        },
      ],
    })
    const held = { version: "1.0", channel: "modern", java_version: "25" }
    expect(
      withBrickVariableChanged(fields, { ...held, version: "1.1" }, "version")
    ).toEqual({ version: "1.1", channel: "modern", java_version: "25" })
    expect(
      withBrickVariableChanged(
        fields,
        { ...held, channel: "classic" },
        "channel"
      )
    ).toEqual({ version: "1.0", channel: "classic", java_version: "21" })
  })

  // Its Relay gives an input nobody answered its default. Cleared in the
  // form, it shows that, and what follows it follows the same value.
  it("give a cleared answer back its default, with what follows it", () => {
    const fields = brickFields({
      inputs: [{ ...brick.inputs![0]!, optional: true }, brick.inputs![1]!],
    })
    expect(withBrickVariableChanged(fields, { tag: "old" }, "channel")).toEqual(
      {
        channel: "new",
        tag: "new",
      }
    )
  })
})
