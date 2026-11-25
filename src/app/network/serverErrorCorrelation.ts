// Етап 1 — към кой игрови контролер принадлежи {type:'error'} и на коя
// заявка отговаря. Сървърът добавя requestType централно (виж
// server/src/core/sendJsonMessage.ts): типът на клиентското съобщение, по
// време на чиято синхронна обработка е изпратена грешката, или null.
//
// Защо requestType е достатъчен (без requestId) за игровите команди:
//  - един WebSocket пази реда; сървърът обработва съобщенията на връзката
//    едно по едно и синхронно, а грешката се изпраща по време на обработката;
//  - клиентът държи най-много ЕДНА неотговорена команда от всеки вид
//    (цепене, обява, карта, решение за „разтваряне“, подарък) — следващата
//    се праща едва след отговор или resync;
//  - съобщенията от изоставен socket се игнорират в транспорта.
// При тези условия „грешка с requestType X“ еднозначно е отговорът на
// единствената чакаща команда X. requestId би бил нужен, ако някога се
// допуснат няколко едновременни команди от един вид или асинхронни
// отговори с грешка за игрова команда.
//
// Липсващ ключ requestType = стар сървър (преди Етап 1): запазва се
// досегашното поведение, освен за грешки с код ludo_* (винаги Ludo).

export type ServerErrorDomain = 'belot' | 'ludo' | 'svara' | 'general'

/** Командите на Белот масата (участник или зрител) — домейн 'belot'. */
const BELOT_TABLE_REQUEST_TYPES: ReadonlySet<string> = new Set([
  'request_player_profile', 'resume_room', 'leave_active_room', 'submit_bid_action', 'submit_cut_index',
  'submit_play_card', 'submit_sweep_decision', 'resume_human_control', 'submit_partner_rating',
  'request_replay', 'request_leave_match', 'send_emoji_reaction', 'send_phrase_reaction', 'send_table_gift',
  'watch_belot_room', 'unwatch_belot_room',
])

export type ServerErrorCorrelation =
  /** Сървър без корелация — досегашното поведение. */
  | { kind: 'legacy'; domain: ServerErrorDomain }
  /** Грешката не е синхронен отговор на заявка от тази връзка. */
  | { kind: 'uncorrelated'; domain: ServerErrorDomain }
  | { kind: 'request'; requestType: string; domain: ServerErrorDomain }

type ErrorLike = { type?: string; code?: unknown; requestType?: unknown }

function domainOfRequestType(requestType: string): ServerErrorDomain {
  if (requestType.includes('ludo')) return 'ludo'
  if (requestType.includes('svara')) return 'svara'
  if (BELOT_TABLE_REQUEST_TYPES.has(requestType)) return 'belot'
  return 'general'
}

export function getServerErrorCorrelation(message: ErrorLike): ServerErrorCorrelation {
  const codeDomain: ServerErrorDomain | null =
    typeof message.code === 'string' && message.code.startsWith('ludo_') ? 'ludo'
      : typeof message.code === 'string' && message.code.startsWith('svara_') ? 'svara'
        : null
  if (!('requestType' in message)) return { kind: 'legacy', domain: codeDomain ?? 'general' }
  if (typeof message.requestType !== 'string' || message.requestType.length === 0) {
    return { kind: 'uncorrelated', domain: codeDomain ?? 'general' }
  }
  return { kind: 'request', requestType: message.requestType, domain: codeDomain ?? domainOfRequestType(message.requestType) }
}

/** Грешка от друга игра — никога не стига до Белот контролера. */
export function isOtherGameErrorForBelot(message: ErrorLike): boolean {
  const domain = getServerErrorCorrelation(message).domain
  return domain === 'ludo' || domain === 'svara'
}

/** Грешка от друга игра (Белот маса / Svara) — никога не стига до Ludo. */
export function isOtherGameErrorForLudo(message: ErrorLike): boolean {
  const domain = getServerErrorCorrelation(message).domain
  return domain === 'belot' || domain === 'svara'
}

/** Грешка, която принадлежи на Ludo (по код или по заявката). */
export function isLudoDomainError(message: ErrorLike): boolean {
  return getServerErrorCorrelation(message).domain === 'ludo'
}

/**
 * Дали грешката е отговорът на чакаща команда от даден вид. Стар сървър —
 * досегашното поведение (всяка грешка се третира като възможен отговор).
 */
export function isErrorResponseTo(message: ErrorLike, requestTypes: readonly string[]): boolean {
  const correlation = getServerErrorCorrelation(message)
  if (correlation.kind === 'legacy') return true
  return correlation.kind === 'request' && requestTypes.includes(correlation.requestType)
}

/** Отговорите на Ludo игровите действия (хвърляне, ход, връщане). */
export const LUDO_GAMEPLAY_ACTION_REQUEST_TYPES = ['ludo_roll_request', 'ludo_move_request', 'ludo_reclaim_request'] as const
