import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vite-plus/test"

import { TooltipProvider } from "@workspace/ui/components/tooltip"

import { RedactedText } from "./redacted-text"

function render(...values: Array<string>) {
  return renderToStaticMarkup(
    <TooltipProvider>
      {values.map((value, index) => (
        <RedactedText key={index} label="email address" value={value} />
      ))}
    </TooltipProvider>
  )
}

it("shows nothing about a hidden value, including its length", () => {
  const short = render("a@b.co")
  const long = render("someone.with.a.long.name@mail.example.com")

  expect(long).toBe(short)
  expect(long).not.toContain("example")
})

it("gives a repeated value a different mosaic each time", () => {
  const [first, second] =
    render("a@b.co", "a@b.co").match(/style="[^"]+"/g) ?? []

  expect(first).toBeDefined()
  expect(second).toBeDefined()
  expect(first).not.toBe(second)
})
