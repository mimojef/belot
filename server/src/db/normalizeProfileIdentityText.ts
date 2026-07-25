export const PROFILE_DISPLAY_NAME_INVALID_MESSAGE =
  'Името може да съдържа само букви на кирилица или латиница, цифри и по един интервал между думите.'

export const PROFILE_DISPLAY_NAME_LENGTH_MESSAGE =
  'Името трябва да е между 3 и 32 символа.'

export type ProfileIdentityValidationReason =
  | 'not-string'
  | 'length'
  | 'invalid-characters'

export type ProfileIdentityValidationResult =
  | {
      ok: true
      canonicalDisplayName: string
      normalizedKey: string
    }
  | {
      ok: false
      reason: ProfileIdentityValidationReason
      message: string
      canonicalCandidate: string
    }

const MIN_DISPLAY_NAME_LENGTH = 3
const MAX_DISPLAY_NAME_LENGTH = 32
const ALLOWED_DISPLAY_NAME_RE =
  /^[A-Za-zА-Яа-яЍѝ0-9]+(?: [A-Za-zА-Яа-яЍѝ0-9]+)*$/u
const COMBINING_MARK_RE = /\p{M}/u
const FORMAT_CHARACTER_RE = /\p{Cf}/u

export function canonicalizeProfileDisplayName(
  value: string | null | undefined,
): string | null {
  if (typeof value !== 'string') {
    return null
  }

  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

export function validateProfileDisplayName(
  value: string | null | undefined,
): ProfileIdentityValidationResult {
  const canonicalCandidate = canonicalizeProfileDisplayName(value) ?? ''

  if (typeof value !== 'string') {
    return {
      ok: false,
      reason: 'not-string',
      message: PROFILE_DISPLAY_NAME_INVALID_MESSAGE,
      canonicalCandidate,
    }
  }

  if (
    canonicalCandidate.length < MIN_DISPLAY_NAME_LENGTH ||
    canonicalCandidate.length > MAX_DISPLAY_NAME_LENGTH
  ) {
    return {
      ok: false,
      reason: 'length',
      message: PROFILE_DISPLAY_NAME_LENGTH_MESSAGE,
      canonicalCandidate,
    }
  }

  if (
    FORMAT_CHARACTER_RE.test(value) ||
    COMBINING_MARK_RE.test(value) ||
    !ALLOWED_DISPLAY_NAME_RE.test(canonicalCandidate)
  ) {
    return {
      ok: false,
      reason: 'invalid-characters',
      message: PROFILE_DISPLAY_NAME_INVALID_MESSAGE,
      canonicalCandidate,
    }
  }

  return {
    ok: true,
    canonicalDisplayName: canonicalCandidate,
    normalizedKey: canonicalCandidate.toLocaleLowerCase('bg-BG'),
  }
}

function normalizeProfileIdentityText(
  value: string | null | undefined,
): string | null {
  const result = validateProfileDisplayName(value)
  return result.ok ? result.normalizedKey : null
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

/**
 * Нормализира частичен search term по СЪЩИЯ начин, по който се записва
 * normalized_display_name (NFKC + collapse whitespace + trim + bg-BG
 * lowercase), но БЕЗ строгата дължина/regex валидация на пълно име —
 * търсеният фрагмент не е задължен да е валидно цяло display name.
 */
export function normalizeProfileSearchTerm(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('bg-BG')
}

/**
 * Ескейпва SQL LIKE wildcard символите (%, _, \), за да не бъдат
 * третирани като wildcard-и, когато потребителят ги въведе буквално.
 * Ползва се заедно с `ESCAPE '\'` в LIKE клаузата.
 */
export function escapeSqlLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}
