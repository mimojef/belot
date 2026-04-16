import type { PlayerIdentitySnapshot } from './serverTypes.js'

function normalizeDisplayName(value: string | null | undefined): string {
  if (typeof value !== 'string') {
    return 'Гост'
  }

  const trimmed = value.trim()

  if (trimmed.length === 0) {
    return 'Гост'
  }

  return trimmed
}

export function createDisplayNameIdentityPatch(
  displayName: string | null | undefined,
): Partial<PlayerIdentitySnapshot> {
  return {
    displayName: normalizeDisplayName(displayName),
  }
}