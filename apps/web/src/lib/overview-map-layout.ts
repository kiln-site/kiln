/**
 * Geometry for the overview map: one card on the left (Hearth, or the
 * Relay in view) and a column of titled groups on the right, each card
 * joined to the left one by its own wire. Wires turn at square corners and
 * each takes its own lane, so no two cross or overlap. On phones the map
 * flows down instead: the left card on top and a trunk down the left edge.
 * Every size is known up front, so the map lays out before render.
 */

export interface OverviewRect {
  x: number
  y: number
  width: number
  height: number
}

export interface OverviewLayoutInput {
  direction: "right" | "down"
  root: { width: number; height: number }
  cardWidth: number
  groups: ReadonlyArray<{
    id: string
    cards: ReadonlyArray<{ id: string; height: number }>
  }>
}

export interface OverviewLayout {
  width: number
  height: number
  root: OverviewRect
  headings: ReadonlyMap<string, OverviewRect>
  cards: ReadonlyMap<string, OverviewRect>
  /** One path per card, from the root card to it. */
  wires: ReadonlyMap<string, string>
  /** On phones, the shared line the wires branch from. */
  trunk: string | null
}

export const overviewHeadingHeight = 38

const headingGap = 8
const cardGap = 12
const groupGap = 26
const columnGap = 200
const laneStart = 40
const laneGap = 12
// Room between the last lane and the cards.
const laneClearance = 40
const indent = 32
const trunkInset = 18

export function layoutOverviewMap(input: OverviewLayoutInput): OverviewLayout {
  return input.direction === "right" ? layoutRight(input) : layoutDown(input)
}

function stackGroups(
  groups: OverviewLayoutInput["groups"],
  x: number,
  top: number,
  width: number
) {
  const headings = new Map<string, OverviewRect>()
  const cards = new Map<string, OverviewRect>()
  let y = top
  for (const group of groups) {
    if (group.cards.length === 0) continue
    if (headings.size > 0) y += groupGap - cardGap
    headings.set(group.id, { x, y, width, height: overviewHeadingHeight })
    y += overviewHeadingHeight + headingGap
    for (const card of group.cards) {
      cards.set(card.id, { x, y, width, height: card.height })
      y += card.height + cardGap
    }
  }
  return { headings, cards, bottom: cards.size > 0 ? y - cardGap : top }
}

function layoutRight(input: OverviewLayoutInput): OverviewLayout {
  const { root: rootSize, cardWidth } = input
  // Stack first; the cards' x is set once the lanes are known.
  const column = stackGroups(input.groups, 0, 0, cardWidth)
  const columnHeight = column.bottom
  // Whichever is shorter sits centred on the other.
  const shift = Math.max(0, (rootSize.height - columnHeight) / 2)
  const stacked = shiftAll(column.cards, 0, shift)
  const height = Math.max(columnHeight, rootSize.height)
  const root = {
    x: 0,
    y: (height - rootSize.height) / 2,
    width: rootSize.width,
    height: rootSize.height,
  }

  // Wires leave the root spread along its right edge, in card order, so
  // they fan out without crossing. A wire going up turns further out the
  // lower it starts; one going down, the higher it starts.
  const ids = [...stacked.keys()]
  const count = ids.length
  const spread = Math.min(root.height - 28, count * 11)
  const centre = root.y + root.height / 2
  const starts = ids.map((_, index) =>
    count > 1 ? centre - spread / 2 + (spread * index) / (count - 1) : centre
  )
  const ends = ids.map((id) => {
    const rect = stacked.get(id)!
    return rect.y + rect.height / 2
  })
  const up: Array<number> = []
  const down: Array<number> = []
  ids.forEach((_, index) => {
    if (ends[index]! < starts[index]! - 1) up.push(index)
    else if (ends[index]! > starts[index]! + 1) down.push(index)
  })
  // The column starts past the last lane, so however many Relays or
  // instances there are, every wire turns before it reaches a card.
  const lanesAcross = Math.max(up.length, down.length)
  const x =
    rootSize.width +
    Math.max(
      columnGap,
      laneStart + Math.max(0, lanesAcross - 1) * laneGap + laneClearance
    )
  const headings = shiftAll(column.headings, x, shift)
  const cards = shiftAll(stacked, x, 0)
  const lanes = new Map<number, number>()
  const laneX = root.x + root.width + laneStart
  up.forEach((index, lane) => lanes.set(index, laneX + lane * laneGap))
  down
    .reverse()
    .forEach((index, lane) => lanes.set(index, laneX + lane * laneGap))
  const wires = new Map<string, string>()
  ids.forEach((id, index) => {
    const startX = root.x + root.width
    const startY = starts[index]!
    const endY = ends[index]!
    const turn = lanes.get(index)
    wires.set(
      id,
      turn === undefined
        ? `M${startX} ${startY} L${x} ${endY}`
        : `M${startX} ${startY} L${turn} ${startY} L${turn} ${endY} L${x} ${endY}`
    )
  })

  return {
    width: x + cardWidth,
    height,
    root,
    headings,
    cards,
    wires,
    trunk: null,
  }
}

function layoutDown(input: OverviewLayoutInput): OverviewLayout {
  const { root: rootSize, cardWidth } = input
  const width = Math.max(rootSize.width, cardWidth + indent)
  const root = { x: 0, y: 0, width, height: rootSize.height }
  const column = stackGroups(
    input.groups,
    indent,
    root.height + groupGap,
    width - indent
  )
  const trunkX = indent - trunkInset
  const wires = new Map<string, string>()
  let lastY = root.height
  for (const [id, rect] of column.cards) {
    const y = rect.y + rect.height / 2
    wires.set(id, `M${trunkX} ${y} L${rect.x} ${y}`)
    lastY = y
  }
  return {
    width,
    height: column.bottom,
    root,
    headings: column.headings,
    cards: column.cards,
    wires,
    trunk:
      column.cards.size > 0
        ? `M${trunkX} ${root.height} L${trunkX} ${lastY}`
        : null,
  }
}

function shiftAll(
  rects: ReadonlyMap<string, OverviewRect>,
  dx: number,
  dy: number
) {
  if (dx === 0 && dy === 0) return rects
  return new Map(
    [...rects].map(([id, rect]) => [
      id,
      { ...rect, x: rect.x + dx, y: rect.y + dy },
    ])
  )
}
