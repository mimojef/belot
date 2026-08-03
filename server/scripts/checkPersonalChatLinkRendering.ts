import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { renderPersonalChatMessageBody } from '../../src/app/lobby/renderLobbyScreen.js'

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
  assert(html.includes('data-chat-link="1"'), 'link must be marked as shared chat link')
  assert(html.includes(`>${text}</a>`), `missing visible link text ${text}`)
}

check('http, https and www links render as active anchors', () => {
  const html = renderPersonalChatMessageBody('a http://one.test b https://two.test/path c www.three.test/q')
  assert(hrefCount(html) === 3, 'expected three anchors')
  assertAnchor(html, 'http://one.test/', 'http://one.test')
  assertAnchor(html, 'https://two.test/path', 'https://two.test/path')
  assertAnchor(html, 'https://www.three.test/q', 'www.three.test/q')
})

check('text before and after links is preserved as escaped text', () => {
  const html = renderPersonalChatMessageBody('before https://pika.bg/rules after')
  assert(html.startsWith('before '), 'text before link should remain')
  assert(html.endsWith(' after'), 'text after link should remain')
  assertAnchor(html, 'https://pika.bg/rules', 'https://pika.bg/rules')
})

check('two links in one message both render independently', () => {
  const html = renderPersonalChatMessageBody('first www.one.test and second http://two.test')
  assert(hrefCount(html) === 2, 'expected two anchors')
  assertAnchor(html, 'https://www.one.test/', 'www.one.test')
  assertAnchor(html, 'http://two.test/', 'http://two.test')
})

check('trailing punctuation is left outside the link', () => {
  const html = renderPersonalChatMessageBody('See https://example.com/a?b=1).')
  assertAnchor(html, 'https://example.com/a?b=1', 'https://example.com/a?b=1')
  assert(!html.includes('href="https://example.com/a?b=1)."'), 'closing punctuation must not enter href')
  assert(html.includes('</a>).'), 'closing punctuation should remain visible after the anchor')
})

check('forbidden protocols do not become active links', () => {
  const html = renderPersonalChatMessageBody('javascript:alert(1) data:text/html,hi file:///C:/x ftp://example.test')
  assert(hrefCount(html) === 0, 'forbidden protocols should not render anchors')
  assert(html.includes('javascript:alert(1)'), 'javascript text should remain plain text')
  assert(html.includes('data:text/html,hi'), 'data URL text should remain plain text')
  assert(html.includes('file:///C:/x'), 'file URL text should remain plain text')
  assert(html.includes('ftp://example.test'), 'ftp URL text should remain plain text')
})

check('HTML and XSS-looking text stays escaped', () => {
  const html = renderPersonalChatMessageBody('<img src=x onerror=alert(1)> https://safe.test')
  assert(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'HTML tag should be escaped')
  assert(!html.includes('<img src=x'), 'raw HTML tag should not be emitted')
  assertAnchor(html, 'https://safe.test/', 'https://safe.test')
})

check('long links include mobile overflow guards', () => {
  const longLink = `https://example.test/${'verylongpath'.repeat(20)}`
  const html = renderPersonalChatMessageBody(longLink)
  assertAnchor(html, longLink, longLink)
  assert(html.includes('overflow-wrap:anywhere'), 'link should allow wrapping anywhere')
  assert(html.includes('word-break:break-word'), 'link should not overflow narrow mobile bubbles')
})

check('emoji tokens and newlines remain formatted', () => {
  const html = renderPersonalChatMessageBody('hello [e:01]\nwww.pika.bg')
  assert(html.includes('/assets/animated-emoji/emoji-01.webp'), 'emoji token should still render as image')
  assert(html.includes('<br>'), 'newline should render as line break')
  assertAnchor(html, 'https://www.pika.bg/', 'www.pika.bg')
})

check('personal chat uses the shared linkifier and private-room chat stays plain escaped text', () => {
  const lobbySource = readFileSync(join(PROJECT_ROOT, 'src', 'app', 'lobby', 'renderLobbyScreen.ts'), 'utf8')
  const privateRoomSource = readFileSync(join(PROJECT_ROOT, 'src', 'app', 'lobby', 'renderPrivateRoomWaitingScreen.ts'), 'utf8')

  assert(lobbySource.includes('export function renderPersonalChatMessageBody(body: string): string'), 'personal chat wrapper should remain exported')
  assert(lobbySource.includes('return renderLinkifiedChatMessageBody(body)'), 'personal chat should reuse the shared linkifier')
  assert(privateRoomSource.includes('escapeHtml(message.body)'), 'private-room waiting chat should keep escaped message body')
  assert(!privateRoomSource.includes('renderPersonalChatMessageBody'), 'private-room chat should not use personal chat linkifier')
  assert(!privateRoomSource.includes('renderLinkifiedChatMessageBody'), 'private-room chat should not use shared linkifier')
  assert(countOccurrences(lobbySource, 'renderPersonalChatMessageBody(message.body)') === 4, 'personal chat message bubbles should still call the personal wrapper')
})

console.log(`\n${passed} passed, ${failed} failed`)

if (failed > 0) {
  process.exitCode = 1
}
