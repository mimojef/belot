/**
 * checkPikaSupportChatUnreadBadge.ts
 *
 * Production bug (втори slice от pika_team direct chat routing incident-а):
 * след routeByConversation fix-а kind='pika_support' разговори (role-based
 * pika_team direct chat ИЛИ истински official профил) правилно отварят
 * нормалния Chat panel и се показват в chat списъка (renderChatPanel filter,
 * виж checkPikaTeamDirectChatNotificationRouting.ts), НО общият Chat badge
 * (getFriendChatUnreadRaw, renderLobbyScreen.ts) explicit сумираше само
 * kind==='friend' (sumConversationUnreadByKind(state, 'friend')) — pika_team
 * direct message оставяше unread ред в списъка, ВИДИМ при отваряне на Чат,
 * но badge-ът на бутона никога не се увеличаваше (+1 discrepancy).
 *
 * Fix: getFriendChatUnreadRaw сега сумира И 'friend', И 'pika_support' —
 * генеричен pipeline, не pika_team-specific hack (без hardcoded PIKABG/
 * profileId проверка никъде в badge aggregation логиката).
 *
 * Този файл тества чистите функции directly (без DOM/HTTP) — pure
 * state → number transformации, safe за import.
 *
 * [1]  getFriendChatUnreadRaw сумира kind='friend' unreadCount-и (baseline, непроменено поведение)
 * [2]  getFriendChatUnreadRaw сумира kind='pika_support' unreadCount-и (production bug fix — role-based pika_team sender)
 * [3]  getFriendChatUnreadRaw сумира kind='pika_support' unreadCount, независимо дали sender е "истински" official profile (без initiator-based distinction — единна семантика)
 * [4]  getFriendChatUnreadRaw смесен списък (friend + pika_support + vip_dm) сумира само friend+pika_support, изключва vip_dm
 * [5]  getFriendChatUnreadRaw с unreadCount=0 навсякъде → 0 (no false positive badge)
 * [6]  getFriendChatUnreadRaw НЕ съдържа hardcoded "PIKABG" text или hardcoded profileId literal — чист kind-based pipeline
 * [7]  getTopicsPersonalUnreadRaw (vip_dm) остава непроменено — само 'vip_dm', pika_support fix не изтича в друг badge
 * [8]  getSupportUnreadRaw (supportStore-based "Връзка с екипа") НЕ reference-ва state.chatConversations изобщо — supportStore остава напълно изолиран от Chat badge fix-а
 * [9]  formatNotificationBadgeCount(0) === null (без "0" badge display)
 * [10] Пример от заявката: badge=2 преди, ново pika_team direct message → badge=3 (крайно-към-край сумиране от mixed conversation list)
 *
 * CASE A/B/D/E source-check (controller ниво, WS handler + mark-read flow):
 * [11] chat_message_received handler увеличава unreadCount по friendshipId, БЕЗ kind филтър/branch (CASE A/B — работи еднакво за friend и pika_support)
 * [12] chat_message_received handler нулира unreadCount, когато разговорът е active (isActivePersonalChatConversation) — established behavior, непроменено
 * [13] openAsNormalChat (routeByConversation "Виж" branch, CASE D) вика markChatConversationReadLocally + onChatMarkRead — mark-read flow идентичен за pika_support и friend (без специално pika_team правило)
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  getFriendChatUnreadRaw,
  getTopicsPersonalUnreadRaw,
  getSupportUnreadRaw,
  formatNotificationBadgeCount,
  type LobbyScreenState,
} from '../../src/app/lobby/renderLobbyScreen.js'
import type { ChatConversationSnapshot } from '../../src/app/network/createGameServerClient.js'

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..')

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ FAIL: ${label}`)
    failed++
  }
}

function makeConversation(overrides: Partial<ChatConversationSnapshot> & { kind: ChatConversationSnapshot['kind']; unreadCount: number }): ChatConversationSnapshot {
  return {
    friendshipId: overrides.friendshipId ?? `conv-${Math.random().toString(36).slice(2)}`,
    friend: {
      profileId: 'friend-profile-id',
      displayName: 'Играч',
      avatarUrl: null,
    } as unknown as ChatConversationSnapshot['friend'],
    lastMessage: null,
    updatedAt: new Date().toISOString(),
    isArchived: false,
    ...overrides,
  }
}

function makeState(chatConversations: ChatConversationSnapshot[], extra: Partial<LobbyScreenState> = {}): LobbyScreenState {
  return {
    chatConversations,
    supportUnreadCount: 0,
    isAdmin: false,
    adminGuestContactUnreadCount: 0,
    ...extra,
  } as unknown as LobbyScreenState
}

console.log('\ncheckPikaSupportChatUnreadBadge')

// [1] baseline: само 'friend'
check(
  '[1] getFriendChatUnreadRaw сумира kind=\'friend\' unreadCount-и (baseline)',
  getFriendChatUnreadRaw(makeState([
    makeConversation({ kind: 'friend', unreadCount: 2 }),
    makeConversation({ kind: 'friend', unreadCount: 1 }),
  ])) === 3,
)

// [2] production bug fix: 'pika_support' се брои
check(
  "[2] getFriendChatUnreadRaw сумира kind='pika_support' unreadCount-и (production bug fix)",
  getFriendChatUnreadRaw(makeState([
    makeConversation({ kind: 'pika_support', unreadCount: 1 }),
  ])) === 1,
)

// [3] Без initiator-based distinction — единна семантика за pika_support
// (role-based pika_team ИЛИ official profile, badge aggregation-ът не
// различава — потвърждава, че deep-dive fix-ът от routing сесията остана в
// сила: няма discriminator поле, значи badge-ът просто брои по kind).
check(
  "[3] getFriendChatUnreadRaw сумира kind='pika_support' независимо от 'кой' е initiator-ът (без discriminator field)",
  getFriendChatUnreadRaw(makeState([
    makeConversation({ kind: 'pika_support', unreadCount: 1, friendshipId: 'role-based-pika-team-conv' }),
    makeConversation({ kind: 'pika_support', unreadCount: 1, friendshipId: 'official-profile-conv' }),
  ])) === 2,
)

// [4] mixed списък — vip_dm изключен
check(
  '[4] getFriendChatUnreadRaw смесен списък сумира само friend+pika_support, изключва vip_dm',
  getFriendChatUnreadRaw(makeState([
    makeConversation({ kind: 'friend', unreadCount: 2 }),
    makeConversation({ kind: 'pika_support', unreadCount: 1 }),
    makeConversation({ kind: 'vip_dm', unreadCount: 5 }),
  ])) === 3,
)

// [5] всичко нула → 0
check(
  '[5] getFriendChatUnreadRaw с unreadCount=0 навсякъде → 0',
  getFriendChatUnreadRaw(makeState([
    makeConversation({ kind: 'friend', unreadCount: 0 }),
    makeConversation({ kind: 'pika_support', unreadCount: 0 }),
  ])) === 0,
)

// [6] source-check: без hardcoded PIKABG/profileId workaround
const renderSrc = readFileSync(resolve(PROJECT_ROOT, 'src/app/lobby/renderLobbyScreen.ts'), 'utf8')
const getFriendChatUnreadRawStartIdx = renderSrc.indexOf('export function getFriendChatUnreadRaw(')
const getFriendChatUnreadRawSrc = getFriendChatUnreadRawStartIdx >= 0
  ? renderSrc.slice(getFriendChatUnreadRawStartIdx, getFriendChatUnreadRawStartIdx + 900)
  : ''
check(
  '[6] getFriendChatUnreadRaw изолиран за source-check',
  getFriendChatUnreadRawSrc.length > 0,
)
check(
  '[6] getFriendChatUnreadRaw НЕ съдържа "PIKABG" text match — чист kind-based pipeline',
  !getFriendChatUnreadRawSrc.includes('PIKABG'),
)
check(
  '[6] getFriendChatUnreadRaw НЕ съдържа hardcoded UUID literal (profileId workaround)',
  !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(getFriendChatUnreadRawSrc),
)
check(
  '[6] getFriendChatUnreadRaw вика sumConversationUnreadByKind за И двата kind (\'friend\' и \'pika_support\')',
  getFriendChatUnreadRawSrc.includes("sumConversationUnreadByKind(state, 'friend')") &&
    getFriendChatUnreadRawSrc.includes("sumConversationUnreadByKind(state, 'pika_support')"),
)

// [7] vip_dm badge непроменено
check(
  "[7] getTopicsPersonalUnreadRaw сумира само kind='vip_dm' (pika_support fix не изтича в друг badge)",
  getTopicsPersonalUnreadRaw(makeState([
    makeConversation({ kind: 'friend', unreadCount: 10 }),
    makeConversation({ kind: 'pika_support', unreadCount: 10 }),
    makeConversation({ kind: 'vip_dm', unreadCount: 4 }),
  ])) === 4,
)

// [8] supportStore остава изолиран
const getSupportUnreadRawStartIdx = renderSrc.indexOf('export function getSupportUnreadRaw(')
const getSupportUnreadRawSrc = getSupportUnreadRawStartIdx >= 0
  ? renderSrc.slice(getSupportUnreadRawStartIdx, getSupportUnreadRawStartIdx + 300)
  : ''
check(
  '[8] getSupportUnreadRaw изолиран за source-check',
  getSupportUnreadRawSrc.length > 0,
)
check(
  '[8] getSupportUnreadRaw НЕ reference-ва state.chatConversations (supportStore остава напълно изолиран от Chat badge fix-а)',
  !getSupportUnreadRawSrc.includes('chatConversations'),
)
check(
  '[8] getSupportUnreadRaw runtime: chatConversations с unread НЕ влияе на support badge-а',
  getSupportUnreadRaw(makeState(
    [makeConversation({ kind: 'pika_support', unreadCount: 99 })],
    { supportUnreadCount: 0 },
  )) === 0,
)

// [9] null при 0
check(
  '[9] formatNotificationBadgeCount(0) === null (без "0" badge display)',
  formatNotificationBadgeCount(0) === null,
)

// [10] Примерът от заявката: badge=2 → ново pika_team direct message → badge=3
check(
  '[10] Пример от заявката: badge=2 (2× friend unread=1) + ново pika_support unread=1 → badge=3',
  (() => {
    const before = getFriendChatUnreadRaw(makeState([
      makeConversation({ kind: 'friend', unreadCount: 1 }),
      makeConversation({ kind: 'friend', unreadCount: 1 }),
    ]))
    const after = getFriendChatUnreadRaw(makeState([
      makeConversation({ kind: 'friend', unreadCount: 1 }),
      makeConversation({ kind: 'friend', unreadCount: 1 }),
      makeConversation({ kind: 'pika_support', unreadCount: 1 }),
    ]))
    return before === 2 && after === 3
  })(),
)

// [11]-[13] Controller-level source-check (WS handler + mark-read flow)
const controllerSrc = readFileSync(resolve(PROJECT_ROOT, 'src/app/lobby/createLobbyFlowController.ts'), 'utf8')

const chatMessageReceivedStartIdx = controllerSrc.indexOf("if (message.type === 'chat_message_received') {")
const chatMessageReceivedSrc = chatMessageReceivedStartIdx >= 0
  ? controllerSrc.slice(chatMessageReceivedStartIdx, chatMessageReceivedStartIdx + 900)
  : ''
check(
  '[11] chat_message_received handler изолиран за проверка',
  chatMessageReceivedSrc.length > 0,
)
check(
  '[11] chat_message_received handler увеличава unreadCount по friendshipId lookup (state.chatConversations.find), без conversation.kind проверка (CASE A/B — generic за всички kinds)',
  chatMessageReceivedSrc.includes('c.friendshipId === message.friendshipId') &&
    chatMessageReceivedSrc.includes('existingConversation.unreadCount + 1') &&
    !chatMessageReceivedSrc.includes('conversation.kind') &&
    !chatMessageReceivedSrc.includes('.kind ==='),
)
check(
  '[12] chat_message_received handler нулира unreadCount при active conversation (isActivePersonalChatConversation) — established behavior',
  chatMessageReceivedSrc.includes('isActivePersonalChatConversation(message.friendshipId)') &&
    /isActiveConversation\r?\n\s*\? 0/.test(chatMessageReceivedSrc),
)

const openAsNormalChatStartIdx2 = controllerSrc.indexOf('const openAsNormalChat = (): void => {')
const openAsNormalChatSrc2 = openAsNormalChatStartIdx2 >= 0
  ? controllerSrc.slice(openAsNormalChatStartIdx2, openAsNormalChatStartIdx2 + 500)
  : ''
check(
  '[13] openAsNormalChat (CASE D "Виж" mark-read flow) изолиран за проверка',
  openAsNormalChatSrc2.length > 0,
)
check(
  '[13] openAsNormalChat вика markChatConversationReadLocally + onChatMarkRead — mark-read идентичен за pika_support и friend (обединен branch в routeByConversation, без pika_team-specific клон)',
  openAsNormalChatSrc2.includes('markChatConversationReadLocally(friendshipId)') &&
    openAsNormalChatSrc2.includes('options.onChatMarkRead?.(friendshipId)'),
)

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
