/**
 * checkLobbyChatAdminNameColor.ts
 *
 * Реален render тест (не текстов grep върху цялото приложение) на
 * renderLobbyChatMessageRow — единствената функция, която рисува имената в
 * общия лайв чат. renderLobbyChatMessageRow е export-нат специално за този
 * тест (само видимост, без промяна в поведение), огледално на
 * checkPlayersDirectoryOnlineStatusVisibility.ts.
 *
 * [1] senderIsChatAdmin:true → името е в лилаво (#c084fc), не злато.
 * [2] senderIsChatAdmin:false (обикновен player/admin/subadmin автор) →
 *     името остава на стандартното злато (#d4a520) — НЕПРОМЕНЕНО.
 * [3] Изтриващият бутон "(×)" се показва само когато canDeleteLobbyChat:true,
 *     независимо от senderIsChatAdmin на автора на съобщението.
 * [4] Съобщението/текстът на реда не се променят от senderIsChatAdmin —
 *     оцветява се само елементът с името.
 */

import {
  getLobbyChatAuthorNameStyle,
  renderLobbyChatMessageRow,
  resolveLobbyChatSenderRole,
  type LobbyScreenState,
} from '../../src/app/lobby/renderLobbyScreen.js'
import type { LobbyChatMessageSnapshot } from '../../src/app/network/createGameServerClient.js'

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
function check(label: string, fn: () => void): void {
  try {
    fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

function makeMessage(overrides: Partial<LobbyChatMessageSnapshot> = {}): LobbyChatMessageSnapshot {
  return {
    seq: 1,
    messageId: 'msg-1',
    senderProfileId: 'sender-1',
    senderDisplayName: 'Тест Автор',
    senderIsChatAdmin: false,
    senderRole: 'player',
    body: 'Здравейте от общия чат',
    createdAt: new Date('2026-07-29T10:00:00Z').toISOString(),
    ...overrides,
  }
}

function makeState(canDeleteLobbyChat: boolean): LobbyScreenState {
  return { canDeleteLobbyChat } as unknown as LobbyScreenState
}

const GOLD_NAME_MARKER = 'color:#d4a520;font-weight:900;'
const RED_NAME_MARKER = 'color:#ef4444;font-weight:900;text-shadow:0 0 8px rgba(239,68,68,0.35);'
const PURPLE_NAME_MARKER = 'color:#c084fc;font-weight:900;text-shadow:0 0 10px rgba(192,132,252,0.42),0 0 18px rgba(192,132,252,0.22);'

function main(): void {
  check('[1] senderRole:chat_admin -> purple author name only', () => {
    const html = renderLobbyChatMessageRow(makeState(false), makeMessage({ senderIsChatAdmin: true, senderRole: 'chat_admin' }))
    assert(html.includes(PURPLE_NAME_MARKER), 'expected purple chat_admin author-name style')
    assert(!html.includes(GOLD_NAME_MARKER), 'chat_admin must not use the default author style')
  })

  check('[2] senderRole:player -> default gold author name unchanged', () => {
    const html = renderLobbyChatMessageRow(makeState(false), makeMessage({ senderIsChatAdmin: false, senderRole: 'player' }))
    assert(html.includes(GOLD_NAME_MARKER), 'трябва да съдържа стандартния златен стил')
    assert(!html.includes(PURPLE_NAME_MARKER), 'normal player must not use purple role style')
  })

  check('[3a] canDeleteLobbyChat:true → бутонът "(×)" присъства, независимо от senderIsChatAdmin', () => {
    const htmlChatAdminMsg = renderLobbyChatMessageRow(makeState(true), makeMessage({ senderIsChatAdmin: true, senderRole: 'chat_admin' }))
    const htmlPlayerMsg = renderLobbyChatMessageRow(makeState(true), makeMessage({ senderIsChatAdmin: false }))
    assert(htmlChatAdminMsg.includes('data-lobby-livechat-delete='), 'трябва да съдържа delete бутона (chat_admin съобщение)')
    assert(htmlPlayerMsg.includes('data-lobby-livechat-delete='), 'трябва да съдържа delete бутона (обикновено съобщение)')
  })

  check('[3b] canDeleteLobbyChat:false → бутонът "(×)" липсва, независимо от senderIsChatAdmin', () => {
    const htmlChatAdminMsg = renderLobbyChatMessageRow(makeState(false), makeMessage({ senderIsChatAdmin: true, senderRole: 'chat_admin' }))
    const htmlPlayerMsg = renderLobbyChatMessageRow(makeState(false), makeMessage({ senderIsChatAdmin: false }))
    assert(!htmlChatAdminMsg.includes('data-lobby-livechat-delete='), 'не трябва да съдържа delete бутона (chat_admin съобщение)')
    assert(!htmlPlayerMsg.includes('data-lobby-livechat-delete='), 'не трябва да съдържа delete бутона (обикновено съобщение)')
  })

  check('[4] само елементът с името се оцветява — текстът на съобщението остава #f1f5f9 и в двата случая', () => {
    const htmlChatAdmin = renderLobbyChatMessageRow(makeState(false), makeMessage({ senderIsChatAdmin: true, body: 'Уникален текст X' }))
    const htmlPlayer = renderLobbyChatMessageRow(makeState(false), makeMessage({ senderIsChatAdmin: false, body: 'Уникален текст X' }))
    assert(htmlChatAdmin.includes('color:#f1f5f9;font-weight:500;'), 'текстът на съобщението трябва да остане непроменен (chat_admin)')
    assert(htmlPlayer.includes('color:#f1f5f9;font-weight:500;'), 'текстът на съобщението трябва да остане непроменен (обикновен автор)')
  })

  check('[2b] senderRole:pika_team -> red author name only', () => {
    const html = renderLobbyChatMessageRow(makeState(false), makeMessage({ senderRole: 'pika_team' }))
    assert(html.includes(RED_NAME_MARKER), 'expected red pika_team author-name style')
    assert(!html.includes(PURPLE_NAME_MARKER), 'pika_team must not reuse chat admin purple style')
    assert(html.includes('color:#f1f5f9;font-weight:500;'), 'message body style must stay unchanged')
  })

  check('[2c] senderRole:top_chat_admin -> same purple glow as chat_admin', () => {
    const html = renderLobbyChatMessageRow(makeState(false), makeMessage({ senderRole: 'top_chat_admin' }))
    assert(html.includes(PURPLE_NAME_MARKER), 'expected purple top_chat_admin author-name style')
    assert(!html.includes(RED_NAME_MARKER), 'top_chat_admin must not reuse pika_team red style')
    assert(html.includes('color:#f1f5f9;font-weight:500;'), 'message body style must stay unchanged')
  })

  check('[2d] senderRole:admin and senderRole:subadmin -> default gold author name unchanged', () => {
    const htmlAdmin = renderLobbyChatMessageRow(makeState(false), makeMessage({ senderRole: 'admin' }))
    const htmlSubadmin = renderLobbyChatMessageRow(makeState(false), makeMessage({ senderRole: 'subadmin' }))
    assert(htmlAdmin.includes(GOLD_NAME_MARKER), 'admin author name should use the standard color')
    assert(htmlSubadmin.includes(GOLD_NAME_MARKER), 'subadmin author name should use the standard color')
    assert(!htmlAdmin.includes(PURPLE_NAME_MARKER) && !htmlSubadmin.includes(PURPLE_NAME_MARKER), 'admin/subadmin must not use purple role style')
    assert(!htmlAdmin.includes(RED_NAME_MARKER) && !htmlSubadmin.includes(RED_NAME_MARKER), 'admin/subadmin must not use red role style')
  })

  check('[2e] history/live/legacy role normalization keeps the same author colors', () => {
    const historyPika = makeMessage({ messageId: 'history-pika', senderRole: 'pika_team' })
    const livePika = makeMessage({ messageId: 'live-pika', senderRole: 'pika_team' })
    const legacyChatAdmin = { senderIsChatAdmin: true }
    const legacyMissingRole = { senderIsChatAdmin: false }
    const legacyInvalidRole = { senderIsChatAdmin: false, senderRole: 'pika-team' as never }

    assert(renderLobbyChatMessageRow(makeState(false), historyPika).includes(RED_NAME_MARKER), 'old/history pika_team message should render red')
    assert(renderLobbyChatMessageRow(makeState(false), livePika).includes(RED_NAME_MARKER), 'new/live pika_team message should render red')
    assert(resolveLobbyChatSenderRole(legacyChatAdmin) === 'chat_admin', 'legacy senderIsChatAdmin should normalize to chat_admin')
    assert(resolveLobbyChatSenderRole(legacyMissingRole) === 'player', 'missing non-admin role should normalize to player')
    assert(resolveLobbyChatSenderRole(legacyInvalidRole) === 'player', 'invalid role should normalize to player')
    assert(getLobbyChatAuthorNameStyle(legacyChatAdmin).color === '#c084fc', 'legacy chat_admin should use purple')
    assert(getLobbyChatAuthorNameStyle(legacyMissingRole).color === '#d4a520', 'legacy missing role should use default')
    assert(getLobbyChatAuthorNameStyle(legacyInvalidRole).color === '#d4a520', 'legacy invalid role should use default')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
