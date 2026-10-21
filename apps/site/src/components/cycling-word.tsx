import * as React from "react"

const slideMs = 550

// One word at a time from `words`, each sliding up into place. It holds the
// first word for people who prefer less motion, and screen readers get the
// whole list from the heading instead.
export function CyclingWord({
  interval = 2_400,
  words,
}: {
  interval?: number
  words: ReadonlyArray<string>
}) {
  const [index, setIndex] = React.useState(0)
  const [sliding, setSliding] = React.useState(true)

  React.useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    let reset: number | undefined
    const timer = window.setInterval(() => {
      if (document.hidden) return
      setSliding(true)
      setIndex((current) => {
        const next = current + 1
        // The list ends with the first word again; once it's in place, jump
        // back to the start without a slide.
        if (next === words.length) {
          reset = window.setTimeout(() => {
            setSliding(false)
            setIndex(0)
          }, slideMs)
        }
        return next
      })
    }, interval)
    return () => {
      window.clearInterval(timer)
      window.clearTimeout(reset)
    }
  }, [interval, words.length])

  return (
    <span aria-hidden="true" className="block h-[1.12em] overflow-hidden">
      <span
        className="block"
        style={{
          transform: `translateY(${-index * 1.12}em)`,
          transition: sliding
            ? `transform ${slideMs}ms cubic-bezier(0.22, 1, 0.36, 1)`
            : "none",
        }}
      >
        {[...words, words[0]].map((word, position) => (
          <span
            key={position}
            className="block h-[1.12em] leading-[1.12em] whitespace-nowrap"
          >
            {word}
          </span>
        ))}
      </span>
    </span>
  )
}
