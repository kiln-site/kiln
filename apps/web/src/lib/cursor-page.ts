export interface CursorPage<TItem> {
  items: Array<TItem>
  nextCursor: string | null
}

export function flattenCursorPages<TItem>(
  pages: ReadonlyArray<CursorPage<TItem>>,
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
