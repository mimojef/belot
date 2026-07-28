// Семантична валидация на тялото на съобщение в общия лайв чат на лобито.
// Отделена от parseClientMessage.ts, защото тук връщаме конкретна причина
// за отказ (index.ts я превръща в lobby_chat_error.code), а не generic null.

export const LOBBY_CHAT_MAX_BODY_CODE_POINTS = 300

// C0/C1 control chars (покрива и \r \n \t) + Unicode LINE/PARAGRAPH SEPARATOR
// (u2028/u2029 — "нов ред" извън ASCII \n\r, .trim() ги маха само в началото/
// края на низа, не и в средата) + zero-width/joiner символи (u200B-u200F) +
// explicit bidi embedding/override (u202A-u202E) + bidi isolates (u2066-u2069)
// + BOM (uFEFF). Целта е spam/exploit-облекчаващи невидими, "нов ред" или
// bidi-spoofing символи — НЕ блокираме variation selectors (напр. uFE0F), за
// да не чупим легитимни emoji.
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

export function countUnicodeCodePoints(value: string): number {
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

export type LobbyChatBodyValidationResult =
  | { ok: true; body: string }
  | { ok: false; code: 'empty_body' | 'body_too_long' | 'invalid_body' }

export function validateLobbyChatBody(rawBody: string): LobbyChatBodyValidationResult {
  const trimmed = rawBody.trim()

  if (trimmed.length === 0) {
    return { ok: false, code: 'empty_body' }
  }

  if (containsForbiddenChars(trimmed)) {
    return { ok: false, code: 'invalid_body' }
  }

  if (countUnicodeCodePoints(trimmed) > LOBBY_CHAT_MAX_BODY_CODE_POINTS) {
    return { ok: false, code: 'body_too_long' }
  }

  return { ok: true, body: trimmed }
}
