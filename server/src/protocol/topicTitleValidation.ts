// Семантична валидация на заглавието на custom тема в "Теми" — отделен файл
// от topicMessageValidation.ts (НЕ reuse чрез import), защото лимитите и
// use case-ът се различават (кратко еднолинейно заглавие срещу дълго тяло на
// съобщение), но forbidden-code-point policy-то е identично на доказаната
// конвенция — copy-нато нарочно, не абстрахирано в общ helper, за същата
// причина, поради която message body validation-ите не се споделят.

export const TOPIC_TITLE_MAX_CODE_POINTS = 80

// Виж topicMessageValidation.ts за пълния rationale на всеки range — същата
// policy: C0/C1 control chars, Unicode LINE/PARAGRAPH SEPARATOR, zero-width/
// joiner, bidi embedding/override, bidi isolates, BOM. Заглавието е
// еднолинейно поле — за разлика от message body, ТУК блокираме и обикновени
// \n (title не е multi-line textarea, а единичен <input>).
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

export function countTopicTitleCodePoints(value: string): number {
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

export type TopicTitleValidationResult =
  | { ok: true; title: string }
  | { ok: false; code: 'empty_title' | 'title_too_long' | 'invalid_title' }

export function validateTopicTitle(rawTitle: string): TopicTitleValidationResult {
  const trimmed = rawTitle.trim()

  if (trimmed.length === 0) {
    return { ok: false, code: 'empty_title' }
  }

  if (containsForbiddenChars(trimmed)) {
    return { ok: false, code: 'invalid_title' }
  }

  if (countTopicTitleCodePoints(trimmed) > TOPIC_TITLE_MAX_CODE_POINTS) {
    return { ok: false, code: 'title_too_long' }
  }

  return { ok: true, title: trimmed }
}

/** Case+whitespace-insensitive normalization за duplicate detection (spec т.6 — "Белот"/" белот "/"БЕЛОТ" = едно и също). */
export function normalizeTopicTitleForDuplicateCheck(title: string): string {
  return title.trim().toLowerCase()
}
