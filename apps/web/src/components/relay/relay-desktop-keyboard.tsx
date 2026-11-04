import * as React from "react"

// A phone only opens its keyboard for a text field, and noVNC draws on a canvas,
// so a hidden one takes the typing. What phones send as key events can't be
// trusted, as Android's name no keys at all, so it goes by what the text became.
// It's kept full of spaces, for Backspace to have something to delete: on an
// empty field it would change nothing, and say nothing.

const FILLER = " ".repeat(64)
const LOW_WATER = 16

const SHIFT = 0xffe1
const BACKSPACE = 0xff08
const RETURN = 0xff0d
// Beyond Latin-1, X keysyms are Unicode with this added.
const UNICODE_KEYSYMS = 0x01000000
// What needs Shift on a keyboard, so it's sent as one would send it.
const SHIFTED = /^[A-Z~!@#$%^&*()_+{}|:"<>?]$/u

type SendKey = (keysym: number, code: string | null, down: boolean) => void

function press(send: SendKey, keysym: number, code: string | null) {
  send(keysym, code, true)
  send(keysym, code, false)
}

function typeCharacter(send: SendKey, character: string) {
  if (character === "\n") {
    press(send, RETURN, "Enter")
    return
  }
  const point = character.codePointAt(0) ?? 0
  const keysym = point < 0x100 ? point : UNICODE_KEYSYMS + point
  const shifted = SHIFTED.test(character)
  if (shifted) send(SHIFT, "ShiftLeft", true)
  press(send, keysym, null)
  if (shifted) send(SHIFT, "ShiftLeft", false)
}

const characters = new Intl.Segmenter(undefined, { granularity: "grapheme" })

// What a person calls characters: an emoji is several of JavaScript's, and one
// press of Backspace.
const charactersOf = (text: string) =>
  Array.from(characters.segment(text), ({ segment }) => segment)

function commonStart(
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>
) {
  let length = 0
  while (
    length < before.length &&
    length < after.length &&
    before[length] === after[length]
  ) {
    length += 1
  }
  return length
}

export function DesktopKeyboard({
  input,
  onOpen,
  send,
}: {
  input: React.Ref<HTMLTextAreaElement>
  onOpen: ((open: boolean) => void) | undefined
  send: React.RefObject<SendKey | null>
}) {
  const typed = React.useRef(FILLER)
  return (
    <textarea
      ref={input}
      aria-hidden
      aria-label="Desktop keyboard"
      autoCapitalize="off"
      autoComplete="off"
      autoCorrect="off"
      // Under 16px, iPhones zoom the page in on it.
      className="pointer-events-none absolute bottom-0 left-0 size-px resize-none overflow-hidden border-0 bg-transparent p-0 text-base opacity-0"
      defaultValue={FILLER}
      spellCheck={false}
      tabIndex={-1}
      onBlur={() => onOpen?.(false)}
      onFocus={(event) => {
        // Fresh each time, with the caret at the end: what's here was typed
        // before, and a change in the middle of it would retype it.
        const field = event.currentTarget
        field.value = FILLER
        typed.current = FILLER
        field.setSelectionRange(FILLER.length, FILLER.length)
        onOpen?.(true)
      }}
      onInput={(event) => {
        const field = event.currentTarget
        const sendKey = send.current
        const before = charactersOf(typed.current)
        const after = charactersOf(field.value)
        const kept = commonStart(before, after)
        if (sendKey) {
          for (let left = before.length - kept; left > 0; left -= 1) {
            press(sendKey, BACKSPACE, "Backspace")
          }
          for (const point of after.slice(kept).join("")) {
            typeCharacter(sendKey, point)
          }
        }
        typed.current = field.value
        if (after.length < LOW_WATER || after.length > FILLER.length * 2) {
          field.value = FILLER
          typed.current = FILLER
        }
      }}
    />
  )
}
