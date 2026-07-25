/**
 * Чиста функция за pagination номерация: `< 1 2 3 4 … >`.
 * Малък брой страници → показва всички номера. Много страници → винаги
 * показва първа/последна + прозорец от ±1 около текущата, останалото —
 * многоточие.
 */
export type PaginationItem = number | 'ellipsis'

const ALWAYS_SHOW_ALL_THRESHOLD = 7

export function computePaginationItems(currentPage: number, totalPages: number): PaginationItem[] {
  if (totalPages <= 0) return []
  if (totalPages <= ALWAYS_SHOW_ALL_THRESHOLD) {
    return Array.from({ length: totalPages }, (_, i) => i + 1)
  }

  const clampedCurrent = Math.min(Math.max(1, currentPage), totalPages)
  const pages = new Set<number>([1, totalPages, clampedCurrent])
  if (clampedCurrent - 1 >= 1) pages.add(clampedCurrent - 1)
  if (clampedCurrent + 1 <= totalPages) pages.add(clampedCurrent + 1)

  const sorted = [...pages].sort((a, b) => a - b)
  const items: PaginationItem[] = []
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i]! - sorted[i - 1]! > 1) {
      items.push('ellipsis')
    }
    items.push(sorted[i]!)
  }
  return items
}
