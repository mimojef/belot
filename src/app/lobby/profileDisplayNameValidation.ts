export const PROFILE_DISPLAY_NAME_INVALID_MESSAGE =
  'Името може да съдържа само букви на кирилица или латиница, цифри и по един интервал между думите.'

export const PROFILE_DISPLAY_NAME_LENGTH_MESSAGE =
  'Името трябва да е между 3 и 32 символа.'

export const PROFILE_DISPLAY_NAME_MIXED_ALPHABETS_MESSAGE =
  'Само кирилица или само латиница'

export const PROFILE_DISPLAY_NAME_RESERVED_PIKA_MESSAGE =
  'Това име е запазено за Екип Pika.bg'

export type ProfileDisplayNameValidationCode =
  | 'NOT_STRING'
  | 'LENGTH'
  | 'INVALID_CHARACTERS'
  | 'MIXED_ALPHABETS'
  | 'RESERVED_PIKA_NAME'

export type ProfileDisplayNameValidationReason =
  | 'not-string'
  | 'length'
  | 'invalid-characters'
  | 'mixed-alphabets'
  | 'reserved-pika-name'

export type ProfileDisplayNameValidationResult =
  | {
      ok: true
      canonicalDisplayName: string
      normalizedKey: string
    }
  | {
      ok: false
      reason: ProfileDisplayNameValidationReason
      code: ProfileDisplayNameValidationCode
      message: string
      canonicalCandidate: string
    }

export type ProfileDisplayNameValidationOptions = {
  profileId?: string | null
  officialPikaProfileId?: string | null
}

export const OFFICIAL_PIKA_PROFILE_ID = '4c146064-85af-4e6e-b08f-08faa39b167e'

const ALLOWED_DISPLAY_NAME_RE =
  /^[A-Za-zА-Яа-яЍѝ0-9]+(?: [A-Za-zА-Яа-яЍѝ0-9]+)*$/u
const COMBINING_MARK_RE = /\p{M}/u
const FORMAT_CHARACTER_RE = /\p{Cf}/u
const LATIN_LETTER_RE = /\p{Script=Latin}/u
const CYRILLIC_LETTER_RE = /\p{Script=Cyrillic}/u
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RESERVED_PIKA_NAME_KEY = 'PIKABG'

function normalizeOptionalUuid(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return UUID_RE.test(trimmed) ? trimmed.toLowerCase() : null
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

function isOfficialPikaProfile(options: ProfileDisplayNameValidationOptions): boolean {
  const profileId = normalizeOptionalUuid(options.profileId)
  const officialProfileId = normalizeOptionalUuid(options.officialPikaProfileId)

  return profileId !== null && officialProfileId !== null && profileId === officialProfileId
}

export function canonicalizeProfileDisplayName(
  value: string | null | undefined,
): string | null {
  if (typeof value !== 'string') return null
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

export function validateProfileDisplayName(
  value: string | null | undefined,
  options: ProfileDisplayNameValidationOptions = {},
): ProfileDisplayNameValidationResult {
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

  if (canonicalCandidate.length < 3 || canonicalCandidate.length > 32) {
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

  if (
    getReservedPikaDisplayNameKey(canonicalCandidate) === RESERVED_PIKA_NAME_KEY &&
    !isOfficialPikaProfile(options)
  ) {
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

export function getProfileDisplayNameAvailabilityQuery(
  value: string | null | undefined,
  options: ProfileDisplayNameValidationOptions = {},
): string | null {
  const validation = validateProfileDisplayName(value, options)
  return validation.ok ? validation.canonicalDisplayName : null
}
