import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import {
  renderLobbyChatMessageRow,
  renderPersonalChatMessageBody,
  renderSupportMessagesBubbles,
  type LobbyScreenState,
} from '../../src/app/lobby/renderLobbyScreen.js'
import type { LobbyChatMessageSnapshot, SupportMessageSnapshot } from '../../src/app/network/createGameServerClient.js'

let passed = 0
let failed = 0

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT_ROOT = resolve(SERVER_ROOT, '..')

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
  } catch (error) {
    fail(label, error)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

function hrefCount(html: string): number {
  return countOccurrences(html, '<a ')
}

function assertAnchor(html: string, href: string, text: string): void {
  assert(html.includes(`href="${href}"`), `missing href ${href}`)
  assert(html.includes('target="_blank"'), 'link must open in a new tab')
  assert(html.includes('rel="noopener noreferrer"'), 'link must use noopener noreferrer')
  assert(html.includes('data-chat-link="1"'), 'link must use the shared chat link marker')
  assert(html.includes(`>${text}</a>`), `missing visible link text ${text}`)
}

function makeLobbyMessage(overrides: Partial<LobbyChatMessageSnapshot> = {}): LobbyChatMessageSnapshot {
  return {
    seq: 1,
    messageId: 'lobby-msg-1',
    senderProfileId: 'profile-1',
    senderDisplayName: 'Player One',
    senderIsChatAdmin: false,
    senderRole: 'player',
    body: 'hello',
    createdAt: '2026-08-03T12:00:00.000Z',
    ...overrides,
  }
}

function makeSupportMessage(overrides: Partial<SupportMessageSnapshot> = {}): SupportMessageSnapshot {
  return {
    messageId: 'support-msg-1',
    profileId: 'profile-1',
    body: 'hello',
    isFromAdmin: false,
    createdAt: '2026-08-03T12:00:00.000Z',
    attachment: null,
    ...overrides,
  }
}

function renderLobbyBody(body: string): string {
  return renderLobbyChatMessageRow({ canDeleteLobbyChat: false } as unknown as LobbyScreenState, makeLobbyMessage({ body }))
}

function renderSupportBodies(messages: SupportMessageSnapshot[]): string {
  return renderSupportMessagesBubbles(messages, false)
}

check('lobby live chat renders active http, https and www links', () => {
  const html = renderLobbyBody('a http://one.test b https://two.test/path c www.three.test/q')
  assert(hrefCount(html) === 3, 'expected three lobby anchors')
  assertAnchor(html, 'http://one.test/', 'http://one.test')
  assertAnchor(html, 'https://two.test/path', 'https://two.test/path')
  assertAnchor(html, 'https://www.three.test/q', 'www.three.test/q')
})

check('support renders active links from registered users and admins', () => {
  const html = renderSupportBodies([
    makeSupportMessage({ messageId: 'support-user-history', isFromAdmin: false, body: 'user history www.user.test' }),
    makeSupportMessage({ messageId: 'support-admin-history', isFromAdmin: true, body: 'admin reply https://admin.test/help' }),
  ])

  assert(hrefCount(html) === 2, 'expected user and admin support anchors')
  assertAnchor(html, 'https://www.user.test/', 'www.user.test')
  assertAnchor(html, 'https://admin.test/help', 'https://admin.test/help')
  assert(html.includes('user history'), 'support user history text should render')
  assert(html.includes('admin reply'), 'support admin reply text should render')
  assert(html.includes('Pika.bg'), 'support admin sender marker should render')
})

check('history and new-message rendering use the same linkified paths', () => {
  const lobbyHistoryHtml = renderLobbyBody('history https://history.test')
  const lobbyLiveHtml = renderLobbyBody('live www.live.test')
  const supportHistoryHtml = renderSupportBodies([makeSupportMessage({ messageId: 'support-history', body: 'history http://support-history.test' })])
  const supportLiveHtml = renderSupportBodies([makeSupportMessage({ messageId: 'support-live', isFromAdmin: true, body: 'live www.support-live.test' })])

  assertAnchor(lobbyHistoryHtml, 'https://history.test/', 'https://history.test')
  assertAnchor(lobbyLiveHtml, 'https://www.live.test/', 'www.live.test')
  assertAnchor(supportHistoryHtml, 'http://support-history.test/', 'http://support-history.test')
  assertAnchor(supportLiveHtml, 'https://www.support-live.test/', 'www.support-live.test')
})

check('multiple links, newlines and emoji tokens remain formatted', () => {
  const html = renderSupportBodies([
    makeSupportMessage({ body: 'first www.one.test\n[e:02] second http://two.test' }),
  ])

  assert(hrefCount(html) === 2, 'expected two support links')
  assert(html.includes('<br>'), 'newline should render as line break')
  assert(html.includes('/assets/animated-emoji/emoji-02.webp'), 'emoji token should still render as image')
  assertAnchor(html, 'https://www.one.test/', 'www.one.test')
  assertAnchor(html, 'http://two.test/', 'http://two.test')
})

check('XSS-looking text and forbidden protocols stay plain escaped text', () => {
  const html = renderLobbyBody('<script>alert(1)</script> javascript:alert(1) data:text/html,hi file:///C:/x ftp://bad.test https://safe.test')

  assert(hrefCount(html) === 1, 'only the safe https link should be active')
  assert(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'script tag should be escaped')
  assert(!html.includes('<script>'), 'raw script tag must not be emitted')
  assert(html.includes('javascript:alert(1)'), 'javascript URL text should remain visible plain text')
  assert(html.includes('data:text/html,hi'), 'data URL text should remain visible plain text')
  assert(html.includes('file:///C:/x'), 'file URL text should remain visible plain text')
  assert(html.includes('ftp://bad.test'), 'ftp URL text should remain visible plain text')
  assertAnchor(html, 'https://safe.test/', 'https://safe.test')
})

check('trailing punctuation is left outside the active URL', () => {
  const html = renderSupportBodies([
    makeSupportMessage({ body: 'See https://example.com/a?b=1), and www.pika.bg!' }),
  ])

  assertAnchor(html, 'https://example.com/a?b=1', 'https://example.com/a?b=1')
  assertAnchor(html, 'https://www.pika.bg/', 'www.pika.bg')
  assert(!html.includes('href="https://example.com/a?b=1),"'), 'closing punctuation must not enter first href')
  assert(html.includes('</a>), and'), 'first punctuation should remain after first anchor')
  assert(html.includes('</a>!'), 'exclamation mark should remain after second anchor')
})

check('long links include mobile overflow guards', () => {
  const longLink = `https://example.test/${'verylongpath'.repeat(24)}`
  const html = renderLobbyBody(longLink)

  assertAnchor(html, longLink, longLink)
  assert(html.includes('overflow-wrap:anywhere'), 'link should allow wrapping anywhere')
  assert(html.includes('word-break:break-word'), 'link should not overflow narrow mobile bubbles')
})

check('personal chat keeps the shared linkify behavior', () => {
  const html = renderPersonalChatMessageBody('personal www.personal.test')

  assertAnchor(html, 'https://www.personal.test/', 'www.personal.test')
})

check('private-room waiting chat still does not use linkify', () => {
  const privateRoomSource = readFileSync(join(PROJECT_ROOT, 'src', 'app', 'lobby', 'renderPrivateRoomWaitingScreen.ts'), 'utf8')

  assert(privateRoomSource.includes('escapeHtml(message.body)'), 'private-room waiting chat should keep escaped message body')
  assert(!privateRoomSource.includes('renderLinkifiedChatMessageBody'), 'private-room chat should not use shared linkifier')
  assert(!privateRoomSource.includes('data-chat-link'), 'private-room chat should not render active chat links')
})

check('lobby and support renderers call the shared linkifier in source', () => {
  const lobbySource = readFileSync(join(PROJECT_ROOT, 'src', 'app', 'lobby', 'renderLobbyScreen.ts'), 'utf8')

  assert(lobbySource.includes('${renderLinkifiedChatMessageBody(message.body)}</span>'), 'lobby live chat should call shared linkifier')
  assert(lobbySource.includes('${renderLinkifiedChatMessageBody(msg.body)}</div>'), 'support chat should call shared linkifier')
  assert(lobbySource.includes('renderSupportMessagesBubbles(state.supportMessages'), 'user support history should use support bubble renderer')
  assert(lobbySource.includes('renderSupportMessagesBubbles(state.adminSupportMessages'), 'admin support history should use support bubble renderer')
})

console.log(`\n${passed} passed, ${failed} failed`)

if (failed > 0) {
  process.exitCode = 1
}
