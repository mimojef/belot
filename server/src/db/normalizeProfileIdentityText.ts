function normalizeProfileIdentityText(
  value: string | null | undefined,
): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()

  if (trimmed.length === 0) {
    return null
  }

  return trimmed.replace(/\s+/g, ' ').normalize('NFKC').toLocaleLowerCase('bg-BG')
}

export function normalizeProfileDisplayName(
  value: string | null | undefined,
): string | null {
  return normalizeProfileIdentityText(value)
}

export function normalizeProfileUsername(
  value: string | null | undefined,
): string | null {
  return normalizeProfileIdentityText(value)
}
