/**
 * checkLobbyChatAdminNameColor.ts
 *
 * Реален render тест (не текстов grep върху цялото приложение) на
 * renderLobbyChatMessageRow — единствената функция, която рисува имената в
 * общия лайв чат. renderLobbyChatMessageRow е export-нат специално за този
 * тест (само видимост, без промяна в поведение), огледално на
 * checkPlayersDirectoryOnlineStatusVisibility.ts.
 *
 * [1] senderIsChatAdmin:true → името е в приглушен teal (#14b8a6), не злато.
 * [2] senderIsChatAdmin:false (обикновен player/admin/subadmin автор) →
 *     името остава на стандартното злато (#d4a520) — НЕПРОМЕНЕНО.
 * [3] Изтриващият бутон "(×)" се показва само когато canDeleteLobbyChat:true,
 *     независимо от senderIsChatAdmin на автора на съобщението.
 * [4] Съобщението/текстът на реда не се променят от senderIsChatAdmin —
 *     оцветява се само елементът с името.
 */

import {
  renderLobbyChatMessageRow,
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

const TEAL_NAME_MARKER = 'color:#14b8a6;font-weight:900;'
const GOLD_NAME_MARKER = 'color:#d4a520;font-weight:900;'
const PINK_NAME_MARKER = 'color:#f472b6;font-weight:900;text-shadow:0 0 8px rgba(244,114,182,0.35);'

function main(): void {
  check('[1] senderIsChatAdmin:true → името е в приглушен teal (#14b8a6)', () => {
    const html = renderLobbyChatMessageRow(makeState(false), makeMessage({ senderIsChatAdmin: true, senderRole: 'chat_admin' }))
    assert(html.includes(TEAL_NAME_MARKER), 'трябва да съдържа teal стила на името')
    assert(!html.includes(GOLD_NAME_MARKER), 'не трябва да съдържа златния стил, докато е chat_admin')
  })

  check('[2] senderIsChatAdmin:false → името остава злато (#d4a520), непроменено', () => {
    const html = renderLobbyChatMessageRow(makeState(false), makeMessage({ senderIsChatAdmin: false }))
    assert(html.includes(GOLD_NAME_MARKER), 'трябва да съдържа стандартния златен стил')
    assert(!html.includes(TEAL_NAME_MARKER), 'не трябва да съдържа teal стила за обикновен автор')
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

  check('[2b] senderRole:pika_team -> pink author name only', () => {
    const html = renderLobbyChatMessageRow(makeState(false), makeMessage({ senderRole: 'pika_team' }))
    assert(html.includes(PINK_NAME_MARKER), 'expected pink pika_team author-name style')
    assert(!html.includes(TEAL_NAME_MARKER), 'pika_team must not reuse chat_admin teal style')
    assert(html.includes('color:#f1f5f9;font-weight:500;'), 'message body style must stay unchanged')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
