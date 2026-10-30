/**
 * checkTopicThreadUnreadWindow.ts
 *
 * „Теми“ — отваряне на нишка при първия непрочетен отговор, страници нагоре/
 * надолу без „Покажи още“ и частично прочитане (throughSeq). Изолирана temp
 * база, реалните store-ове, без сървър.
 *
 * [W1] 190 отговора, прочетени 170 → първи непрочетен = №171, контекст + страница.
 * [W2] 0 непрочетени → края на нишката (последна страница), без разделител.
 * [W3] 1 непрочетен.
 * [W4] 45 непрочетени → две страници напред, без дубликати и дупки.
 * [W5] Частично прочитане и повторно отваряне — разделителят се мести.
 * [W6] Второ устройство / закъсняла заявка — прагът никога не пада.
 * [W7] throughSeq извън нишката се ограничава — следващ отговор пак е непрочетен.
 * [W8] Собствени отговори не са непрочетени и не спират прага.
 * [W9] Изтрити отговори — извън страниците, броячите и първия непрочетен.
 * [W10] Скрит автор (заявка за изтриване) — изключен навсякъде; скрит root.
 * [W11] Паритет: брояч == страници (single + batch), първи непрочетен == MIN.
 * [W12] Първо записване под topic-level прага не „връща“ прочетени.
 * [W13] Страници назад — непрекъснат диапазон до началото.
 * [W14] Лафче — topic-level броячът не се влияе от thread маркирането.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTopicReadStateStore, type TopicReadStateStore } from '../src/db/topicReadStateStore.js'
import { createTopicMessageStore, type TopicMessageStore } from '../src/db/topicMessageStore.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const migrationPaths = [
  '20260810_002_create_topics_and_messages.sql',
  '20260811_001_create_topic_message_likes.sql',
  '20260811_002_create_topic_message_attachments.sql',
  '20260811_003_create_topic_moderation.sql',
  '20260812_001_create_topic_message_moderation.sql',
  '20260812_002_create_topic_message_self_deletion_audit.sql',
  '20260812_003_add_topic_message_editing.sql',
  '20260812_004_create_topic_read_state.sql',
  '20260813_001_create_topic_thread_read_state.sql',
  '20260814_001_create_topic_section_mutes.sql',
  '20260817_002_seed_topic_lafche.sql',
  '20260824_001_create_topic_root_latest_seq.sql',
  '20260901_001_add_created_by_role_to_topics.sql',
].map((name) => resolve(serverRoot, 'database/migrations', name))

const GENERAL = 'topic-general'
const LAFCHE = 'topic-lafche'
const VIEWER = 'viewer'
const HIDDEN = 'hidden-author'
const CONTEXT = 10
const PAGE = 30

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed++
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const dir = await mkdtemp(join(tmpdir(), 'belot-topic-thread-unread-window-'))
const dbPath = join(dir, 'topics.sqlite')
const raw = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
raw.exec('PRAGMA journal_mode = WAL;')
raw.exec(`CREATE TABLE profiles (profile_id TEXT PRIMARY KEY, display_name TEXT NOT NULL DEFAULT '', is_temporary INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`)
raw.exec(`CREATE TABLE accounts (account_id TEXT PRIMARY KEY);`)
for (const migrationPath of migrationPaths) raw.exec(await readFile(migrationPath, 'utf8'))
for (const profileId of [VIEWER, 'alice', 'bob', 'carol', HIDDEN, 'device-viewer']) {
  raw.prepare(`INSERT INTO profiles (profile_id, display_name) VALUES (?, ?)`).run(profileId, profileId)
}

const readState: TopicReadStateStore = await createTopicReadStateStore(dbPath)
const messages: TopicMessageStore = await createTopicMessageStore(dbPath)

// Topic-level праг при първо зареждане на директорията (преди съдържанието).
readState.ensureReadStateForTopics(VIEWER, [GENERAL, LAFCHE])

const post = (topicId: string, sender: string): { id: string; seq: number } => {
  const message = messages.insertMessage({ topicId, senderProfileId: sender, senderDisplayName: sender, senderRole: 'player', body: 'root' })
  return { id: message.messageId, seq: message.seq }
}
const reply = (topicId: string, sender: string, parentMessageId: string): { id: string; seq: number } => {
  const result = messages.insertReply({ topicId, parentMessageId, senderProfileId: sender, senderDisplayName: sender, senderRole: 'player', body: 'r' })
  if (!result.ok) throw new Error('reply failed')
  return { id: result.message.messageId, seq: result.message.seq }
}

type Window = { seqs: number[]; hasMoreBefore: boolean; hasMoreAfter: boolean; firstUnreadSeq: number | null; ids: string[] }

// Огледало на handleTopicRepliesRequest (window=unread).
function openWindow(viewer: string, rootId: string, excluded: string[] = []): Window {
  const firstUnreadSeq = readState.getFirstUnreadReplySeq(viewer, rootId, excluded)
  if (firstUnreadSeq === null) {
    const tail = messages.getRepliesBefore(rootId, null, PAGE, excluded)
    return { seqs: tail.messages.map((m) => m.seq), ids: tail.messages.map((m) => m.messageId), hasMoreBefore: tail.hasMore, hasMoreAfter: false, firstUnreadSeq }
  }
  const older = messages.getRepliesBefore(rootId, firstUnreadSeq, CONTEXT, excluded)
  const newer = messages.getRepliesAfter(rootId, firstUnreadSeq - 1, PAGE, excluded)
  const all = [...older.messages, ...newer.messages]
  return { seqs: all.map((m) => m.seq), ids: all.map((m) => m.messageId), hasMoreBefore: older.hasMore, hasMoreAfter: newer.hasMore, firstUnreadSeq }
}

const threadUnread = (viewer: string, rootId: string, excluded: string[] = []) =>
  readState.getUnreadCountsByRootMessageIds(viewer, [rootId], excluded).get(rootId) ?? 0
const threadUnreadBatch = (viewer: string, rootId: string, excluded: string[] = []) =>
  readState.getThreadUnreadCountsForProfiles(rootId, [viewer], new Map([[viewer, new Set(excluded)]])).get(viewer) ?? 0
const lastSeen = (viewer: string, rootId: string) => readState.getThreadReadState(viewer, rootId)?.lastSeenSeq ?? null

function isStrictlyIncreasing(seqs: readonly number[]): boolean {
  return seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]!)
}

console.log('\n=== Теми: нишка — първи непрочетен, страници, частично прочитане ===\n')

// Нишка с 190 отговора (редуващи се автори).
const bigRoot = post(GENERAL, 'alice')
const big: Array<{ id: string; seq: number }> = []
for (let i = 0; i < 190; i++) big.push(reply(GENERAL, i % 2 === 0 ? 'bob' : 'carol', bigRoot.id))

await check('[W1] 190 отговора, прочетени 170 → първият непрочетен е №171', () => {
  readState.markThreadSeenThroughSeq(VIEWER, bigRoot.id, big[169]!.seq)
  const window = openWindow(VIEWER, bigRoot.id)
  assertEqual(window.firstUnreadSeq, big[170]!.seq, 'first unread')
  assertEqual(threadUnread(VIEWER, bigRoot.id), 20, 'thread unread')
  assertEqual(window.seqs, big.slice(160, 190).map((r) => r.seq), 'context 161-170 + 171-190')
  assert(window.hasMoreBefore, 'older replies must remain reachable')
  assert(!window.hasMoreAfter, 'window reaches the end')
  const ctx = readState.getThreadReadContext(VIEWER, bigRoot.id, GENERAL, ['bob', 'carol'])
  assertEqual(ctx.threshold, big[169]!.seq, 'read context threshold')
})

await check('[W2] 0 непрочетени → последната страница, без първи непрочетен', () => {
  const result = readState.markThreadSeenThroughSeq(VIEWER, bigRoot.id, big[189]!.seq)
  assert(result.ok, 'mark ok')
  const window = openWindow(VIEWER, bigRoot.id)
  assertEqual(window.firstUnreadSeq, null, 'first unread')
  assertEqual(threadUnread(VIEWER, bigRoot.id), 0, 'thread unread')
  assertEqual(window.seqs, big.slice(160).map((r) => r.seq), 'tail page')
  assert(window.hasMoreBefore && !window.hasMoreAfter, 'tail flags')
})

await check('[W3] 1 непрочетен', () => {
  const extra = reply(GENERAL, 'bob', bigRoot.id)
  const window = openWindow(VIEWER, bigRoot.id)
  assertEqual(window.firstUnreadSeq, extra.seq, 'first unread = new reply')
  assertEqual(threadUnread(VIEWER, bigRoot.id), 1, 'thread unread')
  assertEqual(window.seqs[window.seqs.length - 1], extra.seq, 'new reply is last in window')
  assertEqual(window.seqs.filter((seq) => seq < extra.seq).length, CONTEXT, 'read context above divider')
  readState.markThreadSeenThroughSeq(VIEWER, bigRoot.id, extra.seq)
  assertEqual(threadUnread(VIEWER, bigRoot.id), 0, 'read after seen')
})

// Нишка с 45 непрочетени (нова нишка след отваряне на директорията).
const midRoot = post(GENERAL, 'alice')
const mid: Array<{ id: string; seq: number }> = []
for (let i = 0; i < 60; i++) mid.push(reply(GENERAL, 'bob', midRoot.id))

await check('[W4] 45 непрочетени → две страници напред без дубликати и дупки', () => {
  readState.markThreadSeenThroughSeq(VIEWER, midRoot.id, mid[14]!.seq)
  const window = openWindow(VIEWER, midRoot.id)
  assertEqual(window.firstUnreadSeq, mid[15]!.seq, 'first unread')
  assertEqual(threadUnread(VIEWER, midRoot.id), 45, 'thread unread')
  assert(window.hasMoreAfter, 'more unread below the first page')
  const lastLoaded = window.seqs[window.seqs.length - 1]!
  const next = messages.getRepliesAfter(midRoot.id, lastLoaded, PAGE, [])
  const all = [...window.seqs, ...next.messages.map((m) => m.seq)]
  assert(!next.hasMore, 'second page reaches the end')
  assert(isStrictlyIncreasing(all), 'no duplicates / ordering')
  assertEqual(all, mid.slice(5).map((r) => r.seq), 'contiguous range 6-60')
})

await check('[W5] частично прочитане и повторно отваряне — разделителят се мести', () => {
  readState.markThreadSeenThroughSeq(VIEWER, midRoot.id, mid[29]!.seq)
  assertEqual(threadUnread(VIEWER, midRoot.id), 30, 'remaining unread')
  assertEqual(threadUnreadBatch(VIEWER, midRoot.id), 30, 'batch remaining unread')
  assertEqual(openWindow(VIEWER, midRoot.id).firstUnreadSeq, mid[30]!.seq, 'divider before first remaining unread')
})

await check('[W6] второ устройство / закъсняла заявка — прагът никога не пада', () => {
  const lower = readState.markThreadSeenThroughSeq(VIEWER, midRoot.id, mid[20]!.seq)
  assert(lower.ok && lower.state.lastSeenSeq === mid[29]!.seq, `lower throughSeq must not regress (got ${lower.ok ? lower.state.lastSeenSeq : 'err'})`)
  const higher = readState.markThreadSeenThroughSeq(VIEWER, midRoot.id, mid[40]!.seq)
  assert(higher.ok && higher.state.lastSeenSeq === mid[40]!.seq, 'higher throughSeq applies')
  assertEqual(threadUnread(VIEWER, midRoot.id), 19, 'remaining unread after second device')
})

await check('[W7] throughSeq извън нишката се ограничава до последния отговор', () => {
  const huge = readState.markThreadSeenThroughSeq(VIEWER, midRoot.id, 9_999_999)
  assert(huge.ok && huge.state.lastSeenSeq === mid[59]!.seq, `clamped to thread latest (got ${huge.ok ? huge.state.lastSeenSeq : 'err'})`)
  const other = post(GENERAL, 'bob')
  reply(GENERAL, 'carol', other.id)
  const late = reply(GENERAL, 'carol', midRoot.id)
  assertEqual(threadUnread(VIEWER, midRoot.id), 1, 'later reply is unread')
  assertEqual(openWindow(VIEWER, midRoot.id).firstUnreadSeq, late.seq, 'divider before the later reply')
  const missing = readState.markThreadSeenThroughSeq(VIEWER, 'no-such-root', 5)
  assert(!missing.ok, 'unknown root → not_found')
})

await check('[W8] собствени отговори не са непрочетени и не спират прага', () => {
  const root = post(GENERAL, 'alice')
  const a = reply(GENERAL, 'bob', root.id)
  const own = reply(GENERAL, VIEWER, root.id)
  const b = reply(GENERAL, 'bob', root.id)
  readState.markThreadSeenThroughSeq(VIEWER, root.id, root.seq)
  assertEqual(threadUnread(VIEWER, root.id), 2, 'own reply excluded from unread')
  assertEqual(openWindow(VIEWER, root.id).firstUnreadSeq, a.seq, 'first unread is foreign')
  readState.markThreadSeenThroughSeq(VIEWER, root.id, a.seq)
  assertEqual(openWindow(VIEWER, root.id).firstUnreadSeq, b.seq, 'own reply skipped as first unread')
  assert(own.seq > a.seq && own.seq < b.seq, 'ordering precondition')
})

await check('[W9] изтрит отговор — извън страницата, брояча и първия непрочетен', () => {
  const root = post(GENERAL, 'alice')
  const first = reply(GENERAL, 'bob', root.id)
  const second = reply(GENERAL, 'carol', root.id)
  readState.markThreadSeenThroughSeq(VIEWER, root.id, root.seq)
  const deletion = messages.deleteMessage({ topicId: GENERAL, messageId: first.id, actorAccountId: null, actorRole: 'admin' })
  assert(deletion.ok, 'delete ok')
  assertEqual(threadUnread(VIEWER, root.id), 1, 'deleted reply not counted')
  const window = openWindow(VIEWER, root.id)
  assertEqual(window.firstUnreadSeq, second.seq, 'first unread skips deleted')
  assert(!window.ids.includes(first.id), 'deleted reply not in window')
  assertEqual(messages.getDeletedReplyIdsUpTo(root.id, second.seq), [first.id], 'tombstone for gap-closing reconnect')
})

await check('[W10] скрит автор — изключен навсякъде; скрит root → няма непрочетени', () => {
  const root = post(GENERAL, 'alice')
  const hiddenReply = reply(GENERAL, HIDDEN, root.id)
  const visibleReply = reply(GENERAL, 'bob', root.id)
  readState.markThreadSeenThroughSeq(VIEWER, root.id, root.seq)
  const excluded = [HIDDEN]
  assertEqual(threadUnread(VIEWER, root.id, excluded), 1, 'hidden reply not counted')
  assertEqual(threadUnreadBatch(VIEWER, root.id, excluded), 1, 'batch parity')
  const window = openWindow(VIEWER, root.id, excluded)
  assertEqual(window.firstUnreadSeq, visibleReply.seq, 'first unread skips hidden author')
  assert(!window.ids.includes(hiddenReply.id), 'hidden reply not in window')

  const hiddenRoot = post(GENERAL, HIDDEN)
  reply(GENERAL, 'bob', hiddenRoot.id)
  assertEqual(threadUnread(VIEWER, hiddenRoot.id, excluded), 0, 'hidden root thread has no unread')
  assertEqual(readState.getFirstUnreadReplySeq(VIEWER, hiddenRoot.id, excluded), null, 'hidden root → no first unread')
  // Отмяна на заявката — непрочетените се връщат същите (read state непокътнат).
  assertEqual(threadUnread(VIEWER, root.id), 2, 'cancelled request restores hidden reply')
})

await check('[W11] паритет: брояч == страници, първи непрочетен == MIN, single == batch', () => {
  for (const throughIndex of [0, 37, 99, 150, 189]) {
    const viewer = 'device-viewer'
    raw.prepare('DELETE FROM topic_thread_read_state WHERE profile_id = ?').run(viewer)
    readState.markThreadSeenThroughSeq(viewer, bigRoot.id, big[throughIndex]!.seq)
    const threshold = readState.getThreadReadContext(viewer, bigRoot.id, GENERAL, []).threshold
    const all: number[] = []
    let cursor: number | null = null
    for (;;) {
      const page = messages.getRepliesBefore(bigRoot.id, cursor, PAGE, [])
      all.unshift(...page.messages.map((m) => m.seq))
      if (!page.hasMore || page.oldestSeq === null) break
      cursor = page.oldestSeq
    }
    const expectedUnread = all.filter((seq) => seq > threshold)
    assertEqual(threadUnread(viewer, bigRoot.id), expectedUnread.length, `count @${throughIndex}`)
    assertEqual(threadUnreadBatch(viewer, bigRoot.id), expectedUnread.length, `batch count @${throughIndex}`)
    assertEqual(readState.getFirstUnreadReplySeq(viewer, bigRoot.id), expectedUnread[0] ?? null, `first unread @${throughIndex}`)
  }
})

await check('[W12] първо записване под topic-level прага не връща прочетени отговори', () => {
  const root = post(GENERAL, 'alice')
  const r1 = reply(GENERAL, 'bob', root.id)
  reply(GENERAL, 'bob', root.id)
  readState.markTopicSeenToLatestSeq('device-viewer', GENERAL)
  raw.prepare('DELETE FROM topic_thread_read_state WHERE profile_id = ? AND root_message_id = ?').run('device-viewer', root.id)
  assertEqual(threadUnread('device-viewer', root.id), 0, 'covered by topic-level read state')
  const result = readState.markThreadSeenThroughSeq('device-viewer', root.id, r1.seq)
  assert(result.ok, 'mark ok')
  assertEqual(threadUnread('device-viewer', root.id), 0, 'still 0 after partial thread mark')
})

await check('[W13] страници назад — непрекъснат диапазон до началото', () => {
  const collected: number[] = []
  let cursor: number | null = big[100]!.seq
  for (;;) {
    const page = messages.getRepliesBefore(bigRoot.id, cursor, PAGE, [])
    assert(isStrictlyIncreasing(page.messages.map((m) => m.seq)), 'page is ascending')
    collected.unshift(...page.messages.map((m) => m.seq))
    if (!page.hasMore || page.oldestSeq === null) break
    cursor = page.oldestSeq
  }
  assertEqual(collected, big.slice(0, 100).map((r) => r.seq), 'replies 1-100')
})

await check('[W14] Лафче — topic-level броячът не се влияе от thread маркирането', () => {
  const lafchePost = post(LAFCHE, 'bob')
  const before = readState.getUnreadCountsByTopicIds(VIEWER, [LAFCHE]).get(LAFCHE)
  assert((before ?? 0) >= 1, 'lafche post unread precondition')
  readState.markThreadSeenThroughSeq(VIEWER, bigRoot.id, big[189]!.seq)
  assertEqual(readState.getUnreadCountsByTopicIds(VIEWER, [LAFCHE]).get(LAFCHE), before, 'lafche unread unchanged')
  assertEqual(readState.getReadState(VIEWER, LAFCHE)?.lastSeenSeq !== undefined && readState.getReadState(VIEWER, LAFCHE)!.lastSeenSeq < lafchePost.seq, true, 'lafche read state untouched')
})

readState.close()
messages.close()
raw.close()
await rm(dir, { recursive: true, force: true }).catch(() => undefined)

if (failed > 0) {
  console.error(`\ncheckTopicThreadUnreadWindow: ${failed} failed, ${passed} passed.`)
  process.exit(1)
}
console.log(`\ncheckTopicThreadUnreadWindow: ${passed} passed.\n`)
