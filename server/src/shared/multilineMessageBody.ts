// Многоредови текстови съобщения — личният чат (приятели и „Екип Pika.bg“) и
// „Поддръжка“ (потребител и администратор). Споделен между клиента
// (src/app/lobby/*: проверка преди изпращане) и сървъра (server/src/db/
// chatStore.ts, supportStore.ts, index.ts: окончателното правило) — ЕДНО правило
// за двете страни. Без зависимости.
//
// Правило:
//   * нови редове: \r\n, \r, U+2028, U+2029 -> \n;
//   * контролни символи (C0/C1 без \n) се премахват, табулацията става интервал.
//     Emoji последователностите НЕ се засягат: ZWJ (U+200D), variation selectors
//     (U+FE0E/U+FE0F, U+E0100–U+E01EF), keycap (U+20E3), tag символи (флагове на
//     региони) и skin-tone модификатори не са контролни символи и не са \s;
//   * във всеки ред последователните интервали се сгъват до един и редът се
//     подрязва (както досега за целия текст);
//   * най-много 2 последователни празни реда; празните редове в началото и в
//     края се премахват;
//   * ограниченията (дължина и брой редове) се проверяват СЛЕД нормализирането;
//     при превишаване съобщението се отказва — текстът не се отрязва и новите
//     редове не се заменят с интервали.

export type MultilineMessageLimits = { maxLength: number; maxLines: number }

export const PERSONAL_CHAT_MESSAGE_LIMITS: MultilineMessageLimits = { maxLength: 1000, maxLines: 40 }
export const SUPPORT_MESSAGE_LIMITS: MultilineMessageLimits = { maxLength: 2000, maxLines: 60 }

/** Най-много последователни празни реда. */
export const MAX_CONSECUTIVE_EMPTY_LINES = 2

export type MultilineMessageBodyResult =
  | { ok: true; body: string; lines: number }
  | { ok: false; reason: 'too_long'; length: number; body: string }
  | { ok: false; reason: 'too_many_lines'; lines: number; body: string }

// C0 (без \n = U+000A) и C1 контролни символи, вкл. DEL. Табулацията се
// обработва отделно (става интервал) — тук не попада, защото е заменена преди това.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g

export function normalizeMultilineMessageBody(value: string, limits: MultilineMessageLimits): MultilineMessageBodyResult {
  const unified = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(/\t/g, ' ')
    .replace(CONTROL_CHARACTERS, '')
  const lines: string[] = []
  let emptyRun = 0
  for (const rawLine of unified.split('\n')) {
    // Само интервалите в реда (\s без \n — редът вече не съдържа \n).
    const line = rawLine.replace(/\s+/g, ' ').trim()
    if (line.length === 0) {
      if (lines.length === 0) continue // празни редове в началото
      emptyRun += 1
      if (emptyRun > MAX_CONSECUTIVE_EMPTY_LINES) continue
    } else {
      emptyRun = 0
    }
    lines.push(line)
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop() // празни редове в края
  const body = lines.join('\n')
  if (body.length > limits.maxLength) return { ok: false, reason: 'too_long', length: body.length, body }
  if (lines.length > limits.maxLines) return { ok: false, reason: 'too_many_lines', lines: lines.length, body }
  return { ok: true, body, lines: lines.length }
}

/** Разбираемо съобщение при отказ (същият текст на клиента и на сървъра). */
export function describeMultilineMessageLimit(result: Exclude<MultilineMessageBodyResult, { ok: true }>, limits: MultilineMessageLimits): string {
  return result.reason === 'too_many_lines'
    ? `Съобщението е твърде дълго: до ${limits.maxLines} реда (сега ${result.lines}). Съкратете го и опитайте отново.`
    : `Съобщението трябва да е до ${limits.maxLength} символа.`
}
