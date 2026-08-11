// Семантична валидация на тялото на root съобщение в "Теми" — отделен файл
// от lobbyChatValidation.ts (НЕ reuse чрез import), защото лимитите се
// различават (2000 срещу 300 code points, виж CLAUDE.md/Етап 2 брифа), но
// forbidden-code-point policy-то е identично на доказаната lobby chat
// конвенция — copy-нато нарочно, не абстрахирано в общ helper, за да не се
// coupling-ват двата чата само заради частично съвпадение в момента.

export const TOPIC_MESSAGE_MAX_BODY_CODE_POINTS = 2000

// Виж lobbyChatValidation.ts за пълния rationale на всеки range — същата
// policy: C0/C1 control chars, Unicode LINE/PARAGRAPH SEPARATOR, zero-width/
// joiner, bidi embedding/override, bidi isolates, BOM. НЕ блокираме обикновени
// \n (вътрешните нови редове се пазят — textarea composer, Shift+Enter).
const FORBIDDEN_CODE_POINT_RANGES: Array<[number, number]> = [
  [0x0000, 0x0009],
  [0x000b, 0x001f],
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

export function countTopicMessageCodePoints(value: string): number {
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

export type TopicMessageBodyValidationResult =
  | { ok: true; body: string }
  | { ok: false; code: 'empty_body' | 'body_too_long' | 'invalid_body' }

// trim() маха само outer whitespace (включително заграждащи \n) — вътрешните
// нови редове от textarea Shift+Enter се пазят непокътнати, за разлика от
// еднолинейния lobby chat input.
//
// `hasAttachment` (Топикс attachment feature) — image-only съобщения (празен
// текст + валидна снимка) са позволени: empty_body се връща САМО ако И
// текстът е празен, И няма attachment. Text validation (forbidden chars,
// max length) остава непроменена за съобщения, които ИМАТ текст — не се
// разхлабва, само empty-check-ът става условен.
export function validateTopicMessageBody(
  rawBody: string,
  hasAttachment: boolean = false,
): TopicMessageBodyValidationResult {
  const trimmed = rawBody.trim()

  if (trimmed.length === 0) {
    if (hasAttachment) {
      return { ok: true, body: '' }
    }
    return { ok: false, code: 'empty_body' }
  }

  if (containsForbiddenChars(trimmed)) {
    return { ok: false, code: 'invalid_body' }
  }

  if (countTopicMessageCodePoints(trimmed) > TOPIC_MESSAGE_MAX_BODY_CODE_POINTS) {
    return { ok: false, code: 'body_too_long' }
  }

  return { ok: true, body: trimmed }
}
