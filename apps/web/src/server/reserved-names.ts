import {
  englishDataset,
  englishRecommendedTransformers,
  RegExpMatcher,
} from "obscenity"

import { badWordsPattern } from "@/lib/domain-schemas"

// Built on first use; the list compiles to a few hundred expressions.
let profanity: RegExpMatcher | undefined

/**
 * Whether a vanity name avoids every reserved pattern. `{{bad-words}}`
 * matches profanity however it's disguised: `sh1t`, `fvck`, or spelled out
 * between hyphens, while names that merely contain one, such as
 * `classic-smp` or `scunthorpe`, pass.
 */
export function vanityLabelAllowed(
  label: string,
  patterns: ReadonlyArray<string>
): boolean {
  return !patterns.some((pattern) =>
    pattern === badWordsPattern
      ? profane(label)
      : new RegExp(pattern, "iu").test(label)
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
