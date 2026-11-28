/**
 * checkTableChatService.ts — Етап 1: общият текстов чат на чакалните.
 *
 * Чисти проверки на tableChatService.ts с ИСТИНСКОТО хранилище
 * (privateRoomChatStore) и фалшиви адаптери на две игри, които ползват
 * ЕДНАКВИ tableId. Без сървър и без мрежа.
 *
 * Покрива: стар и нов протокол (формат на отговорите и на доставката),
 * изолация по игра и маса, еднакви идентификатори, непозната игра, подаден от
 * клиента чужд tableId, отказ за неоторизиран, напускане, reconnect с нова
 * връзка, единен mute (вкл. fail-closed), валидация, лимит за честота и
 * повторения, изчистване на историята само на конкретната маса.
 *
 * Пускане: cd server && npx tsx scripts/checkTableChatService.ts
 */

import { createPrivateRoomChatStore } from '../src/game/privateRoomChatStore.js'
import { createGameTableRegistry, type GameTableAdapter, type GameTableMembership } from '../src/tables/gameTableRegistry.js'
import { createTableChatService, type TableChatMuteSnapshot, type TableChatOutgoingMessage } from '../src/tables/tableChatService.js'
import { parseClientMessage } from '../src/protocol/parseClientMessage.js'

let passed = 0
let failed = 0
function check(label: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed++
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

// ─── Фалшив свят: две игри с маси с ЕДНАКВО id ───────────────────────────────

type Seat = { connectionId: string; profileId: string | null; displayName: string }
/** gameId -> tableId -> седналите (авторитетното състояние на играта). */
const world = new Map<string, Map<string, Seat[]>>()
const profileByConnection = new Map<string, string | null>()

function seat(gameId: string, tableId: string, connectionId: string, profileId: string | null, displayName: string): void {
  const tables = world.get(gameId) ?? new Map<string, Seat[]>()
  world.set(gameId, tables)
  const seats = tables.get(tableId) ?? []
  seats.push({ connectionId, profileId, displayName })
  tables.set(tableId, seats)
  profileByConnection.set(connectionId, profileId)
}
function unseat(gameId: string, tableId: string, connectionId: string): void {
  const seats = world.get(gameId)?.get(tableId) ?? []
  world.get(gameId)?.set(tableId, seats.filter((s) => s.connectionId !== connectionId))
}
function moveConnection(gameId: string, tableId: string, from: string, to: string): void {
  const seats = world.get(gameId)?.get(tableId) ?? []
  for (const s of seats) if (s.connectionId === from) s.connectionId = to
  profileByConnection.set(to, profileByConnection.get(from) ?? null)
}

function adapterFor(gameId: string, chatDelivery: GameTableAdapter['chatDelivery']): GameTableAdapter {
  return {
    gameId,
    chatDelivery,
    findMembership(connectionId): GameTableMembership | null {
      for (const [tableId, seats] of world.get(gameId) ?? []) {
        const member = seats.find((s) => s.connectionId === connectionId)
        if (member) return { tableId, member: { profileId: member.profileId, displayName: member.displayName }, recipientConnectionIds: seats.map((s) => s.connectionId) }
      }
      return null
    },
  }
}

const outbox: Array<{ to: string; message: TableChatOutgoingMessage }> = []
let muteImpl: (profileId: string) => TableChatMuteSnapshot = () => ({ isMuted: false, mutedUntil: null })
const errorLog: string[] = []
const accepted: string[] = []

const store = createPrivateRoomChatStore()
const chat = createTableChatService({
  registry: createGameTableRegistry([adapterFor('belot', 'legacy-private-room'), adapterFor('svara', 'table')]),
  store,
  getConnectionProfileId: (connectionId) => profileByConnection.get(connectionId),
  getMuteSnapshot: (profileId) => muteImpl(profileId),
  send: (to, message) => outbox.push({ to, message }),
  mutedMessage: 'MUTED',
  onMessageAccepted: (gameId) => accepted.push(gameId),
  logError: (line) => errorLog.push(line),
})

function take(): Array<{ to: string; message: any }> {
  return outbox.splice(0, outbox.length) as Array<{ to: string; message: any }>
}

const SAME_ID = 'table-0001'

seat('belot', SAME_ID, 'b-host', 'p-bh', 'Belot Host')
seat('belot', SAME_ID, 'b-guest', 'p-bg', 'Belot Guest')
seat('svara', SAME_ID, 's-host', 'p-sh', 'Svara Host')
seat('svara', SAME_ID, 's-guest', 'p-sg', 'Svara Guest')
profileByConnection.set('outsider', 'p-out')
profileByConnection.set('anon', null)

console.log('\ncheckTableChatService\n')

// ─── Стар протокол на Белот — непроменен формат ──────────────────────────────

check('[L1] legacy subscribe (member) -> private_room_chat_history{privateRoomId} with empty history', () => {
  chat.subscribe('b-host', { protocol: 'legacy', gameId: 'belot', tableId: SAME_ID })
  const out = take()
  assert(out.length === 1 && out[0]!.to === 'b-host', 'one reply to the requester')
  const m = out[0]!.message
  assert(m.type === 'private_room_chat_history' && m.privateRoomId === SAME_ID && Array.isArray(m.messages) && m.messages.length === 0, JSON.stringify(m))
  assert(!('gameId' in m) && !('tableId' in m), 'legacy frame must keep the old shape')
})

check('[L2] legacy send -> private_room_chat_message to BOTH members, requestId only to the sender, exact old fields', () => {
  chat.sendMessage('b-host', { protocol: 'legacy', gameId: 'belot', tableId: SAME_ID, body: '  Здравей!  ', requestId: 'r1' })
  const out = take()
  assert(out.length === 2, `expected 2 deliveries, got ${out.length}`)
  const toHost = out.find((o) => o.to === 'b-host')!.message
  const toGuest = out.find((o) => o.to === 'b-guest')!.message
  for (const m of [toHost, toGuest]) {
    assert(m.type === 'private_room_chat_message' && m.privateRoomId === SAME_ID, JSON.stringify(m))
    assert(m.body === 'Здравей!' && m.senderProfileId === 'p-bh' && m.senderDisplayName === 'Belot Host', 'trimmed body + sender from the authoritative seat')
    assert(typeof m.messageId === 'string' && typeof m.seq === 'number' && typeof m.createdAt === 'number', 'snapshot fields')
    const keys = Object.keys(m).sort().join(',')
    const expected = m === toHost
      ? 'body,createdAt,messageId,privateRoomId,requestId,senderDisplayName,senderProfileId,seq,type'
      : 'body,createdAt,messageId,privateRoomId,senderDisplayName,senderProfileId,seq,type'
    assert(keys === expected, `keys ${keys}`)
  }
  assert(toHost.requestId === 'r1' && !('requestId' in toGuest), 'requestId only echoed to the sender')
  assert(accepted.length === 1 && accepted[0] === 'belot', 'activity counter once')
})

check('[L3] legacy subscribe by an outsider / anonymous -> private_room_chat_error{not_member} without requestId, no history', () => {
  chat.subscribe('outsider', { protocol: 'legacy', gameId: 'belot', tableId: SAME_ID })
  chat.subscribe('anon', { protocol: 'legacy', gameId: 'belot', tableId: SAME_ID })
  const out = take()
  assert(out.length === 2, 'two errors')
  for (const o of out) {
    const m = o.message
    assert(m.type === 'private_room_chat_error' && m.code === 'not_member' && m.message === 'Не си в тази чакалня.', JSON.stringify(m))
    assert(Object.keys(m).sort().join(',') === 'code,message,type', `keys ${Object.keys(m)}`)
  }
})

check('[L4] legacy send: anonymous -> not_authenticated; outsider -> not_member (with requestId); nothing stored or delivered', () => {
  chat.sendMessage('anon', { protocol: 'legacy', gameId: 'belot', tableId: SAME_ID, body: 'x', requestId: 'ra' })
  chat.sendMessage('outsider', { protocol: 'legacy', gameId: 'belot', tableId: SAME_ID, body: 'intruder', requestId: 'ro' })
  const out = take()
  assert(out.length === 2 && out.every((o) => o.to === 'anon' || o.to === 'outsider'), 'only replies to the requesters')
  assert(out[0]!.message.code === 'not_authenticated' && out[0]!.message.requestId === 'ra', JSON.stringify(out[0]))
  assert(out[1]!.message.code === 'not_member' && out[1]!.message.requestId === 'ro', JSON.stringify(out[1]))
  assert(!store.listRecentMessages(`belot:${SAME_ID}`).some((m) => m.body === 'intruder'), 'intruder message stored')
})

check('[L5] legacy protocol never reaches another game (gameId forced to belot; a non-belot legacy target is refused)', () => {
  chat.subscribe('s-host', { protocol: 'legacy', gameId: 'svara', tableId: SAME_ID })
  const out = take()
  assert(out.length === 1 && out[0]!.message.type === 'private_room_chat_error' && out[0]!.message.code === 'not_member', JSON.stringify(out))
})

// ─── Нов протокол ────────────────────────────────────────────────────────────

check('[T1] table subscribe for belot -> table_chat_history with the SAME history as the legacy channel', () => {
  chat.subscribe('b-guest', { protocol: 'table', gameId: 'belot', tableId: SAME_ID })
  const m = take()[0]!.message
  assert(m.type === 'table_chat_history' && m.gameId === 'belot' && m.tableId === SAME_ID, JSON.stringify(m))
  assert(m.messages.length === 1 && m.messages[0].body === 'Здравей!', 'shared history')
})

check('[T2] table send for belot -> delivered in the LEGACY format (cached PWA clients keep working)', () => {
  chat.sendMessage('b-guest', { protocol: 'table', gameId: 'belot', tableId: SAME_ID, body: 'от новия протокол', requestId: 'r2' })
  const out = take()
  assert(out.length === 2 && out.every((o) => o.message.type === 'private_room_chat_message' && o.message.privateRoomId === SAME_ID), JSON.stringify(out))
  assert(out.find((o) => o.to === 'b-guest')!.message.requestId === 'r2' && !('requestId' in out.find((o) => o.to === 'b-host')!.message), 'requestId echo')
})

check('[T3] table errors use table_chat_error with gameId/tableId/requestId', () => {
  chat.sendMessage('outsider', { protocol: 'table', gameId: 'belot', tableId: SAME_ID, body: 'x', requestId: 'r3' })
  const m = take()[0]!.message
  assert(m.type === 'table_chat_error' && m.code === 'not_member' && m.gameId === 'belot' && m.tableId === SAME_ID && m.requestId === 'r3', JSON.stringify(m))
})

check('[T4] a game with chatDelivery "table" delivers table_chat_message{gameId,tableId}', () => {
  chat.sendMessage('s-host', { protocol: 'table', gameId: 'svara', tableId: SAME_ID, body: 'свара', requestId: 'r4' })
  const out = take()
  assert(out.length === 2 && out.every((o) => o.to === 's-host' || o.to === 's-guest'), 'only svara members')
  for (const o of out) assert(o.message.type === 'table_chat_message' && o.message.gameId === 'svara' && o.message.tableId === SAME_ID, JSON.stringify(o.message))
})

// ─── Изолация ────────────────────────────────────────────────────────────────

check('[I1] same tableId in two games -> separate histories', () => {
  const belot = store.listRecentMessages(`belot:${SAME_ID}`).map((m) => m.body)
  const svara = store.listRecentMessages(`svara:${SAME_ID}`).map((m) => m.body)
  assert(belot.join('|') === 'Здравей!|от новия протокол', `belot ${belot}`)
  assert(svara.join('|') === 'свара', `svara ${svara}`)
  chat.subscribe('s-guest', { protocol: 'table', gameId: 'svara', tableId: SAME_ID })
  const m = take()[0]!.message
  assert(m.messages.length === 1 && m.messages[0].body === 'свара', 'svara history has no belot messages')
})

check('[I2] a member of game A naming game B with the same tableId -> not_member (no history, no delivery)', () => {
  chat.subscribe('b-host', { protocol: 'table', gameId: 'svara', tableId: SAME_ID })
  chat.sendMessage('b-host', { protocol: 'table', gameId: 'svara', tableId: SAME_ID, body: 'cross-game' })
  const out = take()
  assert(out.length === 2 && out.every((o) => o.to === 'b-host' && o.message.type === 'table_chat_error' && o.message.code === 'not_member'), JSON.stringify(out))
  assert(!store.listRecentMessages(`svara:${SAME_ID}`).some((m) => m.body === 'cross-game'), 'cross-game stored')
})

check('[I3] a member naming ANOTHER table of the same game -> not_member', () => {
  seat('belot', 'table-0002', 'b-other', 'p-bo', 'Other')
  chat.subscribe('b-host', { protocol: 'table', gameId: 'belot', tableId: 'table-0002' })
  chat.sendMessage('b-host', { protocol: 'legacy', gameId: 'belot', tableId: 'table-0002', body: 'wrong table' })
  const out = take()
  assert(out.length === 2 && out.every((o) => o.to === 'b-host' && o.message.code === 'not_member'), JSON.stringify(out))
  assert(store.listRecentMessages('belot:table-0002').length === 0, 'wrong-table message stored')
})

check('[I4] unknown (unregistered) gameId -> not_member', () => {
  chat.subscribe('b-host', { protocol: 'table', gameId: 'ludo', tableId: SAME_ID })
  const m = take()[0]!.message
  assert(m.type === 'table_chat_error' && m.code === 'not_member' && m.gameId === 'ludo', JSON.stringify(m))
})

// ─── Напускане и reconnect ───────────────────────────────────────────────────

check('[R1] after leaving: the former member is refused (subscribe + send) and no longer receives messages', () => {
  unseat('belot', SAME_ID, 'b-guest')
  chat.subscribe('b-guest', { protocol: 'legacy', gameId: 'belot', tableId: SAME_ID })
  chat.sendMessage('b-guest', { protocol: 'table', gameId: 'belot', tableId: SAME_ID, body: 'след напускане' })
  chat.sendMessage('b-host', { protocol: 'legacy', gameId: 'belot', tableId: SAME_ID, body: 'само за хоста' })
  const out = take()
  assert(out[0]!.message.code === 'not_member' && out[1]!.message.code === 'not_member', 'former member refused')
  const deliveries = out.slice(2)
  assert(deliveries.length === 1 && deliveries[0]!.to === 'b-host', `deliveries ${JSON.stringify(deliveries)}`)
})

check('[R2] reconnect with a new connection: the new connection is a member, the old one is refused and gets nothing', () => {
  moveConnection('belot', SAME_ID, 'b-host', 'b-host-2')
  chat.subscribe('b-host-2', { protocol: 'legacy', gameId: 'belot', tableId: SAME_ID })
  const history = take()[0]!.message
  assert(history.type === 'private_room_chat_history' && history.messages.length === 3, JSON.stringify(history))
  chat.subscribe('b-host', { protocol: 'legacy', gameId: 'belot', tableId: SAME_ID })
  assert(take()[0]!.message.code === 'not_member', 'stale connection refused')
  seat('belot', SAME_ID, 'b-guest-2', 'p-bg', 'Belot Guest')
  chat.sendMessage('b-guest-2', { protocol: 'legacy', gameId: 'belot', tableId: SAME_ID, body: 'отново тук' })
  const out = take()
  assert(out.length === 2 && out.every((o) => o.to === 'b-host-2' || o.to === 'b-guest-2'), `recipients ${out.map((o) => o.to)}`)
})

// ─── Mute ────────────────────────────────────────────────────────────────────

check('[M1] muted sender -> muted error with mutedUntil/reason (both protocols); nothing stored or delivered', () => {
  muteImpl = () => ({ isMuted: true, mutedUntil: '2030-01-01T00:00:00.000Z', reason: 'спам' })
  const before = store.listRecentMessages(`belot:${SAME_ID}`).length
  chat.sendMessage('b-host-2', { protocol: 'legacy', gameId: 'belot', tableId: SAME_ID, body: 'muted 1', requestId: 'm1' })
  chat.sendMessage('s-host', { protocol: 'table', gameId: 'svara', tableId: SAME_ID, body: 'muted 2', requestId: 'm2' })
  const out = take()
  assert(out.length === 2, `deliveries ${out.length}`)
  const [legacy, table] = [out[0]!.message, out[1]!.message]
  assert(legacy.type === 'private_room_chat_error' && legacy.code === 'muted' && legacy.message === 'MUTED' && legacy.requestId === 'm1' && legacy.mutedUntil === '2030-01-01T00:00:00.000Z' && legacy.reason === 'спам', JSON.stringify(legacy))
  assert(table.type === 'table_chat_error' && table.code === 'muted' && table.requestId === 'm2' && table.mutedUntil === '2030-01-01T00:00:00.000Z', JSON.stringify(table))
  assert(store.listRecentMessages(`belot:${SAME_ID}`).length === before, 'stored while muted')
})

check('[M2] mute check throws -> fail-closed mute_check_unavailable; nothing stored or delivered; error logged', () => {
  muteImpl = () => { throw new Error('db locked') }
  const before = store.listRecentMessages(`belot:${SAME_ID}`).length
  chat.sendMessage('b-host-2', { protocol: 'legacy', gameId: 'belot', tableId: SAME_ID, body: 'fail closed', requestId: 'm3' })
  const out = take()
  assert(out.length === 1 && out[0]!.message.code === 'mute_check_unavailable' && out[0]!.message.requestId === 'm3', JSON.stringify(out))
  assert(store.listRecentMessages(`belot:${SAME_ID}`).length === before, 'stored despite failed check')
  assert(errorLog.some((line) => line.includes('[private-room-chat] mute check failed') && line.includes('db locked')), 'logged')
  muteImpl = () => ({ isMuted: false, mutedUntil: null })
})

check('[M3] the mute check runs AFTER the membership check (an outsider is never looked up)', () => {
  const looked: string[] = []
  muteImpl = (profileId) => { looked.push(profileId); return { isMuted: false } }
  chat.sendMessage('outsider', { protocol: 'table', gameId: 'belot', tableId: SAME_ID, body: 'x' })
  take()
  assert(looked.length === 0, `looked up ${looked}`)
  muteImpl = () => ({ isMuted: false, mutedUntil: null })
})

// ─── Валидация, честота, повторения ─────────────────────────────────────────

check('[V1] validation: empty / too long (301 code points) / forbidden chars -> exact old messages', () => {
  chat.sendMessage('s-guest', { protocol: 'table', gameId: 'svara', tableId: SAME_ID, body: '   ' })
  chat.sendMessage('s-guest', { protocol: 'table', gameId: 'svara', tableId: SAME_ID, body: 'я'.repeat(301) })
  chat.sendMessage('s-guest', { protocol: 'table', gameId: 'svara', tableId: SAME_ID, body: 'a‮b' })
  const out = take().map((o) => `${o.message.code}:${o.message.message}`)
  assert(out[0] === 'empty_body:Съобщението не може да бъде празно.', out[0]!)
  assert(out[1] === 'body_too_long:Съобщението може да е най-много 300 символа.', out[1]!)
  assert(out[2] === 'invalid_body:Съобщението съдържа неразрешени символи.', out[2]!)
})

check('[V2] duplicate within 8 s -> duplicate_message; rate limit 5 per 10 s -> rate_limited (same store limits)', () => {
  // Нов профил: лимитът е по профил (общ за всички маси), както досега.
  seat('belot', SAME_ID, 'b-fresh', 'p-fresh', 'Fresh')
  chat.sendMessage('b-fresh', { protocol: 'legacy', gameId: 'belot', tableId: SAME_ID, body: 'отново тук' })
  take()
  chat.sendMessage('b-fresh', { protocol: 'legacy', gameId: 'belot', tableId: SAME_ID, body: 'повтор' })
  chat.sendMessage('b-fresh', { protocol: 'legacy', gameId: 'belot', tableId: SAME_ID, body: 'повтор' })
  const dup = take().filter((o) => o.to === 'b-fresh' && o.message.type === 'private_room_chat_error')
  assert(dup.length === 1 && dup[0]!.message.code === 'duplicate_message' && dup[0]!.message.message === 'Вече изпрати това съобщение.', JSON.stringify(dup))
  // 'отново тук' + 'повтор' + 'повтор'(dup) = 3 в прозореца; още 2 минават, 6-тото е отказано.
  chat.sendMessage('b-fresh', { protocol: 'legacy', gameId: 'belot', tableId: SAME_ID, body: 'a1' })
  chat.sendMessage('b-fresh', { protocol: 'legacy', gameId: 'belot', tableId: SAME_ID, body: 'a2' })
  chat.sendMessage('b-fresh', { protocol: 'legacy', gameId: 'belot', tableId: SAME_ID, body: 'a3' })
  const errors = take().filter((o) => o.message.type === 'private_room_chat_error')
  assert(errors.length === 1 && errors[0]!.message.code === 'rate_limited' && errors[0]!.message.message === 'Твърде много съобщения. Изчакай малко и опитай пак.', JSON.stringify(errors))
})

// ─── Изчистване ──────────────────────────────────────────────────────────────

check('[C1] clearTable clears ONLY that game\'s table', () => {
  chat.clearTable('belot', SAME_ID)
  assert(store.listRecentMessages(`belot:${SAME_ID}`).length === 0, 'belot not cleared')
  assert(store.listRecentMessages(`svara:${SAME_ID}`).length === 1, 'svara cleared by mistake')
})

// ─── Структурна проверка на новите съобщения (parseClientMessage) ───────────

check('[P1] parser: valid table_chat messages are accepted; requestId trimmed/capped', () => {
  const sub = parseClientMessage(JSON.stringify({ type: 'subscribe_table_chat', gameId: 'belot', tableId: ' t1 ' }))
  assert(sub !== null && sub.type === 'subscribe_table_chat' && sub.tableId === 't1', JSON.stringify(sub))
  const send = parseClientMessage(JSON.stringify({ type: 'send_table_chat_message', gameId: 'svara', tableId: 't1', body: 'x', requestId: ` ${'r'.repeat(150)} ` }))
  assert(send !== null && send.type === 'send_table_chat_message' && send.requestId === 'r'.repeat(100), JSON.stringify(send))
  const unsub = parseClientMessage(JSON.stringify({ type: 'unsubscribe_table_chat', gameId: 'ludo', tableId: 't1' }))
  assert(unsub !== null && unsub.type === 'unsubscribe_table_chat', 'unsubscribe')
})

check('[P2] parser: invalid gameId / missing or oversized tableId / non-string body -> rejected', () => {
  const bad = [
    { type: 'subscribe_table_chat', gameId: 'Belot', tableId: 't1' },
    { type: 'subscribe_table_chat', gameId: 'belot!', tableId: 't1' },
    { type: 'subscribe_table_chat', gameId: 7, tableId: 't1' },
    { type: 'subscribe_table_chat', gameId: 'belot', tableId: '   ' },
    { type: 'subscribe_table_chat', gameId: 'belot', tableId: 'x'.repeat(129) },
    { type: 'send_table_chat_message', gameId: 'belot', tableId: 't1', body: 5 },
  ]
  for (const message of bad) assert(parseClientMessage(JSON.stringify(message)) === null, `accepted ${JSON.stringify(message)}`)
})

check('[P3] parser: the old Belot messages are parsed exactly as before', () => {
  const sub = parseClientMessage(JSON.stringify({ type: 'subscribe_private_room_chat', privateRoomId: 'r1' }))
  const send = parseClientMessage(JSON.stringify({ type: 'send_private_room_chat_message', privateRoomId: 'r1', body: 'b', requestId: 'q' }))
  assert(JSON.stringify(sub) === JSON.stringify({ type: 'subscribe_private_room_chat', privateRoomId: 'r1' }), JSON.stringify(sub))
  assert(JSON.stringify(send) === JSON.stringify({ type: 'send_private_room_chat_message', privateRoomId: 'r1', body: 'b', requestId: 'q' }), JSON.stringify(send))
})

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
