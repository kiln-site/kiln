import type { SearchEntry } from "../../content-plugin"

// Full-text search over every heading of every page. The index is small
// enough to search in the browser on each keystroke: every word in the query
// has to appear somewhere in a section (as the start of a word), and
// sections score by where the words appear, titles first.

export interface IndexedEntry extends SearchEntry {
  headingWords: Array<string>
  lowerText: string
  textWords: Set<string>
  titleWords: Array<string>
}

export interface Snippet {
  match: boolean
  text: string
}

export interface SearchResult {
  entry: IndexedEntry
  score: number
  snippet: Array<Snippet>
}

export function indexEntries(entries: Array<SearchEntry>): Array<IndexedEntry> {
  return entries.map((entry) => ({
    ...entry,
    headingWords: words(entry.heading),
    lowerText: entry.text.toLowerCase(),
    textWords: new Set(words(entry.text)),
    titleWords: words(entry.title),
  }))
}

export function search(
  index: Array<IndexedEntry>,
  query: string,
  limit = 24
): Array<SearchResult> {
  const terms = words(query)
  if (terms.length === 0) return []
  const phrase = terms.join(" ")
  const results: Array<SearchResult> = []

  for (const entry of index) {
    let score = 0
    let matchedAll = true
    for (const term of terms) {
      const inHeading = matchWord(entry.headingWords, term)
      const inTitle = matchWord(entry.titleWords, term)
      const inText = matchTextWord(entry.textWords, term)
      if (!inHeading && !inTitle && !inText) {
        matchedAll = false
        break
      }
      score += inHeading * 8 + inTitle * 4 + inText
    }
    if (!matchedAll) continue
    const heading = entry.heading.toLowerCase()
    if (heading === phrase) score += 30
    else if (heading.includes(phrase)) score += 12
    if (entry.anchor === "") score += 2
    results.push({ entry, score, snippet: [] })
  }

  results.sort((a, b) => b.score - a.score)
  // At most three sections from one page, so one long page can't crowd out
  // the rest.
  const perPage = new Map<string, number>()
  const kept: Array<SearchResult> = []
  for (const result of results) {
    const count = perPage.get(result.entry.path) ?? 0
    if (count >= 3) continue
    perPage.set(result.entry.path, count + 1)
    result.snippet = snippet(result.entry, terms)
    kept.push(result)
    if (kept.length >= limit) break
  }
  return kept
}

// 2 for a whole word, 1 for the start of one, 0 for none.
function matchWord(list: Array<string>, term: string): number {
  let best = 0
  for (const word of list) {
    if (word === term) return 2
    if (word.startsWith(term)) best = 1
  }
  return best
}

function matchTextWord(set: Set<string>, term: string): number {
  if (set.has(term)) return 2
  for (const word of set) if (word.startsWith(term)) return 1
  return 0
}

function words(value: string): Array<string> {
  return value
    .toLowerCase()
    .split(/[^\p{Letter}\p{Number}]+/u)
    .filter(Boolean)
}

// About 140 characters of the section around the first word that matched,
// split so the matches can be highlighted.
function snippet(entry: IndexedEntry, terms: Array<string>): Array<Snippet> {
  const text = entry.text
  if (!text) return []
  const lower = entry.lowerText
  let start = -1
  for (const term of terms) {
    const found = findWordStart(lower, term)
    if (found !== -1 && (start === -1 || found < start)) start = found
  }
  const from = Math.max(0, start === -1 ? 0 : start - 40)
  const to = Math.min(text.length, from + 140)
  let window = text.slice(from, to)
  if (from > 0) window = `…${window.replace(/^\S*\s/, "")}`
  if (to < text.length) window = `${window.replace(/\s\S*$/, "")}…`
  return highlight(window, terms)
}

function findWordStart(text: string, term: string): number {
  let index = text.indexOf(term)
  while (index !== -1) {
    const before = index === 0 ? "" : text.charAt(index - 1)
    if (!/[\p{Letter}\p{Number}]/u.test(before)) return index
    index = text.indexOf(term, index + 1)
  }
  return -1
}

export function highlight(text: string, terms: Array<string>): Array<Snippet> {
  if (terms.length === 0) return [{ match: false, text }]
  const escaped = terms
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  const pattern = new RegExp(
    `(?<![\\p{Letter}\\p{Number}])(${escaped.join("|")})[\\p{Letter}\\p{Number}]*`,
    "giu"
  )
  const parts: Array<Snippet> = []
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index
    if (index > last)
      parts.push({ match: false, text: text.slice(last, index) })
    parts.push({ match: true, text: match[0] })
    last = index + match[0].length
  }
  if (last < text.length) parts.push({ match: false, text: text.slice(last) })
  return parts
}

export function queryTerms(query: string): Array<string> {
  return words(query)
}
