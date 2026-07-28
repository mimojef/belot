// Семантична валидация на тялото на съобщение в чата на чакалнята на частна
// маса. Огледало на lobbyChatValidation.ts (същите забранени code point
// диапазони + лимит по Unicode code points), но отделен модул, защото
// лимитът и грешките са специфични за този канал.

export const PRIVATE_ROOM_CHAT_MAX_BODY_CODE_POINTS = 300

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
  return FORBIDDEN_CODE_POINT_RANGES.some(
    ([start, end]) => codePoint >= start && codePoint <= end,
  )
}

function countUnicodeCodePoints(value: string): number {
  return Array.from(value).length
}

function containsForbiddenChars(value: string): boolean {
  for (const char of value) {
    if (isForbiddenCodePoint(char.codePointAt(0) ?? 0)) {
      return true
    }
  }
  return false
}

export type PrivateRoomChatBodyValidationResult =
  | { ok: true; body: string }
  | { ok: false; code: 'empty_body' | 'body_too_long' | 'invalid_body' }

export function validatePrivateRoomChatBody(rawBody: string): PrivateRoomChatBodyValidationResult {
  const trimmed = rawBody.trim()

  if (trimmed.length === 0) {
    return { ok: false, code: 'empty_body' }
  }

  if (containsForbiddenChars(trimmed)) {
    return { ok: false, code: 'invalid_body' }
  }

  if (countUnicodeCodePoints(trimmed) > PRIVATE_ROOM_CHAT_MAX_BODY_CODE_POINTS) {
    return { ok: false, code: 'body_too_long' }
  }

  return { ok: true, body: trimmed }
}
