/**
 * checkTopicRepliesLikesStore.ts
 *
 * Store-level checks за Етап 3 (реални Likes + Replies в "Теми"): нова
 * 20260811_001 migration (topic_message_likes DB constraint) и новите
 * topicMessageStore методи (insertReply/getReplies/getRepliesAfter/
 * getMessageById/getMessageAggregatesByIds/toggleLike/
 * getLikeCountsByMessageIds), плюс потвърждение че pollNewMessages вече
 * вижда replies (не само root).
 *
 * [0]  Migration създава topic_message_likes с PRIMARY KEY(message_id, liker_profile_id)
 * [1]  DB constraint отхвърля дублиран (message_id, liker_profile_id) INSERT директно
 * [2]  ON DELETE CASCADE от topic_messages чисти likes при изтрит message
 * [3]  insertReply вмъква ред с parent_message_id = зададения root
 * [4]  getReplies връща replies старо→ново (ASC, не DESC+reverse като root)
 * [5]  getReplies hasMore=true при повече от limit replies
 * [6]  getRepliesAfter връща replies СЛЕД даден seq (forward cursor, "Покажи още")
 * [7]  getReplies никога не връща replies от друг root message (isolation)
 * [8]  getMessageById връща null за несъществуващ message
 * [9]  getMessageById връща коректен snapshot с parentMessageId
 * [10] toggleLike: първи toggle → INSERT, likeCount=1, viewerHasLiked=true
 * [11] toggleLike: втори toggle (unlike) → DELETE, likeCount=0, viewerHasLiked=false
 * [12] toggleLike: трети toggle (like отново) → likeCount=1, viewerHasLiked=true
 * [13] toggleLike е изолиран per (message, profile) — друг profile like не пречи
 * [14] getMessageAggregatesByIds: likeCount батово за няколко message-а с 1 заявка ефект
 * [15] getMessageAggregatesByIds: replyCount брои само НЕ-изтрити replies
 * [16] getMessageAggregatesByIds: viewerHasLiked=true само за viewer-а, не за друг profile
 * [17] getMessageAggregatesByIds: viewerProfileId=null → viewerHasLiked винаги false
 * [18] getMessageAggregatesByIds: празен messageIds масив → празна Map, без грешка
 * [19] getLikeCountsByMessageIds връща 0 за message без likes (не липсва от Map-а)
 * [20] pollNewMessages вече връща И root, И reply редове (Етап 3 разширение)
 * [21] pollNewMessages НЕ връща изтрити (deleted_at) редове, root или reply
 * [22] getMessageAggregatesByIds: replyCount е viewer-aware (excludedSenderProfileIds намалява брояча), likeCount ОСТАВА global (blocking corection)
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTopicMessageStore } from '../src/db/topicMessageStore.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const topicsMigrationPath = resolve(serverRoot, 'database/migrations/20260810_002_create_topics_and_messages.sql')
const likesMigrationPath = resolve(serverRoot, 'database/migrations/20260811_001_create_topic_message_likes.sql')
const attachmentsMigrationPath = resolve(serverRoot, 'database/migrations/20260811_002_create_topic_message_attachments.sql')

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
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: got ${String(actual)}, expected ${String(expected)}`)
  }
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-topic-replies-likes-check-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

function buildBaseSchema(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      profile_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
}

async function applyMigrationFile(db: DatabaseSync, migrationPath: string): Promise<void> {
  const sql = await readFile(migrationPath, 'utf8')
  db.exec('BEGIN;')
  try {
    db.exec(sql)
    db.exec('COMMIT;')
  } catch (err) {
    db.exec('ROLLBACK;')
    throw err
  }
}

function seedProfile(db: DatabaseSync, profileId: string): void {
  db.prepare(`INSERT INTO profiles (profile_id, display_name) VALUES (?, ?)`).run(profileId, profileId)
}

function insertTopic(db: DatabaseSync, input: { topicId: string; slug: string; title: string }): void {
  db.prepare(`
    INSERT INTO topics (topic_id, slug, title, is_general, created_by_profile_id, status, sort_order)
    VALUES (?, ?, ?, 0, NULL, 'active', 100);
  `).run(input.topicId, input.slug, input.title)
}

function insertMessage(db: DatabaseSync, input: {
  messageId: string
  topicId: string
  parentMessageId?: string | null
  senderProfileId: string
  senderDisplayName: string
  body: string
  deletedAt?: string | null
}): number {
  db.prepare(`
    INSERT INTO topic_messages (
      message_id, topic_id, parent_message_id, sender_profile_id, sender_display_name, sender_role, body, deleted_at
    ) VALUES (?, ?, ?, ?, ?, 'player', ?, ?);
  `).run(
    input.messageId,
    input.topicId,
    input.parentMessageId ?? null,
    input.senderProfileId,
    input.senderDisplayName,
    input.body,
    input.deletedAt ?? null,
  )
  const row = db.prepare(`SELECT seq FROM topic_messages WHERE message_id = ?`).get(input.messageId) as { seq: number }
  return row.seq
}

// ─── [0]-[2] Migration / DB constraint ──────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'likes-migration.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildBaseSchema(db)
  await applyMigrationFile(db, topicsMigrationPath)

  await check('[0] Migration създава topic_message_likes с PRIMARY KEY(message_id, liker_profile_id)', async () => {
    await applyMigrationFile(db, likesMigrationPath)
  await applyMigrationFile(db, attachmentsMigrationPath)
    const info = db.prepare(`PRAGMA table_info(topic_message_likes);`).all() as Array<{ name: string; pk: number }>
    const pkCols = info.filter((c) => c.pk > 0).map((c) => c.name).sort()
    assertEqual(JSON.stringify(pkCols), JSON.stringify(['liker_profile_id', 'message_id']), 'PK трябва да е точно (message_id, liker_profile_id)')
  })

  seedProfile(db, 'liker-1')
  insertTopic(db, { topicId: 'topic-x', slug: 'topic-x', title: 'Тема X' })
  insertMessage(db, { messageId: 'msg-1', topicId: 'topic-x', senderProfileId: 'liker-1', senderDisplayName: 'L1', body: 'hi' })

  await check('[1] DB constraint отхвърля дублиран (message_id, liker_profile_id) INSERT директно', () => {
    db.prepare(`INSERT INTO topic_message_likes (message_id, liker_profile_id) VALUES (?, ?)`).run('msg-1', 'liker-1')
    let threw = false
    try {
      db.prepare(`INSERT INTO topic_message_likes (message_id, liker_profile_id) VALUES (?, ?)`).run('msg-1', 'liker-1')
    } catch {
      threw = true
    }
    assert(threw, 'Директен дублиран INSERT (без ON CONFLICT) трябва да хвърли UNIQUE/PK violation')
  })

  await check('[2] ON DELETE CASCADE от topic_messages чисти likes при изтрит message', () => {
    const before = db.prepare(`SELECT COUNT(*) as cnt FROM topic_message_likes WHERE message_id = 'msg-1'`).get() as { cnt: number }
    assert(before.cnt > 0, 'трябва да има поне 1 like преди изтриване')
    db.prepare(`DELETE FROM topic_messages WHERE message_id = 'msg-1'`).run()
    const after = db.prepare(`SELECT COUNT(*) as cnt FROM topic_message_likes WHERE message_id = 'msg-1'`).get() as { cnt: number }
    assertEqual(after.cnt, 0, 'likes трябва да изчезнат каскадно след изтриване на message-а')
  })

  db.close()
})

// ─── [3]-[9] Replies store методи ───────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'replies-store.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildBaseSchema(db)
  await applyMigrationFile(db, topicsMigrationPath)
  await applyMigrationFile(db, likesMigrationPath)
  await applyMigrationFile(db, attachmentsMigrationPath)

  seedProfile(db, 'sender-1')
  seedProfile(db, 'sender-2')
  insertTopic(db, { topicId: 'topic-x', slug: 'topic-x', title: 'Тема X' })
  insertTopic(db, { topicId: 'topic-y', slug: 'topic-y', title: 'Тема Y' })

  const rootSeqA = insertMessage(db, { messageId: 'root-a', topicId: 'topic-x', senderProfileId: 'sender-1', senderDisplayName: 'S1', body: 'root A' })
  const rootSeqB = insertMessage(db, { messageId: 'root-b', topicId: 'topic-x', senderProfileId: 'sender-1', senderDisplayName: 'S1', body: 'root B' })
  void rootSeqA
  void rootSeqB

  const store = await createTopicMessageStore(dbPath)

  await check('[3] insertReply вмъква ред с parent_message_id = зададения root', () => {
    const reply = store.insertReply({
      topicId: 'topic-x',
      parentMessageId: 'root-a',
      senderProfileId: 'sender-2',
      senderDisplayName: 'S2',
      senderRole: 'player',
      body: 'reply to A',
    })
    assertEqual(reply.parentMessageId, 'root-a', 'parentMessageId трябва да е root-a')
    assertEqual(reply.topicId, 'topic-x', 'topicId трябва да се пази')
  })

  // Ощe 24 replies към root-a за hasMore/pagination тестовете (общо 25).
  for (let i = 0; i < 24; i++) {
    store.insertReply({
      topicId: 'topic-x',
      parentMessageId: 'root-a',
      senderProfileId: 'sender-2',
      senderDisplayName: 'S2',
      senderRole: 'player',
      body: `reply ${i}`,
    })
  }
  store.insertReply({
    topicId: 'topic-x',
    parentMessageId: 'root-b',
    senderProfileId: 'sender-2',
    senderDisplayName: 'S2',
    senderRole: 'player',
    body: 'reply to B, not A',
  })

  await check('[4] getReplies връща replies старо→ново (ASC)', () => {
    const page = store.getReplies('root-a', 5, [])
    assertEqual(page.messages.length, 5, 'трябва да върне 5 replies')
    assertEqual(page.messages[0]!.body, 'reply to A', 'първият reply (най-стар) трябва да е първи')
    assert(page.messages[0]!.seq < page.messages[4]!.seq, 'seq трябва да нараства (ASC)')
  })

  await check('[5] getReplies hasMore=true при повече от limit replies', () => {
    const page = store.getReplies('root-a', 10, [])
    assertEqual(page.hasMore, true, 'root-a има 25 replies, limit=10 → hasMore трябва да е true')
  })

  await check('[6] getRepliesAfter връща replies СЛЕД даден seq (forward cursor)', () => {
    const firstPage = store.getReplies('root-a', 5, [])
    const cursor = firstPage.messages[4]!.seq
    const nextPage = store.getRepliesAfter('root-a', cursor, 5, [])
    assertEqual(nextPage.messages.length, 5, 'трябва да върне следващите 5')
    assert(nextPage.messages[0]!.seq > cursor, 'първият ред от следващата страница трябва да е СЛЕД cursor-а')
  })

  await check('[7] getReplies никога не връща replies от друг root message (isolation)', () => {
    const page = store.getReplies('root-a', 100, [])
    assert(page.messages.every((m) => m.body !== 'reply to B, not A'), 'replies на root-b не трябва да изтекат в root-a списъка')
  })

  await check('[8] getMessageById връща null за несъществуващ message', () => {
    assertEqual(store.getMessageById('does-not-exist'), null, 'трябва да върне null')
  })

  await check('[9] getMessageById връща коректен snapshot с parentMessageId', () => {
    const msg = store.getMessageById('root-a')
    assert(msg !== null, 'root-a трябва да съществува')
    assertEqual(msg!.parentMessageId, null, 'root-a е ROOT съобщение, parentMessageId трябва да е null')
  })

  store.close()
  db.close()
})

// ─── [10]-[13] toggleLike ────────────────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'toggle-like.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildBaseSchema(db)
  await applyMigrationFile(db, topicsMigrationPath)
  await applyMigrationFile(db, likesMigrationPath)
  await applyMigrationFile(db, attachmentsMigrationPath)

  seedProfile(db, 'viewer-1')
  seedProfile(db, 'viewer-2')
  seedProfile(db, 'viewer-3')
  insertTopic(db, { topicId: 'topic-x', slug: 'topic-x', title: 'Тема X' })
  insertMessage(db, { messageId: 'msg-1', topicId: 'topic-x', senderProfileId: 'viewer-1', senderDisplayName: 'V1', body: 'hi' })

  const store = await createTopicMessageStore(dbPath)

  await check('[10] toggleLike: първи toggle → INSERT, likeCount=1, viewerHasLiked=true', () => {
    const result = store.toggleLike('msg-1', 'viewer-1')
    assertEqual(result.likeCount, 1, 'likeCount трябва да е 1')
    assertEqual(result.viewerHasLiked, true, 'viewerHasLiked трябва да е true')
  })

  await check('[11] toggleLike: втори toggle (unlike) → DELETE, likeCount=0, viewerHasLiked=false', () => {
    const result = store.toggleLike('msg-1', 'viewer-1')
    assertEqual(result.likeCount, 0, 'likeCount трябва да е 0 след unlike')
    assertEqual(result.viewerHasLiked, false, 'viewerHasLiked трябва да е false')
  })

  await check('[12] toggleLike: трети toggle (like отново) → likeCount=1, viewerHasLiked=true', () => {
    const result = store.toggleLike('msg-1', 'viewer-1')
    assertEqual(result.likeCount, 1, 'likeCount трябва да се увеличи отново до 1')
    assertEqual(result.viewerHasLiked, true, 'viewerHasLiked трябва да е true отново')
  })

  await check('[13] toggleLike е изолиран per (message, profile) — друг profile like не пречи', () => {
    const result = store.toggleLike('msg-1', 'viewer-2')
    assertEqual(result.likeCount, 2, 'likeCount трябва да е 2 (viewer-1 + viewer-2)')
    assertEqual(result.viewerHasLiked, true, 'viewer-2 виждa собствения си viewerHasLiked=true')

    const aggregates = store.getMessageAggregatesByIds(['msg-1'], 'viewer-1')
    assertEqual(aggregates.get('msg-1')!.likeCount, 2, 'likeCount остава 2 общо')
    assertEqual(aggregates.get('msg-1')!.viewerHasLiked, true, 'viewer-1 своя viewerHasLiked остава true, независимо от viewer-2 действието')
  })

  store.close()
  db.close()
})

// ─── [14]-[19] getMessageAggregatesByIds / getLikeCountsByMessageIds ──────────

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'aggregates.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildBaseSchema(db)
  await applyMigrationFile(db, topicsMigrationPath)
  await applyMigrationFile(db, likesMigrationPath)
  await applyMigrationFile(db, attachmentsMigrationPath)

  seedProfile(db, 'viewer-1')
  seedProfile(db, 'viewer-2')
  seedProfile(db, 'viewer-3')
  insertTopic(db, { topicId: 'topic-x', slug: 'topic-x', title: 'Тема X' })

  insertMessage(db, { messageId: 'msg-a', topicId: 'topic-x', senderProfileId: 'viewer-1', senderDisplayName: 'V1', body: 'A' })
  insertMessage(db, { messageId: 'msg-b', topicId: 'topic-x', senderProfileId: 'viewer-1', senderDisplayName: 'V1', body: 'B' })
  insertMessage(db, { messageId: 'reply-a-1', topicId: 'topic-x', parentMessageId: 'msg-a', senderProfileId: 'viewer-2', senderDisplayName: 'V2', body: 'reply' })
  insertMessage(db, {
    messageId: 'reply-a-2-deleted',
    topicId: 'topic-x',
    parentMessageId: 'msg-a',
    senderProfileId: 'viewer-2',
    senderDisplayName: 'V2',
    body: 'deleted reply',
    deletedAt: new Date().toISOString(),
  })

  db.prepare(`INSERT INTO topic_message_likes (message_id, liker_profile_id) VALUES (?, ?)`).run('msg-a', 'viewer-2')
  db.prepare(`INSERT INTO topic_message_likes (message_id, liker_profile_id) VALUES (?, ?)`).run('msg-a', 'viewer-3')
  db.prepare(`INSERT INTO topic_message_likes (message_id, liker_profile_id) VALUES (?, ?)`).run('msg-b', 'viewer-3')

  const store = await createTopicMessageStore(dbPath)

  await check('[14] getMessageAggregatesByIds: likeCount батово за няколко message-а', () => {
    const result = store.getMessageAggregatesByIds(['msg-a', 'msg-b'], null)
    assertEqual(result.get('msg-a')!.likeCount, 2, 'msg-a трябва да има 2 likes')
    assertEqual(result.get('msg-b')!.likeCount, 1, 'msg-b трябва да има 1 like')
  })

  await check('[15] getMessageAggregatesByIds: replyCount брои само НЕ-изтрити replies', () => {
    const result = store.getMessageAggregatesByIds(['msg-a'], null)
    assertEqual(result.get('msg-a')!.replyCount, 1, 'msg-a трябва да има точно 1 reply (изтрития не се брои)')
  })

  await check('[16] getMessageAggregatesByIds: viewerHasLiked=true само за viewer-а', () => {
    const asViewer2 = store.getMessageAggregatesByIds(['msg-a'], 'viewer-2')
    const asViewer1 = store.getMessageAggregatesByIds(['msg-a'], 'viewer-1')
    assertEqual(asViewer2.get('msg-a')!.viewerHasLiked, true, 'viewer-2 е харесал msg-a')
    assertEqual(asViewer1.get('msg-a')!.viewerHasLiked, false, 'viewer-1 НЕ е харесал msg-a')
  })

  await check('[17] getMessageAggregatesByIds: viewerProfileId=null → viewerHasLiked винаги false', () => {
    const result = store.getMessageAggregatesByIds(['msg-a'], null)
    assertEqual(result.get('msg-a')!.viewerHasLiked, false, 'null viewer → винаги false')
  })

  await check('[18] getMessageAggregatesByIds: празен messageIds масив → празна Map, без грешка', () => {
    const result = store.getMessageAggregatesByIds([], 'viewer-1')
    assertEqual(result.size, 0, 'трябва да върне празна Map')
  })

  await check('[19] getLikeCountsByMessageIds връща 0 за message без likes (не липсва от Map-а)', () => {
    insertMessage(db, { messageId: 'msg-no-likes', topicId: 'topic-x', senderProfileId: 'viewer-1', senderDisplayName: 'V1', body: 'no likes' })
    const result = store.getLikeCountsByMessageIds(['msg-a', 'msg-no-likes'])
    assertEqual(result.get('msg-a'), 2, 'msg-a трябва да има 2')
    assertEqual(result.get('msg-no-likes'), 0, 'msg-no-likes трябва да е 0, не undefined')
  })

  await check('[22] getMessageAggregatesByIds: replyCount е viewer-aware — excludedSenderProfileIds намалява брояча (blocked sender)', () => {
    insertMessage(db, { messageId: 'msg-block-root', topicId: 'topic-x', senderProfileId: 'viewer-1', senderDisplayName: 'V1', body: 'root за block теста' })
    insertMessage(db, { messageId: 'reply-from-viewer-2', topicId: 'topic-x', parentMessageId: 'msg-block-root', senderProfileId: 'viewer-2', senderDisplayName: 'V2', body: 'reply от viewer-2' })
    insertMessage(db, { messageId: 'reply-from-viewer-3', topicId: 'topic-x', parentMessageId: 'msg-block-root', senderProfileId: 'viewer-3', senderDisplayName: 'V3', body: 'reply от viewer-3' })

    const unfiltered = store.getMessageAggregatesByIds(['msg-block-root'], 'viewer-1')
    assertEqual(unfiltered.get('msg-block-root')!.replyCount, 2, 'без exclusion трябва да брои и двата replies')

    // viewer-1 е блокирал viewer-2 — replyCount за viewer-1 трябва да отрази
    // само видимите за него replies (тук: само reply-a от viewer-3).
    const filtered = store.getMessageAggregatesByIds(['msg-block-root'], 'viewer-1', ['viewer-2'])
    assertEqual(filtered.get('msg-block-root')!.replyCount, 1, 'с exclusion на viewer-2 replyCount трябва да падне до 1 (само viewer-3 остава видим)')

    // likeCount НЕ трябва да се променя от excludedSenderProfileIds — likes
    // са global aggregate, block не влияе на count-а (Етап 3 брифа).
    db.prepare(`INSERT INTO topic_message_likes (message_id, liker_profile_id) VALUES (?, ?)`).run('msg-block-root', 'viewer-2')
    const likeUnfiltered = store.getMessageAggregatesByIds(['msg-block-root'], 'viewer-1')
    const likeFiltered = store.getMessageAggregatesByIds(['msg-block-root'], 'viewer-1', ['viewer-2'])
    assertEqual(likeUnfiltered.get('msg-block-root')!.likeCount, likeFiltered.get('msg-block-root')!.likeCount, 'likeCount трябва да е ЕДНАКЪВ независимо от excludedSenderProfileIds (block не пипа like aggregate)')
  })

  store.close()
  db.close()
})

// ─── [20]-[21] pollNewMessages вижда replies ────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'poll-replies.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildBaseSchema(db)
  await applyMigrationFile(db, topicsMigrationPath)
  await applyMigrationFile(db, likesMigrationPath)
  await applyMigrationFile(db, attachmentsMigrationPath)

  seedProfile(db, 'sender-1')
  insertTopic(db, { topicId: 'topic-x', slug: 'topic-x', title: 'Тема X' })

  const store = await createTopicMessageStore(dbPath)

  const root = store.insertMessage({ topicId: 'topic-x', senderProfileId: 'sender-1', senderDisplayName: 'S1', senderRole: 'player', body: 'root' })
  const reply = store.insertReply({ topicId: 'topic-x', parentMessageId: root.messageId, senderProfileId: 'sender-1', senderDisplayName: 'S1', senderRole: 'player', body: 'reply' })

  await check('[20] pollNewMessages вече връща И root, И reply редове (Етап 3 разширение)', () => {
    const rows = store.pollNewMessages(0, 100)
    const ids = rows.map((r) => r.messageId)
    assert(ids.includes(root.messageId), 'poll трябва да включва root съобщението')
    assert(ids.includes(reply.messageId), 'poll трябва да включва reply съобщението')
  })

  insertMessage(db, {
    messageId: 'deleted-root',
    topicId: 'topic-x',
    senderProfileId: 'sender-1',
    senderDisplayName: 'S1',
    body: 'deleted',
    deletedAt: new Date().toISOString(),
  })

  await check('[21] pollNewMessages НЕ връща изтрити (deleted_at) редове, root или reply', () => {
    const rows = store.pollNewMessages(0, 100)
    assert(rows.every((r) => r.messageId !== 'deleted-root'), 'изтрития ред не трябва да се появи в poll резултата')
  })

  store.close()
  db.close()
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
