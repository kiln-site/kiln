export interface CursorPage<TItem, TCursor = string> {
  items: Array<TItem>
  nextCursor: TCursor | null
}

export function flattenCursorPages<TItem, TCursor = string>(
  pages: ReadonlyArray<CursorPage<TItem, TCursor>>,
  getKey: (item: TItem) => string
): Array<TItem> {
  const keys = new Set<string>()
  const items: Array<TItem> = []
  for (const page of pages) {
    for (const item of page.items) {
      const key = getKey(item)
      if (keys.has(key)) continue
      keys.add(key)
      items.push(item)
    }
  }
  return items
}
