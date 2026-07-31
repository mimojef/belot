// Валидация на входни полета за създаване на турнир. Огледало на
// privateRoomChatValidation.ts (същите забранени code point диапазони +
// лимит по Unicode code points), но отделен модул със собствени граници.

import { TOURNAMENT_START_MODES, TOURNAMENT_VISIBILITIES } from './tournamentTypes.js'
import type { TournamentStartMode, TournamentVisibility } from './tournamentTypes.js'

export const TOURNAMENT_NAME_MIN_CODE_POINTS = 3
export const TOURNAMENT_NAME_MAX_CODE_POINTS = 40

export const TOURNAMENT_PASSWORD_MIN_LENGTH = 4
export const TOURNAMENT_PASSWORD_MAX_LENGTH = 32

// Единствените разрешени входни стойности — server-side whitelist е
// задължителен (клиентският <select> не е достатъчен, виж продуктовото
// изискване).
export const ALLOWED_TOURNAMENT_ENTRY_FEES = [5000, 10000, 20000, 50000, 100000] as const
export type AllowedTournamentEntryFee = (typeof ALLOWED_TOURNAMENT_ENTRY_FEES)[number]

// Броят отбори, който потребителят избира при създаване — сървърът винаги
// изчислява playerCapacity = teamCapacity * 2, никога не приема
// client-provided playerCapacity директно (виж createTournament handler-а).
export const ALLOWED_TOURNAMENT_TEAM_CAPACITIES = [4, 8, 16] as const
export type AllowedTournamentTeamCapacity = (typeof ALLOWED_TOURNAMENT_TEAM_CAPACITIES)[number]

export const TOURNAMENT_SCHEDULED_START_MIN_LEAD_MS = 30 * 60 * 1000
export const TOURNAMENT_SCHEDULED_START_MAX_LEAD_MS = 7 * 24 * 60 * 60 * 1000

const FORBIDDEN_CODE_POINT_RANGES: Array<[number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x2028, 0x2029],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
]

function isForbiddenCodePoint(codePoint: number): boolean {
  return FORBIDDEN_CODE_POINT_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end)
}

function countUnicodeCodePoints(value: string): number {
  return Array.from(value).length
}

function containsForbiddenChars(value: string): boolean {
  for (const char of value) {
    if (isForbiddenCodePoint(char.codePointAt(0) ?? 0)) return true
  }
  return false
}

// Груб, но достатъчен HTML/markup детектор — самото рендиране винаги минава
// през escapeHtml на клиента (defense-in-depth), но отхвърляме explicit "<"
// на входа, за да не позволим дори опит.
function containsHtmlMarkup(value: string): boolean {
  return value.includes('<') || value.includes('>')
}

export type TournamentNameValidationResult =
  | { ok: true; name: string }
  | { ok: false; code: 'empty' | 'too_short' | 'too_long' | 'invalid_characters' }

export function validateTournamentName(rawName: string): TournamentNameValidationResult {
  const trimmed = rawName.normalize('NFKC').trim()

  if (trimmed.length === 0) {
    return { ok: false, code: 'empty' }
  }
  if (containsForbiddenChars(trimmed) || containsHtmlMarkup(trimmed)) {
    return { ok: false, code: 'invalid_characters' }
  }

  const codePointCount = countUnicodeCodePoints(trimmed)
  if (codePointCount < TOURNAMENT_NAME_MIN_CODE_POINTS) {
    return { ok: false, code: 'too_short' }
  }
  if (codePointCount > TOURNAMENT_NAME_MAX_CODE_POINTS) {
    return { ok: false, code: 'too_long' }
  }

  return { ok: true, name: trimmed }
}

export function isAllowedTournamentEntryFee(value: number): value is AllowedTournamentEntryFee {
  return (ALLOWED_TOURNAMENT_ENTRY_FEES as readonly number[]).includes(value)
}

export function isAllowedTournamentTeamCapacity(value: number): value is AllowedTournamentTeamCapacity {
  return (ALLOWED_TOURNAMENT_TEAM_CAPACITIES as readonly number[]).includes(value)
}

export function isValidTournamentVisibility(value: unknown): value is TournamentVisibility {
  return (TOURNAMENT_VISIBILITIES as readonly unknown[]).includes(value)
}

export function isValidTournamentStartMode(value: unknown): value is TournamentStartMode {
  return (TOURNAMENT_START_MODES as readonly unknown[]).includes(value)
}

export type TournamentPasswordValidationResult =
  | { ok: true; password: string }
  | { ok: false; code: 'too_short' | 'too_long' }

// НЕ trim-ва паролата (продуктово изискване) — само дължина в UTF-16 units
// (паролите не са display текст, code-point броене не е нужно тук).
export function validateTournamentPassword(rawPassword: string): TournamentPasswordValidationResult {
  if (rawPassword.length < TOURNAMENT_PASSWORD_MIN_LENGTH) {
    return { ok: false, code: 'too_short' }
  }
  if (rawPassword.length > TOURNAMENT_PASSWORD_MAX_LENGTH) {
    return { ok: false, code: 'too_long' }
  }
  return { ok: true, password: rawPassword }
}

export type TournamentScheduledStartValidationResult =
  | { ok: true; scheduledStartAt: string }
  | { ok: false; code: 'invalid_timestamp' | 'too_soon' | 'too_late' }

export function validateTournamentScheduledStartAt(
  rawIsoTimestamp: string,
  nowMs: number = Date.now(),
): TournamentScheduledStartValidationResult {
  const parsedMs = Date.parse(rawIsoTimestamp)
  if (Number.isNaN(parsedMs)) {
    return { ok: false, code: 'invalid_timestamp' }
  }

  const leadMs = parsedMs - nowMs
  if (leadMs < TOURNAMENT_SCHEDULED_START_MIN_LEAD_MS) {
    return { ok: false, code: 'too_soon' }
  }
  if (leadMs > TOURNAMENT_SCHEDULED_START_MAX_LEAD_MS) {
    return { ok: false, code: 'too_late' }
  }

  return { ok: true, scheduledStartAt: new Date(parsedMs).toISOString() }
}
