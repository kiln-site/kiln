import * as React from "react"

// JSON with its keys, strings, and literals told apart, without an editor.
const TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/gu

export const JsonView = React.memo(function JsonView({
  className,
  text,
}: {
  className?: string
  text: string
}) {
  const parts = React.useMemo(() => highlight(text), [text])
  return (
    <pre className={className}>
      <code>{parts}</code>
    </pre>
  )
})

function highlight(text: string): Array<React.ReactNode> {
  const parts: Array<React.ReactNode> = []
  let last = 0
  for (const match of text.matchAll(TOKEN)) {
    const index = match.index
    if (index > last) parts.push(text.slice(last, index))
    const [whole, string, colon, number, literal] = match
    if (string !== undefined) {
      parts.push(
        <span
          key={index}
          className={colon ? "text-foreground" : "text-primary-ink"}
        >
          {string}
        </span>
      )
      if (colon) parts.push(colon)
    } else if (number !== undefined) {
      parts.push(
        <span key={index} className="text-sky-300">
          {number}
        </span>
      )
    } else if (literal !== undefined) {
      parts.push(
        <span key={index} className="text-violet-300">
          {literal}
        </span>
      )
    }
    last = index + whole.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}
