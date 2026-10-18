/**
 * Geometry for the infrastructure map. Nodes sit in ranks along the flow;
 * a rank holds groups side by side across it, and a group wraps its nodes
 * into a grid. Links join nodes in neighbouring ranks, or neighbours in one rank,
 * and travel through the gaps between nodes so they never cross a card.
 * Every size is known up front, so the map lays out before render.
 */

export interface InfraMapRect {
  x: number
  y: number
  width: number
  height: number
}

export type InfraMapLinkKind = "uplink" | "dns" | "route" | "database"

export interface InfraMapGroupInput {
  id: string
  /** Labelled groups draw as a box with a title row. */
  labelled: boolean
  columns: number
  nodes: ReadonlyArray<{ id: string; width: number; height: number }>
}

export interface InfraMapLinkInput {
  id: string
  from: string
  to: string
  kind: InfraMapLinkKind
  /** Drawn dashed, as for a paused Relay. */
  muted?: boolean
}

export interface InfraMapLayout {
  width: number
  height: number
  nodes: Map<string, InfraMapRect>
  groups: Array<{ id: string; rect: InfraMapRect; labelled: boolean }>
  links: Array<{
    id: string
    from: string
    to: string
    kind: InfraMapLinkKind
    muted: boolean
    path: string
  }>
}

export const infraMapGroupLabelHeight = 36

const rankGap = 96
const groupGap = 56
// How far a turned rank may run down the screen before its groups wrap.
const crossBudget = 1400
const columnGap = 32
// Lines route through these gaps, so they leave room for one.
const lineGap = 28
const groupPadding = 20
const cornerRadius = 8
// Each kind runs along its own track between ranks, so lines of different
// kinds never lie on top of each other.
const trackOffset: Record<InfraMapLinkKind, number> = {
  uplink: 28,
  dns: 44,
  route: 60,
  database: 44,
}

interface Placed {
  rect: InfraMapRect
  rank: number
  labelled: boolean
  firstLine: boolean
  lastLine: boolean
  /** Where its rank wrapped it: which shelf, and the rank's extent. */
  shelf: Shelf
}

/**
 * A row of groups across a rank. A rank whose groups would run past the
 * budget wraps onto more shelves along the flow, like a masonry grid.
 */
interface Shelf {
  index: number
  last: boolean
  start: number
  end: number
  rankCrossStart: number
  rankCrossEnd: number
}

/**
 * Lays the map out flowing `down`, or `right` for wide screens. Right is
 * the same layout with the axes swapped: each node is sized on its side,
 * placed, and turned back, so a group's title stays on its top edge.
 */
export function layoutInfraMap({
  direction,
  links,
  ranks,
}: {
  direction: "down" | "right"
  links: ReadonlyArray<InfraMapLinkInput>
  ranks: ReadonlyArray<ReadonlyArray<InfraMapGroupInput>>
}): InfraMapLayout {
  const turned = direction === "right"
  // Size every group, then each rank, before placing anything.
  const sizeGroup = (group: InfraMapGroupInput) => {
    const nodes = turned
      ? group.nodes.map((node) => ({
          id: node.id,
          width: node.height,
          height: node.width,
        }))
      : group.nodes
    const columns = Math.max(1, Math.min(group.columns, nodes.length))
    const columnWidth = Math.max(...nodes.map((node) => node.width))
    const lineHeights: Array<number> = []
    nodes.forEach((node, index) => {
      const line = Math.floor(index / columns)
      lineHeights[line] = Math.max(lineHeights[line] ?? 0, node.height)
    })
    const inset = group.labelled ? groupPadding : 0
    // The title sits on the real top edge: across the rank when the map is
    // turned, along it otherwise. Turned, it leaves room for lines entering
    // through the gap above each node.
    const title = group.labelled ? infraMapGroupLabelHeight : 0
    const crossStart = turned ? title + (title ? columnGap / 2 : 0) : inset
    const mainStart = turned ? inset : title + (title ? lineGap / 2 : 0)
    const width =
      crossStart + columns * columnWidth + (columns - 1) * columnGap + inset
    const height =
      mainStart +
      lineHeights.reduce((total, line) => total + line, 0) +
      (lineHeights.length - 1) * lineGap +
      inset
    return {
      group,
      nodes,
      columns,
      columnWidth,
      lineHeights,
      crossStart,
      mainStart,
      width,
      height,
    }
  }
  const sized = ranks.map((input) => {
    const groups = input
      .filter((group) => group.nodes.length > 0)
      .map((group) => sizeGroup(group))
    // Turned, a rank's groups stack down the screen; past the budget the
    // rest start a new shelf further along the flow.
    const shelves: Array<typeof groups> = []
    let across = 0
    for (const group of groups) {
      const shelf = shelves.at(-1)
      if (shelf && (!turned || across + groupGap + group.width <= crossBudget)) {
        shelf.push(group)
        across += groupGap + group.width
      } else {
        shelves.push([group])
        across = group.width
      }
    }
    return shelves
  })
  const shelfWidth = (shelf: ReadonlyArray<{ width: number }>) =>
    shelf.reduce((total, group) => total + group.width, 0) +
    Math.max(0, shelf.length - 1) * groupGap
  const rankWidths = sized.map((shelves) =>
    Math.max(0, ...shelves.map(shelfWidth))
  )
  const contentWidth = Math.max(0, ...rankWidths)

  const nodes = new Map<string, Placed>()
  const groupEnds = new Map<string, Placed>()
  const groups: InfraMapLayout["groups"] = []
  const rankBounds: Array<{ top: number; bottom: number }> = []
  let y = 0
  sized.forEach((shelves, rank) => {
    if (shelves.length === 0) {
      rankBounds.push({ top: y, bottom: y - rankGap })
      return
    }
    const rankTop = y
    const rankCrossStart = (contentWidth - rankWidths[rank]!) / 2
    shelves.forEach((shelfGroups, index) => {
      const shelfHeight = Math.max(...shelfGroups.map((group) => group.height))
      const shelf: Shelf = {
        index,
        last: index === shelves.length - 1,
        start: y,
        end: y + shelfHeight,
        rankCrossStart,
        rankCrossEnd: rankCrossStart + rankWidths[rank]!,
      }
      let x = rankCrossStart
      for (const sizedGroup of shelfGroups) {
        const { group, columns, columnWidth, lineHeights } = sizedGroup
        const groupRect = {
          x,
          y,
          width: sizedGroup.width,
          height: sizedGroup.height,
        }
        groups.push({ id: group.id, labelled: group.labelled, rect: groupRect })
        // A group can end a link itself, joined at its edge like a lone node.
        groupEnds.set(group.id, {
          rank,
          labelled: false,
          firstLine: true,
          lastLine: true,
          shelf,
          rect: groupRect,
        })
        const lineTops: Array<number> = []
        let lineTop = y + sizedGroup.mainStart
        for (const height of lineHeights) {
          lineTops.push(lineTop)
          lineTop += height + lineGap
        }
        sizedGroup.nodes.forEach((node, index) => {
          const line = Math.floor(index / columns)
          const column = index % columns
          nodes.set(node.id, {
            rank,
            labelled: group.labelled,
            firstLine: line === 0,
            lastLine: line === lineHeights.length - 1,
            shelf,
            rect: {
              x:
                x +
                sizedGroup.crossStart +
                column * (columnWidth + columnGap) +
                (columnWidth - node.width) / 2,
              y: lineTops[line]!,
              width: node.width,
              height: node.height,
            },
          })
        })
        x += sizedGroup.width + groupGap
      }
      y += shelfHeight + (shelf.last ? 0 : groupGap)
    })
    rankBounds.push({ top: rankTop, bottom: y })
    y += rankGap
  })

  const bounds = { minX: 0, minY: 0, maxX: contentWidth, maxY: Math.max(0, y - rankGap) }
  const routed: Array<
    Omit<InfraMapLayout["links"][number], "path"> & { points: Array<Point> }
  > = []
  for (const link of links) {
    let from = nodes.get(link.from) ?? groupEnds.get(link.from)
    let to = nodes.get(link.to) ?? groupEnds.get(link.to)
    if (!from || !to) continue
    if (from.rank > to.rank) [from, to] = [to, from]
    const points =
      from.rank === to.rank
        ? turned
          ? bracket(from.rect, to.rect)
          : sideBySide(from.rect, to.rect)
        : stacked(
            from,
            to,
            rankBounds[to.rank - 1]!.bottom + trackOffset[link.kind],
            turned,
            trackOffset[link.kind]
          )
    for (const [px, py] of points) {
      bounds.minX = Math.min(bounds.minX, px)
      bounds.maxX = Math.max(bounds.maxX, px)
      bounds.minY = Math.min(bounds.minY, py)
      bounds.maxY = Math.max(bounds.maxY, py)
    }
    routed.push({
      id: link.id,
      from: link.from,
      to: link.to,
      kind: link.kind,
      muted: link.muted ?? false,
      points,
    })
  }

  // Move links routed outside the content back onto the canvas, then turn
  // everything back when the map flows right.
  const place = (rect: InfraMapRect): InfraMapRect => {
    const x = rect.x - bounds.minX
    const y = rect.y - bounds.minY
    return turned
      ? { x: y, y: x, width: rect.height, height: rect.width }
      : { x, y, width: rect.width, height: rect.height }
  }
  const point = ([px, py]: Point): Point => {
    const x = px - bounds.minX
    const y = py - bounds.minY
    return turned ? [y, x] : [x, y]
  }
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  const placedNodes = new Map<string, InfraMapRect>()
  for (const [id, node] of nodes) placedNodes.set(id, place(node.rect))
  return {
    width: turned ? height : width,
    height: turned ? width : height,
    nodes: placedNodes,
    groups: groups.map((group) => ({ ...group, rect: place(group.rect) })),
    links: routed.map(({ points, ...link }) => ({
      ...link,
      path: roundedPath(points.map(point)),
    })),
  }
}

type Point = readonly [number, number]

/**
 * Leaves the source from the side facing the next rank and enters the
 * target from the side facing back, which reads as right to left when the
 * map is turned. A node with others in front of it reaches the open side
 * through the gaps between rows and columns, so lines never cross a card.
 * On a later shelf, a line first runs around its rank's near edge and down
 * the gap before the shelf; leaving an earlier shelf, it runs around the
 * far edge.
 */
function stacked(
  from: Placed,
  to: Placed,
  track: number,
  turned: boolean,
  offset: number
): Array<Point> {
  const a = from.rect
  const b = to.rect
  const gutterX = a.x + a.width + columnGap / 2
  const out: Array<Point> = from.lastLine
    ? [[a.x + a.width / 2, a.y + a.height]]
    : [
        [a.x + a.width / 2, a.y + a.height],
        [a.x + a.width / 2, a.y + a.height + lineGap / 2],
        [gutterX, a.y + a.height + lineGap / 2],
      ]
  const outX = out.at(-1)![0]
  const exit: Array<Point> = from.shelf.last
    ? [...out, [outX, track]]
    : [
        ...out,
        [outX, from.shelf.end + groupGap / 2],
        [from.shelf.rankCrossEnd + offset, from.shelf.end + groupGap / 2],
        [from.shelf.rankCrossEnd + offset, track],
      ]
  // Flowing down, a group's title sits in front of its first line.
  const straight = to.firstLine && (turned || !to.labelled)
  const into: Array<Point> = straight
    ? [
        [b.x + b.width / 2, b.y - lineGap / 2],
        [b.x + b.width / 2, b.y],
      ]
    : [
        [b.x - columnGap / 2, b.y - lineGap / 2],
        [b.x + b.width / 2, b.y - lineGap / 2],
        [b.x + b.width / 2, b.y],
      ]
  const inX = into[0]![0]
  const entry: Array<Point> =
    to.shelf.index === 0
      ? [[inX, track], ...into]
      : [
          [to.shelf.rankCrossStart - offset, track],
          [to.shelf.rankCrossStart - offset, to.shelf.start - groupGap / 2],
          [inX, to.shelf.start - groupGap / 2],
          ...into,
        ]
  return [...exit, ...entry]
}

/** Neighbours in a turned rank join around the side facing back. */
function bracket(a: InfraMapRect, b: InfraMapRect): Array<Point> {
  const top = Math.min(a.y, b.y) - columnGap / 2
  return [
    [a.x + a.width / 2, a.y],
    [a.x + a.width / 2, top],
    [b.x + b.width / 2, top],
    [b.x + b.width / 2, b.y],
  ]
}

function sideBySide(a: InfraMapRect, b: InfraMapRect): Array<Point> {
  const [left, right] = a.x <= b.x ? [a, b] : [b, a]
  const startY = left.y + left.height / 2
  const endY = right.y + right.height / 2
  const middle = (left.x + left.width + right.x) / 2
  return [
    [left.x + left.width, startY],
    [middle, startY],
    [middle, endY],
    [right.x, endY],
  ]
}

/** An orthogonal path through the points with rounded corners. */
function roundedPath(input: ReadonlyArray<Point>): string {
  const points = input.filter(
    (point, index) =>
      index === 0 ||
      point[0] !== input[index - 1]![0] ||
      point[1] !== input[index - 1]![1]
  )
  const [first, ...rest] = points
  if (!first) return ""
  let path = `M${first[0]} ${first[1]}`
  rest.forEach((point, index) => {
    const next = rest[index + 1]
    const previous = index === 0 ? first : rest[index - 1]!
    if (!next) {
      path += ` L${point[0]} ${point[1]}`
      return
    }
    const radius = Math.min(
      cornerRadius,
      distance(previous, point) / 2,
      distance(point, next) / 2
    )
    const before = toward(point, previous, radius)
    const after = toward(point, next, radius)
    path += ` L${before[0]} ${before[1]} Q${point[0]} ${point[1]} ${after[0]} ${after[1]}`
  })
  return path
}

function distance(a: Point, b: Point) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])
}

function toward(from: Point, to: Point, length: number): [number, number] {
  return [
    from[0] + Math.sign(to[0] - from[0]) * length,
    from[1] + Math.sign(to[1] - from[1]) * length,
  ]
}
