// cmdk filter for the route command menu: every search term must match a
// route word exactly, by prefix, by substring, or within a small typo budget.
function editDistance(left: string, right: string) {
  const distances = Array.from({ length: left.length + 1 }, (_, row) =>
    Array.from({ length: right.length + 1 }, (_, column) =>
      row === 0 ? column : column === 0 ? row : 0
    )
  )

  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const substitutionCost = left[row - 1] === right[column - 1] ? 0 : 1

      distances[row]![column] = Math.min(
        distances[row - 1]![column]! + 1,
        distances[row]![column - 1]! + 1,
        distances[row - 1]![column - 1]! + substitutionCost
      )

      if (
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        distances[row]![column] = Math.min(
          distances[row]![column]!,
          distances[row - 2]![column - 2]! + 1
        )
      }
    }
  }

  return distances[left.length]![right.length]!
}

function scoreTerm(term: string, candidate: string) {
  if (candidate === term) return 1
  if (candidate.startsWith(term)) return 0.95
  if (candidate.includes(term)) return 0.9

  const allowedEdits = term.length >= 7 ? 2 : term.length >= 4 ? 1 : 0
  if (
    allowedEdits === 0 ||
    Math.abs(candidate.length - term.length) > allowedEdits
  ) {
    return 0
  }

  const distance = editDistance(term, candidate)
  return distance <= allowedEdits ? 0.75 - distance * 0.05 : 0
}

export function filterRoutes(
  value: string,
  search: string,
  keywords?: Array<string>
) {
  const terms = search.toLocaleLowerCase().match(/[a-z0-9]+/g) ?? []
  if (terms.length === 0) return 1

  const candidates =
    [value, ...(keywords ?? [])]
      .join(" ")
      .toLocaleLowerCase()
      .match(/[a-z0-9]+/g) ?? []

  const scores = terms.map((term) =>
    Math.max(...candidates.map((candidate) => scoreTerm(term, candidate)), 0)
  )

  return scores.every((score) => score > 0) ? Math.min(...scores) : 0
}
