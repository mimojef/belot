const ALLOWED_DISPLAY_NAME_RE = /^[a-zA-Z0-9Ѐ-ӿ ]+$/

function normalizeProfileIdentityText(
  value: string | null | undefined,
): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim().replace(/\s+/g, ' ').normalize('NFKC')

  if (trimmed.length === 0) {
    return null
  }

  if (!ALLOWED_DISPLAY_NAME_RE.test(trimmed)) {
    return null
  }

  return trimmed.toLocaleLowerCase('bg-BG')
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
