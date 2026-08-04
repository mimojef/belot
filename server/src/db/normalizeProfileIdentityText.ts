export const PROFILE_DISPLAY_NAME_INVALID_MESSAGE =
  'Името може да съдържа само букви на кирилица или латиница, цифри и по един интервал между думите.'

export const PROFILE_DISPLAY_NAME_LENGTH_MESSAGE =
  'Името трябва да е между 3 и 32 символа.'

export const PROFILE_DISPLAY_NAME_MIXED_ALPHABETS_MESSAGE =
  'Само кирилица или само латиница'

export const PROFILE_DISPLAY_NAME_RESERVED_PIKA_MESSAGE =
  'Името не може да съдържа PIKABG, PIKA BG, ПИКАБГ или ПИКА БГ'

export type ProfileIdentityValidationCode =
  | 'NOT_STRING'
  | 'LENGTH'
  | 'INVALID_CHARACTERS'
  | 'MIXED_ALPHABETS'
  | 'RESERVED_PIKA_NAME'

export type ProfileIdentityValidationReason =
  | 'not-string'
  | 'length'
  | 'invalid-characters'
  | 'mixed-alphabets'
  | 'reserved-pika-name'

export type ProfileIdentityValidationResult =
  | {
      ok: true
      canonicalDisplayName: string
      normalizedKey: string
    }
  | {
      ok: false
      reason: ProfileIdentityValidationReason
      code: ProfileIdentityValidationCode
      message: string
      canonicalCandidate: string
    }

const MIN_DISPLAY_NAME_LENGTH = 3
const MAX_DISPLAY_NAME_LENGTH = 32
export const OFFICIAL_PIKA_PROFILE_ID = '4c146064-85af-4e6e-b08f-08faa39b167e'
const ALLOWED_DISPLAY_NAME_RE =
  /^[A-Za-zА-Яа-яЍѝ0-9]+(?: [A-Za-zА-Яа-яЍѝ0-9]+)*$/u
const COMBINING_MARK_RE = /\p{M}/u
const FORMAT_CHARACTER_RE = /\p{Cf}/u
const LATIN_LETTER_RE = /\p{Script=Latin}/u
const CYRILLIC_LETTER_RE = /\p{Script=Cyrillic}/u
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RESERVED_PIKA_NAME_KEY = 'PIKABG'
const RESERVED_PIKA_NAME_KEY_CYRILLIC = 'ПИКАБГ'

export type ProfileDisplayNameValidationOptions = {
  profileId?: string | null
  officialPikaProfileId?: string | null
}

function normalizeOptionalUuid(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return UUID_RE.test(trimmed) ? trimmed.toLowerCase() : null
}

export function getConfiguredOfficialPikaProfileId(
  value: string | null | undefined = process.env.PIKA_OFFICIAL_PROFILE_ID,
): string | null {
  return normalizeOptionalUuid(value)
}

function hasMixedLatinAndCyrillicLetters(value: string): boolean {
  return LATIN_LETTER_RE.test(value) && CYRILLIC_LETTER_RE.test(value)
}

export function getReservedPikaDisplayNameKey(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, '')
    .toLocaleUpperCase('bg-BG')
    .replace(/[Рр]/gu, 'P')
    .replace(/[Кк]/gu, 'K')
    .replace(/[Аа]/gu, 'A')
    .replace(/[Вв]/gu, 'B')
}

/**
 * Compact uppercase key (NFKC + strip whitespace + uppercase, no lookalike
 * mapping) used for containment checks — unlike getReservedPikaDisplayNameKey
 * this intentionally does NOT fold Cyrillic/Latin lookalikes, so it can be
 * tested against both the Latin and Cyrillic reserved sequences separately.
 */
function getCompactUppercaseKey(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').toLocaleUpperCase('bg-BG')
}

function containsReservedPikaSequence(value: string): boolean {
  const compactUpperName = getCompactUppercaseKey(value)
  return (
    compactUpperName.includes(RESERVED_PIKA_NAME_KEY) ||
    compactUpperName.includes(RESERVED_PIKA_NAME_KEY_CYRILLIC)
  )
}

function isOfficialPikaProfile(options: ProfileDisplayNameValidationOptions): boolean {
  const profileId = normalizeOptionalUuid(options.profileId)
  const officialProfileId = normalizeOptionalUuid(
    options.officialPikaProfileId ?? getConfiguredOfficialPikaProfileId(),
  )

  return profileId !== null && officialProfileId !== null && profileId === officialProfileId
}

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
  options: ProfileDisplayNameValidationOptions = {},
): ProfileIdentityValidationResult {
  const canonicalCandidate = canonicalizeProfileDisplayName(value) ?? ''

  if (typeof value !== 'string') {
    return {
      ok: false,
      reason: 'not-string',
      code: 'NOT_STRING',
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
      code: 'LENGTH',
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
      code: 'INVALID_CHARACTERS',
      message: PROFILE_DISPLAY_NAME_INVALID_MESSAGE,
      canonicalCandidate,
    }
  }

  if (hasMixedLatinAndCyrillicLetters(canonicalCandidate)) {
    return {
      ok: false,
      reason: 'mixed-alphabets',
      code: 'MIXED_ALPHABETS',
      message: PROFILE_DISPLAY_NAME_MIXED_ALPHABETS_MESSAGE,
      canonicalCandidate,
    }
  }

  const isExactOfficialReservedName =
    getReservedPikaDisplayNameKey(canonicalCandidate) === RESERVED_PIKA_NAME_KEY &&
    isOfficialPikaProfile(options)

  if (containsReservedPikaSequence(canonicalCandidate) && !isExactOfficialReservedName) {
    return {
      ok: false,
      reason: 'reserved-pika-name',
      code: 'RESERVED_PIKA_NAME',
      message: PROFILE_DISPLAY_NAME_RESERVED_PIKA_MESSAGE,
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
  options: ProfileDisplayNameValidationOptions = {},
): string | null {
  const result = validateProfileDisplayName(value, options)
  return result.ok ? result.normalizedKey : null
}

export function normalizeProfileDisplayName(
  value: string | null | undefined,
  options: ProfileDisplayNameValidationOptions = {},
): string | null {
  return normalizeProfileIdentityText(value, options)
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
