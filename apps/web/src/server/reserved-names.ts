import vm from "node:vm"

import { Result } from "effect"

import {
  englishDataset,
  englishRecommendedTransformers,
  RegExpMatcher,
} from "obscenity"

import { badWordsPattern } from "@/lib/domain-schemas"

// Built on first use; the list compiles to a few hundred expressions.
let profanity: RegExpMatcher | undefined

// People write the patterns, so one may backtrack for minutes. Each runs in
// a context the event loop can interrupt, and one that ever runs past the
// deadline reserves every name from then on, so it stalls Hearth only once.
const patternDeadlineMs = 25
const patternContext = vm.createContext({
  label: "",
  pattern: /(?:)/u,
})
const patternTest = new vm.Script("pattern.test(label)")
const slowPatterns = new Set<string>()

// Names that make a backtracking pattern show itself when it's saved.
const probeLabels = [
  "a".repeat(63),
  `${"a".repeat(62)}!`,
  `${"a-".repeat(31)}a`,
  "0".repeat(63),
]

/**
 * Whether a vanity name avoids every reserved pattern. `{{bad-words}}`
 * matches profanity however it's disguised: `sh1t`, `fvck`, or spelled out
 * between hyphens, while names that merely contain one, such as
 * `classic-smp` or `scunthorpe`, pass. A pattern too slow to finish reserves
 * the name.
 */
export function vanityLabelAllowed(
  label: string,
  patterns: ReadonlyArray<string>
): boolean {
  return !patterns.some((pattern) =>
    pattern === badWordsPattern ? profane(label) : matches(pattern, label)
  )
}

/** Refuses patterns that backtrack past the deadline, before they're saved. */
export function requireFastReservedPatterns(
  patterns: ReadonlyArray<string>
): void {
  patterns.forEach((pattern, index) => {
    if (pattern === badWordsPattern) return
    for (const label of probeLabels) {
      matches(pattern, label)
      if (slowPatterns.has(pattern)) {
        throw new Error(`Reserved name pattern ${index + 1} is too slow`)
      }
    }
  })
}

function matches(pattern: string, label: string): boolean {
  if (slowPatterns.has(pattern)) return true
  patternContext.pattern = new RegExp(pattern, "iu")
  patternContext.label = label
  return Result.getOrElse(
    Result.try(
      () =>
        patternTest.runInContext(patternContext, {
          timeout: patternDeadlineMs,
        }) === true
    ),
    () => {
      slowPatterns.add(pattern)
      return true
    }
  )
}

function profane(label: string): boolean {
  profanity ??= new RegExpMatcher({
    ...englishDataset.build(),
    ...englishRecommendedTransformers,
  })
  return (
    profanity.hasMatch(label) || profanity.hasMatch(label.replaceAll("-", ""))
  )
}
