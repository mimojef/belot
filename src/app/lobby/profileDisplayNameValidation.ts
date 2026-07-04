export const PROFILE_DISPLAY_NAME_INVALID_MESSAGE =
  'Името може да съдържа само букви на кирилица или латиница, цифри и по един интервал между думите.'

export const PROFILE_DISPLAY_NAME_LENGTH_MESSAGE =
  'Името трябва да е между 3 и 32 символа.'

export type ProfileDisplayNameValidationResult =
  | {
      ok: true
      canonicalDisplayName: string
      normalizedKey: string
    }
  | {
      ok: false
      reason: 'not-string' | 'length' | 'invalid-characters'
      message: string
      canonicalCandidate: string
    }

const ALLOWED_DISPLAY_NAME_RE =
  /^[A-Za-zА-Яа-яЍѝ0-9]+(?: [A-Za-zА-Яа-яЍѝ0-9]+)*$/u
const COMBINING_MARK_RE = /\p{M}/u
const FORMAT_CHARACTER_RE = /\p{Cf}/u

export function canonicalizeProfileDisplayName(
  value: string | null | undefined,
): string | null {
  if (typeof value !== 'string') return null
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

export function validateProfileDisplayName(
  value: string | null | undefined,
): ProfileDisplayNameValidationResult {
  const canonicalCandidate = canonicalizeProfileDisplayName(value) ?? ''

  if (typeof value !== 'string') {
    return {
      ok: false,
      reason: 'not-string',
      message: PROFILE_DISPLAY_NAME_INVALID_MESSAGE,
      canonicalCandidate,
    }
  }

  if (canonicalCandidate.length < 3 || canonicalCandidate.length > 32) {
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

export function getProfileDisplayNameAvailabilityQuery(
  value: string | null | undefined,
): string | null {
  const validation = validateProfileDisplayName(value)
  return validation.ok ? validation.canonicalDisplayName : null
}
