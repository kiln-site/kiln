import * as React from "react"
import { indentLess, indentMore } from "@codemirror/commands"
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language"
import { json } from "@codemirror/legacy-modes/mode/javascript"
import { properties } from "@codemirror/legacy-modes/mode/properties"
import { shell } from "@codemirror/legacy-modes/mode/shell"
import { toml } from "@codemirror/legacy-modes/mode/toml"
import { xml } from "@codemirror/legacy-modes/mode/xml"
import { yaml } from "@codemirror/legacy-modes/mode/yaml"
import { linter } from "@codemirror/lint"
import {
  SearchQuery,
  closeSearchPanel,
  findNext as findNextSearchMatch,
  findPrevious as findPreviousSearchMatch,
  openSearchPanel,
  search,
  searchKeymap,
  searchPanelOpen,
  setSearchQuery,
} from "@codemirror/search"
import { unifiedMergeView } from "@codemirror/merge"
import { Compartment, EditorState, Prec } from "@codemirror/state"
import type { Extension, StateCommand } from "@codemirror/state"
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  highlightActiveLine,
  highlightActiveLineGutter,
  gutter,
  keymap,
  lineNumbers,
} from "@codemirror/view"
import type { DecorationSet, Panel, ViewUpdate } from "@codemirror/view"
import { tags } from "@lezer/highlight"
import { minimalSetup } from "codemirror"
import { snbtDiagnostic } from "@workspace/contracts"

import { findSensitiveTextRedactions } from "@/lib/redaction"
import { fileLanguageForPath } from "@/lib/file-language"

const defaultIndentUnit = "  "
const indentationScanLimit = 64 * 1024
const indentationLineLimit = 256
const editorContentInlineEndPadding = "24px"
const activeLineBackground = "color-mix(in hsl, var(--accent) 36%, transparent)"

function greatestCommonDivisor(left: number, right: number) {
  while (right !== 0) {
    const remainder = left % right
    left = right
    right = remainder
  }
  return left
}

function indentationWidthFor(value: string) {
  const sample = value.slice(0, indentationScanLimit)
  const lines = sample.split(/\r?\n/, indentationLineLimit)
  let commonIndent = 0

  for (const line of lines) {
    const whitespace = /^[ \t]+(?=\S)/.exec(line)?.[0]
    if (!whitespace) continue

    let columns = 0
    for (const character of whitespace) {
      columns = character === "\t" ? columns + (4 - (columns % 4)) : columns + 1
    }
    commonIndent = greatestCommonDivisor(commonIndent, columns)
  }

  const spaces =
    commonIndent === 0
      ? defaultIndentUnit.length
      : commonIndent >= 4 && commonIndent % 4 === 0
        ? 4
        : 2
  return spaces
}

const insertIndentAtCursor: StateCommand = ({ state, dispatch }) => {
  if (state.selection.ranges.some((range) => !range.empty)) {
    return indentMore({ state, dispatch })
  }

  dispatch(
    state.update(state.replaceSelection(state.facet(indentUnit)), {
      scrollIntoView: true,
      userEvent: "input",
    })
  )
  return true
}

function indentationFor(value: string): Extension {
  const spaces = indentationWidthFor(value)
  return [
    indentUnit.of(" ".repeat(spaces)),
    keymap.of([{ key: "Tab", run: insertIndentAtCursor, shift: indentLess }]),
  ]
}

const kilnHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: [tags.keyword, tags.modifier], color: "var(--primary)" },
  { tag: [tags.bool, tags.null, tags.atom], color: "oklch(0.73 0.09 292)" },
  {
    tag: [tags.string, tags.special(tags.string)],
    color: "oklch(0.76 0.09 148)",
  },
  { tag: tags.quote, color: "oklch(0.76 0.075 148)" },
  { tag: [tags.number, tags.integer, tags.float], color: "oklch(0.76 0.1 79)" },
  {
    tag: [tags.propertyName, tags.attributeName],
    color: "oklch(0.74 0.08 225)",
  },
  { tag: [tags.variableName, tags.name], color: "var(--foreground)" },
  {
    tag: tags.definition(tags.variableName),
    color: "oklch(0.74 0.08 225)",
  },
  { tag: [tags.typeName, tags.className], color: "oklch(0.78 0.08 185)" },
  { tag: [tags.operator, tags.punctuation], color: "var(--muted-foreground)" },
  {
    tag: [tags.meta, tags.labelName],
    color: "hsl(var(--accent-hue) 42% 62%)",
  },
  { tag: tags.heading, color: "var(--primary)", fontWeight: "600" },
  { tag: tags.link, color: "oklch(0.73 0.1 225)", textDecoration: "none" },
  { tag: tags.invalid, color: "oklch(0.71 0.15 27)" },
])

const kilnEditorTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      width: "100%",
      minWidth: "0",
      maxWidth: "100%",
      backgroundColor: "transparent",
      color: "var(--foreground)",
    },
    "&.cm-focused": { outline: "none" },
    "&.cm-editor.cm-focused .cm-cursor": {
      borderLeftColor: "var(--primary)",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      minWidth: "0",
      maxWidth: "100%",
      overflow: "auto",
    },
    ".cm-content": {
      minHeight: "100%",
      padding: `16px ${editorContentInlineEndPadding} 16px 0`,
      caretColor: "var(--primary)",
    },
    ".cm-line": { paddingLeft: "16px" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection":
      {
        backgroundColor:
          "hsl(var(--accent-hue) var(--accent-saturation) 58% / 0.2) !important",
      },
    ".cm-activeLine": { backgroundColor: "transparent" },
    "&.cm-focused .cm-activeLine": {
      backgroundColor: activeLineBackground,
      boxShadow: `${editorContentInlineEndPadding} 0 0 ${activeLineBackground}`,
    },
    ".cm-gutters": {
      minHeight: "100%",
      backgroundColor: "color-mix(in hsl, var(--surface-low) 82%, transparent)",
      color: "color-mix(in hsl, var(--muted-foreground) 55%, transparent)",
      borderRight: "1px solid var(--border)",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      minWidth: "44px",
      padding: "0 12px 0 8px",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: "inherit",
    },
    "&.cm-focused .cm-activeLineGutter": {
      backgroundColor: "var(--accent)",
      color: "var(--accent-foreground)",
    },
    ".cm-matchingBracket": {
      backgroundColor:
        "hsl(var(--accent-hue) var(--accent-saturation) 58% / 0.16)",
      color: "hsl(var(--accent-hue) 35% 84%)",
      outline:
        "1px solid hsl(var(--accent-hue) var(--accent-saturation) 58% / 0.3)",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "transparent",
      border: "none",
      color: "var(--muted-foreground)",
    },
    ".cm-redacted-ip": {
      color: "var(--muted-foreground)",
      cursor: "help",
    },
    ".cm-search-bridge": { display: "none" },
    ".cm-searchMatch": {
      backgroundColor:
        "hsl(var(--accent-hue) var(--accent-saturation) 68% / 0.38)",
      outline:
        "1px solid hsl(var(--accent-hue) var(--accent-saturation) 74% / 0.68)",
      boxShadow: "0 0 0 1px hsl(var(--accent-hue) 12% 8% / 0.3)",
    },
    ".cm-searchMatch-selected": {
      backgroundColor:
        "hsl(var(--accent-hue) var(--accent-saturation) 58% / 0.72)",
      color: "var(--primary-foreground)",
      outlineColor:
        "hsl(var(--accent-hue) var(--accent-saturation) 78% / 0.95)",
      boxShadow:
        "0 0 0 2px hsl(var(--accent-hue) var(--accent-saturation) 58% / 0.24)",
    },
    "&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine": {
      backgroundColor: "oklch(0.66 0.09 175 / 0.09)",
    },
    "&.cm-merge-b .cm-changedText": {
      background: "oklch(0.7 0.1 175 / 0.18)",
      borderBottom: "1px solid oklch(0.7 0.1 175 / 0.42)",
    },
    "&.cm-merge-b.cm-focused .cm-activeLine.cm-changedLine, &.cm-merge-b.cm-focused .cm-activeLine.cm-inlineChangedLine":
      {
        backgroundColor: activeLineBackground,
      },
    "&.cm-merge-b.cm-focused .cm-activeLine .cm-changedText": {
      background: "transparent",
      borderBottomColor: "transparent",
    },
    ".cm-deletedChunk": {
      margin: "0",
      paddingLeft: "60px",
      backgroundColor: "oklch(0.57 0.11 28 / 0.075)",
      boxShadow:
        "inset 0 1px oklch(0.57 0.11 28 / 0.14), inset 0 -1px oklch(0.57 0.11 28 / 0.14)",
      color: "oklch(0.69 0.03 40 / 0.72)",
    },
    ".cm-deletedChunk .cm-deletedText": {
      background: "oklch(0.57 0.11 28 / 0.16)",
      borderBottom: "1px solid oklch(0.62 0.12 28 / 0.34)",
    },
    ".cm-changeGutter": {
      width: "3px",
      paddingLeft: "0",
      backgroundColor: "color-mix(in hsl, var(--surface-low) 82%, transparent)",
    },
    "&.cm-merge-b .cm-changedLineGutter, .cm-inlineChangedLineGutter": {
      backgroundColor: "oklch(0.7 0.1 175 / 0.72)",
    },
    ".cm-deletedLineGutter": {
      backgroundColor: "oklch(0.62 0.12 28 / 0.62)",
    },
  },
  { dark: false }
)

function createSearchBridgePanel(): Panel {
  const dom = document.createElement("div")
  dom.className = "cm-search cm-search-bridge"
  dom.hidden = true
  return { dom, top: true }
}

const mergeGutterSpacer = gutter({
  class: "cm-changeGutter cm-changeGutter-placeholder",
})

function createMergeReview(original: string): Extension {
  return unifiedMergeView({
    original,
    allowInlineDiffs: true,
    gutter: true,
    highlightChanges: true,
    mergeControls: false,
    diffConfig: { scanLimit: 800, timeout: 750 },
  })
}

class RedactedIpWidget extends WidgetType {
  constructor(readonly replacement: string) {
    super()
  }

  eq(other: RedactedIpWidget) {
    return other.replacement === this.replacement
  }

  toDOM() {
    const element = document.createElement("span")
    element.className = "cm-redacted-ip"
    element.textContent = this.replacement
    element.setAttribute("aria-label", "IP address redacted")
    return element
  }
}

function visibleDocumentRanges(view: EditorView) {
  const ranges: Array<{ from: number; to: number }> = []
  for (const visible of view.visibleRanges) {
    const from = view.state.doc.lineAt(visible.from).from
    const to = view.state.doc.lineAt(visible.to).to
    const previous = ranges.at(-1)
    if (previous && from <= previous.to) {
      previous.to = Math.max(previous.to, to)
    } else {
      ranges.push({ from, to })
    }
  }
  return ranges
}

function buildRedactionDecorations(view: EditorView): DecorationSet {
  const decorations = []
  for (const range of visibleDocumentRanges(view)) {
    const visibleText = view.state.doc.sliceString(range.from, range.to)
    for (const redaction of findSensitiveTextRedactions(visibleText)) {
      decorations.push(
        Decoration.replace({
          widget: new RedactedIpWidget(redaction.replacement),
        }).range(range.from + redaction.from, range.from + redaction.to)
      )
    }
  }
  return Decoration.set(decorations, true)
}

const redactSensitiveExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildRedactionDecorations(view)
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildRedactionDecorations(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
)

const logLanguage = StreamLanguage.define({
  token(stream) {
    if (stream.match(/^\[[0-9]{2}:[0-9]{2}:[0-9]{2}\]/)) return "meta"
    if (stream.match(/^\[[^\]]+\/(?:ERROR|FATAL)\]/i)) return "invalid"
    if (stream.match(/^\[[^\]]+\/WARN\]/i)) return "keyword"
    if (stream.match(/^\[[^\]]+\/(?:INFO|DEBUG|TRACE)\]/i)) return "labelName"
    if (stream.match(/^https?:\/\/\S+/)) return "link"
    if (stream.match(/^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?/)) return "number"
    if (stream.match(/^#.*$/)) return "comment"
    stream.next()
    return null
  },
})

type ValveKeyValuesState = {
  expectKey: boolean
}

const valveKeyValuesLanguage = StreamLanguage.define<ValveKeyValuesState>({
  startState: () => ({ expectKey: true }),
  token(stream, state) {
    if (stream.eatSpace()) return null
    if (stream.match("//")) {
      stream.skipToEnd()
      return "comment"
    }
    if (stream.match(/[{}]/)) {
      state.expectKey = true
      return "punctuation"
    }
    if (stream.peek() === '"') {
      stream.next()
      let escaped = false
      while (!stream.eol()) {
        const character = stream.next()
        if (character === '"' && !escaped) break
        escaped = character === "\\" && !escaped
        if (character !== "\\") escaped = false
      }
      const token = state.expectKey ? "property" : "string"
      state.expectKey = !state.expectKey
      return token
    }
    if (stream.match(/[^\s{}"]+/)) {
      const token = state.expectKey ? "property" : "atom"
      state.expectKey = !state.expectKey
      return token
    }
    stream.next()
    return null
  },
})

const snbtLanguage = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null
    if (stream.match(/^[{}[\],:;]/u)) return "punctuation"
    if (stream.peek() === '"' || stream.peek() === "'") {
      const quote = stream.next()
      let escaped = false
      while (!stream.eol()) {
        const character = stream.next()
        if (character === quote && !escaped) break
        escaped = character === "\\" && !escaped
        if (character !== "\\") escaped = false
      }
      return "string"
    }
    if (stream.match(/^(?:bool|uuid)(?=\s*\()/u)) return "keyword"
    if (stream.match(/^(?:true|false)\b/u)) return "bool"
    if (
      stream.match(
        /^[+-]?(?:(?:0[xX][\da-fA-F](?:_?[\da-fA-F])*)|(?:0[bB][01](?:_?[01])*)|(?:(?:\d(?:_?\d)*)?(?:\.\d(?:_?\d)*)?|\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?)(?:[su]?[bBsSiIlLfFdD])?(?![\w.])/u
      )
    ) {
      return "number"
    }
    if (stream.match(/^[^\s{}[\],:;()]+(?=\s*:)/u)) return "propertyName"
    if (stream.match(/^[BIL](?=\s*;)/u)) return "typeName"
    if (stream.match(/^[^\s{}[\],:;()]+/u)) return "string"
    stream.next()
    return null
  },
})

function snbtExtensions(path: string): Extension {
  const binaryCompatible = !path.toLowerCase().endsWith(".snbt")
  return [
    snbtLanguage,
    linter(
      (view) => {
        const source = view.state.doc.toString()
        const diagnostic = snbtDiagnostic(source, { binaryCompatible })
        if (!diagnostic) return []
        return [
          {
            from: diagnostic.from,
            to: diagnostic.to,
            severity: "error" as const,
            message: diagnostic.message,
          },
        ]
      },
      { delay: 300 }
    ),
  ]
}

function languageForPath(path: string): Extension {
  switch (fileLanguageForPath(path).id) {
    case "json":
      return StreamLanguage.define(json)
    case "yaml":
      return StreamLanguage.define(yaml)
    case "xml":
      return StreamLanguage.define(xml)
    case "toml":
      return StreamLanguage.define(toml)
    case "log":
      return logLanguage
    case "ini":
    case "properties":
      return StreamLanguage.define(properties)
    case "shell":
      return StreamLanguage.define(shell)
    case "snbt":
      return snbtExtensions(path)
    case "valve-keyvalues":
      return valveKeyValuesLanguage
    case "text":
      return []
  }
}

function contentAttributesFor(ariaLabel: string): Extension {
  return EditorView.contentAttributes.of({
    "aria-label": ariaLabel,
    autocapitalize: "off",
    autocomplete: "off",
    spellcheck: "false",
  })
}

function editabilityFor(readOnly: boolean, disabled: boolean): Extension {
  return [
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly && !disabled),
  ]
}

function textScaleFor(fontSize: number): Extension {
  return EditorView.theme({
    "&": { fontSize: `${fontSize}px` },
    ".cm-scroller": { lineHeight: `${fontSize * 2.2}px` },
  })
}

export type SyntaxCodeEditorHandle = {
  findNext: () => boolean
  findPrevious: () => boolean
}

type SyntaxCodeEditorProps = {
  ariaLabel: string
  disabled: boolean
  fontSize: number
  onChange: (value: string) => void
  onSearchOpenChange: (open: boolean) => void
  originalValue: string
  path: string
  redactSensitive: boolean
  readOnly: boolean
  searchOpen: boolean
  searchQuery: string
  showChanges: boolean
  value: string
  wrapLines: boolean
}

export const SyntaxCodeEditor = React.forwardRef<
  SyntaxCodeEditorHandle,
  SyntaxCodeEditorProps
>(function SyntaxCodeEditor(
  {
    ariaLabel,
    disabled,
    fontSize,
    onChange,
    onSearchOpenChange,
    originalValue,
    path,
    redactSensitive,
    readOnly,
    searchOpen,
    searchQuery,
    showChanges,
    value,
    wrapLines,
  },
  ref
) {
  const host = React.useRef<HTMLDivElement>(null)
  const view = React.useRef<EditorView | null>(null)
  const onChangeRef = React.useRef(onChange)
  const onSearchOpenChangeRef = React.useRef(onSearchOpenChange)
  const initialValue = React.useRef(value)
  const initialOriginalValue = React.useRef(originalValue)
  const initialShowChanges = React.useRef(showChanges)
  const initialAriaLabel = React.useRef(ariaLabel)
  const initialDisabled = React.useRef(disabled)
  const initialFontSize = React.useRef(fontSize)
  const initialPath = React.useRef(path)
  const initialReadOnly = React.useRef(readOnly)
  const initialRedactSensitive = React.useRef(redactSensitive)
  const initialWrapLines = React.useRef(wrapLines)
  const syncing = React.useRef(false)
  const [contentAttributes] = React.useState(() => new Compartment())
  const [editability] = React.useState(() => new Compartment())
  const [indentation] = React.useState(() => new Compartment())
  const [languageMode] = React.useState(() => new Compartment())
  const [mergeReview] = React.useState(() => new Compartment())
  const [redaction] = React.useState(() => new Compartment())
  const [textScale] = React.useState(() => new Compartment())
  const [wrapping] = React.useState(() => new Compartment())

  React.useLayoutEffect(() => {
    onChangeRef.current = onChange
    onSearchOpenChangeRef.current = onSearchOpenChange
  }, [onChange, onSearchOpenChange])

  React.useImperativeHandle(
    ref,
    () => ({
      findNext() {
        return view.current ? findNextSearchMatch(view.current) : false
      },
      findPrevious() {
        return view.current ? findPreviousSearchMatch(view.current) : false
      },
    }),
    []
  )

  React.useLayoutEffect(() => {
    if (!host.current) return

    const nextView = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initialValue.current,
        extensions: [
          minimalSetup,
          search({ top: true, createPanel: createSearchBridgePanel }),
          Prec.highest(
            keymap.of([
              {
                key: "Mod-f",
                run: () => {
                  onSearchOpenChangeRef.current(true)
                  return true
                },
              },
            ])
          ),
          keymap.of(searchKeymap),
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          bracketMatching(),
          languageMode.of(languageForPath(initialPath.current)),
          syntaxHighlighting(kilnHighlightStyle),
          kilnEditorTheme,
          contentAttributes.of(contentAttributesFor(initialAriaLabel.current)),
          editability.of(
            editabilityFor(initialReadOnly.current, initialDisabled.current)
          ),
          indentation.of(indentationFor(initialValue.current)),
          mergeReview.of(
            initialShowChanges.current
              ? createMergeReview(initialOriginalValue.current)
              : mergeGutterSpacer
          ),
          redaction.of(
            initialRedactSensitive.current ? redactSensitiveExtension : []
          ),
          textScale.of(textScaleFor(initialFontSize.current)),
          wrapping.of(initialWrapLines.current ? EditorView.lineWrapping : []),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !syncing.current) {
              onChangeRef.current(update.state.doc.toString())
            }
            const searchWasOpen = searchPanelOpen(update.startState)
            const searchIsOpen = searchPanelOpen(update.state)
            if (searchWasOpen !== searchIsOpen) {
              onSearchOpenChangeRef.current(searchIsOpen)
            }
          }),
        ],
      }),
    })

    view.current = nextView
    return () => {
      nextView.destroy()
      view.current = null
    }
  }, [
    contentAttributes,
    editability,
    indentation,
    languageMode,
    mergeReview,
    redaction,
    textScale,
    wrapping,
  ])

  React.useLayoutEffect(() => {
    const editor = view.current
    if (!editor) return
    editor.dispatch({
      effects: [
        contentAttributes.reconfigure(contentAttributesFor(ariaLabel)),
        editability.reconfigure(editabilityFor(readOnly, disabled)),
        languageMode.reconfigure(languageForPath(path)),
      ],
    })
  }, [
    ariaLabel,
    contentAttributes,
    disabled,
    editability,
    languageMode,
    path,
    readOnly,
  ])

  React.useLayoutEffect(() => {
    view.current?.dispatch({
      effects: textScale.reconfigure(textScaleFor(fontSize)),
    })
  }, [fontSize, textScale])

  React.useLayoutEffect(() => {
    const editor = view.current
    if (!editor) return
    const currentValue = editor.state.doc.toString()
    if (currentValue === value) return
    syncing.current = true
    editor.dispatch({
      changes: { from: 0, to: currentValue.length, insert: value },
    })
    syncing.current = false
  }, [value])

  React.useLayoutEffect(() => {
    const editor = view.current
    if (!editor || disabled) return
    editor.dispatch({
      effects: indentation.reconfigure(
        indentationFor(editor.state.doc.sliceString(0, indentationScanLimit))
      ),
    })
  }, [disabled, indentation, path])

  React.useLayoutEffect(() => {
    view.current?.dispatch({
      effects: redaction.reconfigure(
        redactSensitive ? redactSensitiveExtension : []
      ),
    })
  }, [redactSensitive, redaction])

  React.useLayoutEffect(() => {
    view.current?.dispatch({
      effects: wrapping.reconfigure(wrapLines ? EditorView.lineWrapping : []),
    })
  }, [wrapLines, wrapping])

  React.useLayoutEffect(() => {
    const editor = view.current
    if (!editor) return

    editor.dispatch({
      effects: mergeReview.reconfigure(
        showChanges ? createMergeReview(originalValue) : mergeGutterSpacer
      ),
    })
  }, [mergeReview, originalValue, showChanges])

  React.useLayoutEffect(() => {
    const editor = view.current
    if (!editor || searchPanelOpen(editor.state) === searchOpen) return
    if (searchOpen) openSearchPanel(editor)
    else closeSearchPanel(editor)
  }, [searchOpen])

  React.useLayoutEffect(() => {
    view.current?.dispatch({
      effects: setSearchQuery.of(new SearchQuery({ search: searchQuery })),
    })
  }, [searchQuery])

  return (
    <div
      ref={host}
      className="kiln-code-editor h-full max-w-full min-w-0 overflow-hidden"
      data-syntax-language={fileLanguageForPath(path).id}
    />
  )
})
