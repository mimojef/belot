/**
 * checkLobbyChatAdminNameColor.ts
 *
 * Targeted render regression for the shared lobby live chat author-name style.
 * It verifies real HTML from renderLobbyChatMessageRow and the shared role
 * helpers used by history and live WebSocket messages.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
    senderDisplayName: 'Test Author',
    senderIsChatAdmin: false,
    senderRole: 'player',
    body: 'Hello from the lobby chat',
    createdAt: new Date('2026-07-29T10:00:00Z').toISOString(),
    ...overrides,
  }
}

function makeState(canDeleteLobbyChat: boolean): LobbyScreenState {
  return { canDeleteLobbyChat } as unknown as LobbyScreenState
}

type AuthorStyle = { color: string; extraStyle: string }

const DEFAULT_AUTHOR_STYLE: AuthorStyle = { color: '#d4a520', extraStyle: '' }
const PREVIOUS_CHAT_ADMIN_PURPLE_STYLE: AuthorStyle = {
  color: '#c084fc',
  extraStyle: 'text-shadow:0 0 10px rgba(192,132,252,0.42),0 0 18px rgba(192,132,252,0.22);',
}

function authorNameMarker(style: AuthorStyle): string {
  return `color:${style.color};font-weight:900;${style.extraStyle}`
}

function assertStyleEquals(actual: AuthorStyle, expected: AuthorStyle, msg: string): void {
  assert(actual.color === expected.color && actual.extraStyle === expected.extraStyle, `${msg}: actual=${JSON.stringify(actual)}`)
}

const GOLD_NAME_MARKER = authorNameMarker(DEFAULT_AUTHOR_STYLE)
const PURPLE_NAME_MARKER = authorNameMarker(PREVIOUS_CHAT_ADMIN_PURPLE_STYLE)
const MESSAGE_BODY_STYLE_MARKER = 'color:#f1f5f9;font-weight:500;'
const controllerSource = readFileSync(resolve(process.cwd(), '../src/app/lobby/createLobbyFlowController.ts'), 'utf8')

function main(): void {
  check('[1] senderRole:pika_team -> previous chat-admin purple glow author name only', () => {
    const msg = makeMessage({ senderRole: 'pika_team' })
    const html = renderLobbyChatMessageRow(makeState(false), msg)

    assertStyleEquals(getLobbyChatAuthorNameStyle(msg), PREVIOUS_CHAT_ADMIN_PURPLE_STYLE, 'pika_team should use the previous chat-admin purple glow style')
    assert(html.includes(PURPLE_NAME_MARKER), 'expected purple pika_team author-name style')
    assert(html.includes(MESSAGE_BODY_STYLE_MARKER), 'message body style must stay unchanged')
  })

  check('[2] senderRole:chat_admin -> default player author name style', () => {
    const msg = makeMessage({ senderIsChatAdmin: true, senderRole: 'chat_admin' })
    const html = renderLobbyChatMessageRow(makeState(false), msg)

    assertStyleEquals(getLobbyChatAuthorNameStyle(msg), DEFAULT_AUTHOR_STYLE, 'chat_admin should use default author style')
    assert(html.includes(GOLD_NAME_MARKER), 'chat_admin must use the default author style')
    assert(!html.includes(PURPLE_NAME_MARKER), 'chat_admin must not use purple role style')
  })

  check('[3] senderRole:top_chat_admin -> default player author name style', () => {
    const msg = makeMessage({ senderRole: 'top_chat_admin' })
    const html = renderLobbyChatMessageRow(makeState(false), msg)

    assertStyleEquals(getLobbyChatAuthorNameStyle(msg), DEFAULT_AUTHOR_STYLE, 'top_chat_admin should use default author style')
    assert(html.includes(GOLD_NAME_MARKER), 'top_chat_admin must use the default author style')
    assert(!html.includes(PURPLE_NAME_MARKER), 'top_chat_admin must not use purple role style')
    assert(html.includes(MESSAGE_BODY_STYLE_MARKER), 'message body style must stay unchanged')
  })

  check('[4] senderRole:player/admin/subadmin -> default gold author name unchanged', () => {
    for (const senderRole of ['player', 'admin', 'subadmin'] as const) {
      const msg = makeMessage({ senderRole })
      const html = renderLobbyChatMessageRow(makeState(false), msg)

      assertStyleEquals(getLobbyChatAuthorNameStyle(msg), DEFAULT_AUTHOR_STYLE, `${senderRole} should keep default author style`)
      assert(html.includes(GOLD_NAME_MARKER), `${senderRole} author name should use the standard color`)
      assert(!html.includes(PURPLE_NAME_MARKER), `${senderRole} must not use purple role style`)
    }
  })

  check('[5] canDeleteLobbyChat only controls delete button, not author color', () => {
    const htmlPika = renderLobbyChatMessageRow(makeState(true), makeMessage({ senderRole: 'pika_team' }))
    const htmlPlayer = renderLobbyChatMessageRow(makeState(true), makeMessage({ senderRole: 'player' }))

    assert(htmlPika.includes('data-lobby-livechat-delete='), 'delete button should be visible when canDeleteLobbyChat=true')
    assert(htmlPlayer.includes('data-lobby-livechat-delete='), 'delete button should be visible for ordinary messages too')
    assert(htmlPika.includes(PURPLE_NAME_MARKER), 'delete permission must not alter pika_team color')
    assert(htmlPlayer.includes(GOLD_NAME_MARKER), 'delete permission must not alter player color')
  })

  check('[6] only the author-name element is recolored', () => {
    const htmlPika = renderLobbyChatMessageRow(makeState(false), makeMessage({ senderRole: 'pika_team', body: 'Unique body X' }))
    const htmlPlayer = renderLobbyChatMessageRow(makeState(false), makeMessage({ senderRole: 'player', body: 'Unique body X' }))

    assert(htmlPika.includes(MESSAGE_BODY_STYLE_MARKER), 'message body style should remain unchanged for pika_team')
    assert(htmlPlayer.includes(MESSAGE_BODY_STYLE_MARKER), 'message body style should remain unchanged for player')
  })

  check('[7] history and live WebSocket paths both normalize through resolveLobbyChatSenderRole', () => {
    assert(controllerSource.includes('senderRole: resolveLobbyChatSenderRole(m)'), 'history messages must normalize senderRole through the shared helper')
    assert(controllerSource.includes('senderRole: resolveLobbyChatSenderRole(message)'), 'live WebSocket messages must normalize senderRole through the shared helper')
  })

  check('[8] history/live render the same role colors', () => {
    const historyPika = makeMessage({ messageId: 'history-pika', senderRole: 'pika_team' })
    const livePika = makeMessage({ messageId: 'live-pika', senderRole: 'pika_team' })
    const historyChatAdmin = makeMessage({ messageId: 'history-chat-admin', senderIsChatAdmin: true, senderRole: 'chat_admin' })
    const liveTopChatAdmin = makeMessage({ messageId: 'live-top-chat-admin', senderRole: 'top_chat_admin' })

    assert(renderLobbyChatMessageRow(makeState(false), historyPika).includes(PURPLE_NAME_MARKER), 'history pika_team message should render purple')
    assert(renderLobbyChatMessageRow(makeState(false), livePika).includes(PURPLE_NAME_MARKER), 'live pika_team message should render purple')
    assert(renderLobbyChatMessageRow(makeState(false), historyChatAdmin).includes(GOLD_NAME_MARKER), 'history chat_admin message should render default')
    assert(renderLobbyChatMessageRow(makeState(false), liveTopChatAdmin).includes(GOLD_NAME_MARKER), 'live top_chat_admin message should render default')
  })

  check('[9] legacy, missing, and invalid role fields use the existing safe fallback', () => {
    const legacyChatAdmin = { senderIsChatAdmin: true }
    const legacyMissingRole = { senderIsChatAdmin: false }
    const legacyInvalidRole = { senderIsChatAdmin: false, senderRole: 'pika-team' as never }

    assert(resolveLobbyChatSenderRole(legacyChatAdmin) === 'chat_admin', 'legacy senderIsChatAdmin should normalize to chat_admin')
    assert(resolveLobbyChatSenderRole(legacyMissingRole) === 'player', 'missing non-admin role should normalize to player')
    assert(resolveLobbyChatSenderRole(legacyInvalidRole) === 'player', 'invalid role should normalize to player')
    assertStyleEquals(getLobbyChatAuthorNameStyle(legacyChatAdmin), DEFAULT_AUTHOR_STYLE, 'legacy chat_admin should now use default')
    assertStyleEquals(getLobbyChatAuthorNameStyle(legacyMissingRole), DEFAULT_AUTHOR_STYLE, 'legacy missing role should use default')
    assertStyleEquals(getLobbyChatAuthorNameStyle(legacyInvalidRole), DEFAULT_AUTHOR_STYLE, 'legacy invalid role should use default')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
