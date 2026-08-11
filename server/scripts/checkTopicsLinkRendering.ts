/**
 * checkTopicsLinkRendering.ts
 *
 * Regression test за link detection/linkification в Topics (root posts +
 * replies) — потвърждава, че Topics reuse-ва СЪЩИЯ established
 * renderLinkifiedChatMessageBody helper от Lobby Live Chat/personal chat/
 * support (renderLobbyScreen.ts), а не собствена (втора) regex/parser
 * имплементация.
 *
 * URL format/security/mobile-overflow поведението на самия helper вече е
 * покрито изчерпателно в checkLobbyAndSupportLinkRendering.ts и
 * checkPersonalChatLinkRendering.ts — тук НЕ се дублира, само се потвърждава
 * Topics reuse (source-level + рендиран markup за root/reply parity).
 *
 * [0]  plain text без URL остава обикновен escaped текст (root)
 * [1]  https URL става кликаем анкор (root)
 * [2]  URL в средата на текст ("текст + URL + текст") linkify-ва само URL частта (root)
 * [3]  multiple URLs в едно съобщение — и двата рендират независими анкори (root)
 * [4]  HTML/script-like input около URL остава escaped, НЕ инжектира raw HTML (root)
 * [5]  Topics root съобщение (renderTopicMessageRow) reuse-ва renderLinkifiedChatMessageBody
 * [6]  Topics reply (renderTopicReplyRow) reuse-ва renderLinkifiedChatMessageBody — root/reply parity
 * [7]  source-level: Topics НЕ дефинира собствен URL regex/linkifier (single shared mechanism)
 * [8]  дълъг URL в Topics носи mobile overflow guard (overflow-wrap:anywhere, без horizontal overflow)
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { renderTopicMessageRow, renderTopicReplyRow } from '../../src/app/lobby/renderTopicsScreen.js'
import type { LobbyScreenState } from '../../src/app/lobby/renderLobbyScreen.js'
import type { TopicMessageSnapshot, TopicReplySnapshot } from '../../src/app/network/createGameServerClient.js'

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

function makeMinimalState(overrides: Partial<LobbyScreenState> = {}): LobbyScreenState {
  return {
    apiBaseUrl: '',
    topicExpandedReplyRootIds: [],
    topicRepliesByRootId: {},
    topicRepliesHasMoreByRootId: {},
    topicRepliesLoadingByRootId: {},
    topicReplyComposerOpenRootId: null,
    topicMessageLikeCountById: {},
    topicMessageViewerHasLikedById: {},
    topicMessageLikePendingRequestIdById: {},
    ...overrides,
  } as unknown as LobbyScreenState
}

function makeRootMessage(body: string): TopicMessageSnapshot {
  return {
    seq: 1,
    messageId: 'topic-root-1',
    topicId: 'topic-general',
    parentMessageId: null,
    senderProfileId: 'sender-1',
    senderDisplayName: 'Sender One',
    senderAvatarUrl: null,
    senderRole: 'player',
    body,
    createdAt: new Date('2026-08-11T10:00:00Z').toISOString(),
    likeCount: 0,
    replyCount: 0,
    viewerHasLiked: false,
    attachment: null,
  }
}

function makeReply(body: string): TopicReplySnapshot {
  return {
    seq: 2,
    messageId: 'topic-reply-1',
    topicId: 'topic-general',
    parentMessageId: 'topic-root-1',
    senderProfileId: 'sender-2',
    senderDisplayName: 'Sender Two',
    senderAvatarUrl: null,
    senderRole: 'player',
    body,
    createdAt: new Date('2026-08-11T10:05:00Z').toISOString(),
    likeCount: 0,
    viewerHasLiked: false,
    attachment: null,
  }
}

const state = makeMinimalState()

check('[0] plain text без URL остава обикновен escaped текст (root)', () => {
  const html = renderTopicMessageRow(state, makeRootMessage('обикновен текст без линкове'))
  assert(hrefCount(html) === 0, 'plain text не трябва да произвежда анкори')
  assert(html.includes('обикновен текст без линкове'), 'plain текстът трябва да остане видим')
})

check('[1] https URL става кликаем анкор (root)', () => {
  const html = renderTopicMessageRow(state, makeRootMessage('https://pika.bg/rules'))
  assertAnchor(html, 'https://pika.bg/rules', 'https://pika.bg/rules')
})

check('[2] URL в средата на текст ("текст + URL + текст") linkify-ва само URL частта (root)', () => {
  const html = renderTopicMessageRow(state, makeRootMessage('виж тук https://pika.bg/rules моля'))
  assert(html.includes('виж тук '), 'текстът преди URL трябва да остане')
  assert(html.includes(' моля'), 'текстът след URL трябва да остане')
  assertAnchor(html, 'https://pika.bg/rules', 'https://pika.bg/rules')
})

check('[3] multiple URLs в едно съобщение — и двата рендират независими анкори (root)', () => {
  const html = renderTopicMessageRow(state, makeRootMessage('първо www.one.test и второ http://two.test'))
  assert(hrefCount(html) === 2, 'очакват се точно два анкора')
  assertAnchor(html, 'https://www.one.test/', 'www.one.test')
  assertAnchor(html, 'http://two.test/', 'http://two.test')
})

check('[4] HTML/script-like input около URL остава escaped, НЕ инжектира raw HTML (root)', () => {
  const html = renderTopicMessageRow(state, makeRootMessage('<img src=x onerror=alert(1)> https://safe.test'))
  assert(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'HTML tag трябва да е escaped')
  assert(!html.includes('<img src=x'), 'raw HTML tag не трябва да се emit-не')
  assertAnchor(html, 'https://safe.test/', 'https://safe.test')
})

check('[5] Topics root съобщение (renderTopicMessageRow) reuse-ва renderLinkifiedChatMessageBody', () => {
  const html = renderTopicMessageRow(state, makeRootMessage('провери https://example.test/root'))
  assertAnchor(html, 'https://example.test/root', 'https://example.test/root')
})

check('[6] Topics reply (renderTopicReplyRow) reuse-ва renderLinkifiedChatMessageBody — root/reply parity', () => {
  const html = renderTopicReplyRow(state, makeReply('провери https://example.test/reply'))
  assertAnchor(html, 'https://example.test/reply', 'https://example.test/reply')
})

check('[8] дълъг URL в Topics носи mobile overflow guard (overflow-wrap:anywhere)', () => {
  const longLink = `https://example.test/${'verylongpath'.repeat(20)}`
  const rootHtml = renderTopicMessageRow(state, makeRootMessage(longLink))
  const replyHtml = renderTopicReplyRow(state, makeReply(longLink))
  assertAnchor(rootHtml, longLink, longLink)
  assertAnchor(replyHtml, longLink, longLink)
  assert(rootHtml.includes('overflow-wrap:anywhere'), 'root container трябва да позволява wrap навсякъде (без horizontal overflow)')
  assert(replyHtml.includes('overflow-wrap:anywhere'), 'reply container трябва да позволява wrap навсякъде (без horizontal overflow)')
})

check('[7] source-level: Topics НЕ дефинира собствен URL regex/linkifier (single shared mechanism)', () => {
  const topicsSource = readFileSync(join(PROJECT_ROOT, 'src', 'app', 'lobby', 'renderTopicsScreen.ts'), 'utf8')
  assert(topicsSource.includes("import { resolveAttachmentUrl, renderLinkifiedChatMessageBody } from './renderLobbyScreen'"), 'Topics трябва да import-ва shared linkifier-а от renderLobbyScreen.ts')
  assert(topicsSource.includes('renderLinkifiedChatMessageBody(reply.body)'), 'reply body трябва да минава през shared linkifier-а')
  assert(topicsSource.includes('renderLinkifiedChatMessageBody(message.body)'), 'root message body трябва да минава през shared linkifier-а')
  assert(!/https\?:\\\/\\\//.test(topicsSource), 'Topics не трябва да съдържа собствен URL regex литерал (regression за "втори независим linkifier")')
  assert(!topicsSource.includes('LINKIFIED_CHAT_TOKEN_PATTERN'), 'token pattern константата трябва да живее само в renderLobbyScreen.ts, не копирана в Topics')
})

console.log(`\n${passed} passed, ${failed} failed`)

if (failed > 0) {
  process.exitCode = 1
}
