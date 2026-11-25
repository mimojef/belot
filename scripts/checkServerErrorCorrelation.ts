/**
 * checkServerErrorCorrelation.ts — Етап 1: класификация на {type:'error'}
 * по игра (домейн) и по заявка (requestType). Без браузър.
 *
 *   [C1] стар сървър (без ключа requestType) -> legacy; isErrorResponseTo
 *        връща true (досегашното поведение), освен че ludo_* кодът е Ludo
 *   [C2] requestType: Ludo/Svara заявка -> ludo/svara; команда на Белот
 *        маса -> belot; останалите -> general; кой е „чужд“ за Белот и за Ludo
 *   [C3] код ludo_* винаги е Ludo, дори при чужда/липсваща заявка
 *   [C4] requestType: null -> uncorrelated (не е отговор на чакаща команда)
 *   [C5] isErrorResponseTo: само точният тип заявка; LUDO_GAMEPLAY_ACTION_REQUEST_TYPES
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkServerErrorCorrelation.ts
 */

import {
  getServerErrorCorrelation,
  isErrorResponseTo,
  isLudoDomainError,
  isOtherGameErrorForBelot,
  isOtherGameErrorForLudo,
  LUDO_GAMEPLAY_ACTION_REQUEST_TYPES,
} from '../src/app/network/serverErrorCorrelation'

let passed = 0
let failed = 0
function check(label: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

console.log('\ncheckServerErrorCorrelation\n')

check('[C1] стар сървър: legacy; всяка грешка е възможен отговор (досегашното поведение)', () => {
  const legacy = { type: 'error', message: 'Not your turn' }
  assert(getServerErrorCorrelation(legacy).kind === 'legacy', JSON.stringify(getServerErrorCorrelation(legacy)))
  assert(isErrorResponseTo(legacy, ['submit_play_card']) && isErrorResponseTo(legacy, ['submit_cut_index']), 'legacy трябва да запази поведението')
  assert(!isOtherGameErrorForBelot(legacy), 'legacy без код не е чужда игра')
  const legacyLudo = { type: 'error', code: 'ludo_match_not_found', message: 'Ludo играта не беше намерена.' }
  assert(isOtherGameErrorForBelot(legacyLudo) && isLudoDomainError(legacyLudo), 'legacy ludo_* е Ludo')
})

check('[C2] домейн по заявката: Ludo/Svara заявки -> ludo/svara; Белот и общи -> general', () => {
  const cases: Array<[string, string]> = [
    ['ludo_game_state_request', 'ludo'], ['ludo_roll_request', 'ludo'], ['join_ludo_room', 'ludo'], ['watch_ludo_match', 'ludo'],
    ['join_svara_table', 'svara'], ['submit_play_card', 'belot'], ['submit_bid_action', 'belot'],
    ['send_table_gift', 'belot'], ['resume_room', 'belot'], ['send_friend_request', 'general'], ['send_lobby_chat_message', 'general'],
  ]
  for (const [requestType, domain] of cases) {
    const correlation = getServerErrorCorrelation({ type: 'error', requestType })
    assert(correlation.kind === 'request' && correlation.domain === domain, `${requestType}: ${JSON.stringify(correlation)}`)
  }
  assert(isOtherGameErrorForBelot({ type: 'error', requestType: 'ludo_game_state_request' }), 'Ludo заявка е чужда за Белот')
  assert(!isOtherGameErrorForBelot({ type: 'error', requestType: 'submit_play_card' }), 'Белот заявка не е чужда')
  assert(!isOtherGameErrorForBelot({ type: 'error', requestType: 'send_friend_request' }), 'обща заявка не е чужда за Белот')
  assert(isOtherGameErrorForLudo({ type: 'error', requestType: 'submit_play_card' }), 'Белот команда е чужда за Ludo')
  assert(isOtherGameErrorForLudo({ type: 'error', requestType: 'join_svara_table' }), 'Svara е чужда за Ludo')
  assert(!isOtherGameErrorForLudo({ type: 'error', requestType: 'send_friend_request' }), 'обща заявка не е чужда за Ludo')
  assert(!isOtherGameErrorForLudo({ type: 'error', requestType: 'join_ludo_room' }), 'Ludo заявка не е чужда за Ludo')
  assert(!isOtherGameErrorForLudo({ type: 'error', message: 'legacy' }), 'стар сървър: досегашното поведение в Ludo')
})

check('[C3] код ludo_* винаги е Ludo — дори при requestType от друга заявка или null', () => {
  assert(isLudoDomainError({ type: 'error', code: 'ludo_match_not_turn', requestType: 'submit_play_card' }), 'код с предимство')
  assert(isLudoDomainError({ type: 'error', code: 'ludo_match_not_found', requestType: null }), 'uncorrelated ludo_*')
  assert(!isLudoDomainError({ type: 'error', code: 'private_room_full', requestType: 'join_private_room' }), 'чужд код')
})

check('[C4] requestType: null -> uncorrelated; не е отговор на никоя команда', () => {
  const message = { type: 'error', message: 'Invalid message payload.', requestType: null }
  assert(getServerErrorCorrelation(message).kind === 'uncorrelated', JSON.stringify(getServerErrorCorrelation(message)))
  assert(!isErrorResponseTo(message, ['submit_play_card', 'submit_bid_action', 'submit_cut_index']), 'uncorrelated засегна команда')
  assert(getServerErrorCorrelation({ type: 'error', requestType: '' }).kind === 'uncorrelated', 'празен низ = uncorrelated')
})

check('[C5] isErrorResponseTo: само точният тип заявка; Ludo игровите действия', () => {
  const play = { type: 'error', requestType: 'submit_play_card' }
  assert(isErrorResponseTo(play, ['submit_play_card']), 'съвпадение')
  assert(!isErrorResponseTo(play, ['submit_bid_action']) && !isErrorResponseTo(play, ['submit_cut_index']), 'чужда команда')
  for (const t of ['ludo_roll_request', 'ludo_move_request', 'ludo_reclaim_request']) {
    assert(isErrorResponseTo({ type: 'error', requestType: t }, LUDO_GAMEPLAY_ACTION_REQUEST_TYPES), t)
  }
  assert(!isErrorResponseTo({ type: 'error', requestType: 'submit_play_card' }, LUDO_GAMEPLAY_ACTION_REQUEST_TYPES), 'Белот грешка не е Ludo действие')
  assert(!isErrorResponseTo({ type: 'error', requestType: 'ludo_game_state_request' }, LUDO_GAMEPLAY_ACTION_REQUEST_TYPES), 'пробата не е игрово действие')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
