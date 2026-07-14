import { isClipboardTextByteLengthOverLimit } from '../../../shared/clipboard-text'

export const QUICK_OPEN_RESULT_LIMIT = 50
export const QUICK_OPEN_QUERY_MAX_BYTES = 2 * 1024

export type QuickOpenIndexedFile = {
  path: string
  lowerPath: string
  lowerFilename: string
  /**
   * Per lowerPath index: 1 when the char is a word start (path start, after a
   * separator, or identifier transition). Built from the original-case path
   * so ProductDetail stays two words after lowercasing.
   */
  wordStarts: Uint8Array
  inputIndex: number
}

export type QuickOpenSearchResult = {
  path: string
  score: number
}

export function prepareQuickOpenFiles(files: readonly string[]): QuickOpenIndexedFile[] {
  return files.map((path, inputIndex) => {
    // Why: Quick Open presents slash-normalized paths even on Windows.
    const searchPath = path.replace(/\\/g, '/')
    const lastSlash = searchPath.lastIndexOf('/')
    const { lowerPath, wordStarts } = buildSearchPathIndex(searchPath)
    return {
      path,
      lowerPath,
      lowerFilename: searchPath.slice(lastSlash + 1).toLowerCase(),
      wordStarts,
      inputIndex
    }
  })
}

export function isQuickOpenQueryTooLarge(
  query: string,
  maxBytes = QUICK_OPEN_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export function rankQuickOpenFiles(
  query: string,
  files: readonly QuickOpenIndexedFile[],
  limit = QUICK_OPEN_RESULT_LIMIT
): QuickOpenSearchResult[] {
  if (limit <= 0) {
    return []
  }
  if (isQuickOpenQueryTooLarge(query)) {
    return []
  }

  // Why: Quick Open presents slash-normalized paths even on Windows; users
  // still naturally type backslashes in path queries. Collapse internal
  // whitespace so "Product  Detail" behaves like "Product Detail".
  const normalizedQuery = query.trim().replace(/\\/g, '/').toLowerCase().replace(/\s+/g, ' ')
  if (!normalizedQuery) {
    return files.slice(0, limit).map((file) => ({ path: file.path, score: 0 }))
  }
  const compactFilenameQuery = normalizedQuery.includes(' ')
    ? normalizedQuery.replace(/ /g, '')
    : null
  const hasFlexibleIdentifierSeparator =
    normalizedQuery.includes('_') || normalizedQuery.includes('-')

  const results: QuickOpenRankedResult[] = []
  for (const file of files) {
    const score = fuzzyMatchIndexedFile(
      normalizedQuery,
      compactFilenameQuery,
      hasFlexibleIdentifierSeparator,
      file
    )
    if (score === null) {
      continue
    }

    insertTopResult(results, { path: file.path, score, inputIndex: file.inputIndex }, limit)
  }

  return results.map(({ path, score }) => ({ path, score }))
}

/**
 * Fuzzy subsequence match with VS Code-like word separators:
 * - Spaces in the query match path separators (`_`, `-`, `/`, `.`) or a
 *   zero-width camelCase / word boundary.
 * - Hyphens and underscores are interchangeable identifier separators.
 * - Word-start hits score better so basename/token starts rank above distant
 *   character soup.
 */
function fuzzyMatchIndexedFile(
  query: string,
  compactFilenameQuery: string | null,
  hasFlexibleIdentifierSeparator: boolean,
  file: QuickOpenIndexedFile
): number | null {
  const path = file.lowerPath
  const wordStarts = file.wordStarts
  let qi = 0
  let score = 0
  let lastMatchIdx = -1
  let requireWordStart = false

  while (qi < query.length) {
    if (query[qi] === ' ') {
      qi++
      // Trailing space should not occur after normalize, but stay safe.
      if (qi >= query.length) {
        break
      }

      const nextIdx = lastMatchIdx + 1
      if (nextIdx < path.length && isPathSeparator(path[nextIdx])) {
        const gap = lastMatchIdx === -1 ? 0 : nextIdx - lastMatchIdx - 1
        score += gap
        // Separator runs are a single conceptual word break for spaced queries.
        score -= 5
        let sepIdx = nextIdx
        while (sepIdx + 1 < path.length && isPathSeparator(path[sepIdx + 1])) {
          sepIdx++
        }
        lastMatchIdx = sepIdx
        requireWordStart = false
      } else {
        // Why: "Product Detail" vs ProductDetail — no separator char, only a
        // camelCase boundary. Force the next letter onto a word start.
        requireWordStart = true
      }
      continue
    }

    const wanted = query[qi]
    let matched = false
    for (let ti = lastMatchIdx + 1; ti < path.length; ti++) {
      if (!searchCharactersMatch(path[ti], wanted)) {
        continue
      }
      if (requireWordStart && wordStarts[ti] !== 1) {
        continue
      }

      const gap = lastMatchIdx === -1 ? 0 : ti - lastMatchIdx - 1
      score += gap
      // Why: equivalent separators should match, but the literally typed form
      // should rank first when both filename variants exist.
      if (path[ti] !== wanted) {
        score++
      }
      // Why: skip path index 0 so a leading `s` in `src/...` stays score 0
      // (previous scorer only bonused matches after `/` `.` `-`).
      if (ti > 0 && wordStarts[ti] === 1) {
        score -= 5
      }
      lastMatchIdx = ti
      qi++
      requireWordStart = false
      matched = true
      break
    }

    if (!matched) {
      return null
    }
  }

  // Filename substring boost: allow human separators to hit equivalent names
  // (`product detail` / `product-detail` → product_detail.dart).
  if (
    filenameMatchesQuery(
      file.lowerFilename,
      query,
      compactFilenameQuery,
      hasFlexibleIdentifierSeparator
    )
  ) {
    score -= 100
  }

  return score
}

function filenameMatchesQuery(
  lowerFilename: string,
  query: string,
  compactQuery: string | null,
  hasFlexibleIdentifierSeparator: boolean
): boolean {
  if (
    lowerFilename.includes(query) ||
    (hasFlexibleIdentifierSeparator &&
      includesWithIdentifierSeparatorEquivalence(lowerFilename, query))
  ) {
    return true
  }
  if (!compactQuery) {
    return false
  }
  // Why: users type words with spaces; basenames use `_` / `-` / camelCase.
  return includesIgnoringSeparators(lowerFilename, compactQuery)
}

function includesWithIdentifierSeparatorEquivalence(value: string, wanted: string): boolean {
  const lastStart = value.length - wanted.length
  for (let start = 0; start <= lastStart; start++) {
    let offset = 0
    while (offset < wanted.length && searchCharactersMatch(value[start + offset], wanted[offset])) {
      offset++
    }
    if (offset === wanted.length) {
      return true
    }
  }
  return false
}

function includesIgnoringSeparators(value: string, wanted: string): boolean {
  for (let start = 0; start < value.length; start++) {
    if (value[start] !== wanted[0]) {
      continue
    }
    let valueIndex = start
    let wantedIndex = 0
    while (valueIndex < value.length && wantedIndex < wanted.length) {
      const ch = value[valueIndex]
      if (isPathSeparator(ch)) {
        valueIndex++
        continue
      }
      if (ch !== wanted[wantedIndex]) {
        break
      }
      valueIndex++
      wantedIndex++
    }
    if (wantedIndex === wanted.length) {
      return true
    }
  }
  return false
}

function isPathSeparator(ch: string): boolean {
  return ch === '/' || ch === '_' || ch === '-' || ch === '.' || ch === ' '
}

function searchCharactersMatch(valueChar: string, queryChar: string): boolean {
  return (
    valueChar === queryChar ||
    (isIdentifierSeparator(valueChar) && isIdentifierSeparator(queryChar))
  )
}

function isIdentifierSeparator(ch: string): boolean {
  return ch === '_' || ch === '-'
}

/**
 * Word starts from the original-case slash-normalized path so identifier
 * boundaries survive lowercasing in lowerPath.
 */
function buildSearchPathIndex(searchPath: string): {
  lowerPath: string
  wordStarts: Uint8Array
} {
  const lowerPath = searchPath.toLowerCase()
  const starts = new Uint8Array(lowerPath.length)
  let lowerIndex = 0
  for (let i = 0; i < searchPath.length; i++) {
    const curr = searchPath[i]
    const prev = i > 0 ? searchPath[i - 1] : ''
    const next = i + 1 < searchPath.length ? searchPath[i + 1] : ''
    if (
      i === 0 ||
      isPathSeparator(prev) ||
      (isAsciiLowerOrDigit(prev) && isAsciiUpper(curr)) ||
      (isAsciiUpper(prev) && isAsciiUpper(curr) && isAsciiLower(next))
    ) {
      starts[lowerIndex] = 1
    }
    // Why: Unicode lowercasing can expand one source character, so boundary
    // offsets must advance in lowerPath's coordinate space.
    lowerIndex += curr.toLowerCase().length
  }
  return { lowerPath, wordStarts: starts }
}

function isAsciiLowerOrDigit(ch: string): boolean {
  const code = ch.charCodeAt(0)
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122)
}

function isAsciiUpper(ch: string): boolean {
  const code = ch.charCodeAt(0)
  return code >= 65 && code <= 90
}

function isAsciiLower(ch: string): boolean {
  const code = ch.charCodeAt(0)
  return code >= 97 && code <= 122
}

type QuickOpenRankedResult = QuickOpenSearchResult & {
  inputIndex: number
}

function insertTopResult(
  results: QuickOpenRankedResult[],
  candidate: QuickOpenRankedResult,
  limit: number
): void {
  const worst = results.at(-1)
  if (results.length === limit && worst && compareRankedResult(candidate, worst) >= 0) {
    return
  }

  const insertAt = findInsertionIndex(results, candidate)
  results.splice(insertAt, 0, candidate)
  if (results.length > limit) {
    results.pop()
  }
}

function findInsertionIndex(
  results: readonly QuickOpenRankedResult[],
  candidate: QuickOpenRankedResult
): number {
  let low = 0
  let high = results.length

  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (compareRankedResult(candidate, results[mid]) < 0) {
      high = mid
    } else {
      low = mid + 1
    }
  }

  return low
}

function compareRankedResult(a: QuickOpenRankedResult, b: QuickOpenRankedResult): number {
  return a.score - b.score || a.inputIndex - b.inputIndex
}
