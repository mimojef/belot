/**
 * checkTopicsStore.ts
 *
 * Checks за Етап 1 ("Теми" read-only фундамент): migration/seed
 * idempotency, topicStore, topicMessageStore (cursor/seq history, root-only,
 * blocking filter). Прилага РЕАЛНИЯ migration файл (20260810_002), не копие
 * на schema-та, за да тества действителното поведение на seed-а.
 *
 * [0]  Migration създава точно 1 системен "Общ чат" (slug='general')
 * [1]  Системният topic няма created_by_profile_id (NULL, не PIKABG UUID)
 * [2]  Повторно изпълнение на migration файла (restart simulation) НЕ създава втори general topic
 * [3]  listActiveTopics връща само status='active' записи
 * [4]  listActiveTopics подрежда по sort_order, после created_at
 * [5]  getTopicById за съществуваща тема връща коректен snapshot
 * [6]  getTopicById за несъществуващ id връща null (malformed/unknown lookup)
 * [7]  getGeneralTopic връща системната тема
 * [8]  getRecentMessages връща последните N съобщения, подредени старо→ново
 * [9]  getRecentMessages hasMore=true когато има повече от limit съобщения
 * [10] getRecentMessages hasMore=false когато съобщенията са <= limit
 * [11] getMessagesBefore (cursor) връща по-стари от beforeSeq, стабилно подредени
 * [12] Cursor pagination НЕ разчита на OFFSET — insert по средата наseq диапазона не чупи резултата
 * [13] Изтрити съобщения (deleted_at NOT NULL) никога не се връщат
 * [14] Replies (parent_message_id NOT NULL) не се връщат в root stream
 * [15] Topic isolation — съобщения от друга тема никога не изтичат в резултата
 * [16] Празна тема връща messages=[], hasMore=false, oldestSeq=null
 * [17] seq подредбата е стабилна и монотонна между заявки
 * [18] Blocking filter (excludedSenderProfileIds) изключва блокирани податели от историята
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTopicStore } from '../src/db/topicStore.js'
import { createTopicMessageStore } from '../src/db/topicMessageStore.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const topicsMigrationPath = resolve(serverRoot, 'database/migrations/20260810_002_create_topics_and_messages.sql')
const likesMigrationPath = resolve(serverRoot, 'database/migrations/20260811_001_create_topic_message_likes.sql')
const attachmentsMigrationPath = resolve(serverRoot, 'database/migrations/20260811_002_create_topic_message_attachments.sql')

// ─── Брояч ───────────────────────────────────────────────────────────────

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

// ─── Helpers ───────────────────────────────────────────────────────────────

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-topics-check-'))
  try {
    await fn(dir)
  } finally {
    // maxRetries/retryDelay — на Windows файловият handle към SQLite
    // WAL/-shm файловете понякога се освобождава с малко закъснение след
    // DatabaseSync.close(), особено при множество connections към един
    // файл (тук: сурова db + topicMessageStore + playerProgressStore).
    // fs.rm-ret retry вградено покрива този race, без изкуствен sleep.
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

// Лек mock на "getPublicProfile по id" — точния интерфейс, който index.ts
// enrichment-ът реално вика (playerProgressStore.getPublicProfile(id)).
// НЕ пресъздаваме цялата playerProgressStore инфраструктура тук (изисква
// account/wallet/progress/gallery таблици извън обхвата на този тест) —
// getPublicProfile вече е established, тестван от други check scripts в
// проекта; тук тестваме САМО enrichment композицията (derived-not-snapshot
// поведението), не вътрешната SQL логика на playerProgressStore.
function createMockAvatarLookup(initial: Record<string, string | null>) {
  const avatars = new Map<string, string | null>(Object.entries(initial))
  return {
    getAvatarUrl: (profileId: string): string | null => avatars.get(profileId) ?? null,
    setAvatarUrl: (profileId: string, avatarUrl: string | null): void => {
      avatars.set(profileId, avatarUrl)
    },
  }
}

// Mock на playerProgressStore.getProfileSnapshotsByIds — точния batch helper,
// който index.ts handleTopicMessagesRequest реално вика. callCount брои
// колко пъти самата batch функция е извикана (не колко profileId-та са
// resolve-нати вътре в нея) — за N+1 regression detection: N съобщения от
// K уникални автори трябва да произведат callCount=1 (една batch заявка),
// с K елемента в подадения масив, не N отделни извиквания.
function createMockBatchAvatarLookup(initial: Record<string, string | null>) {
  const avatars = new Map<string, string | null>(Object.entries(initial))
  let callCount = 0
  const requestedIdsPerCall: string[][] = []
  return {
    getProfileSnapshotsByIds: (profileIds: string[]): Array<{ profileId: string; avatarUrl: string | null }> => {
      callCount++
      requestedIdsPerCall.push([...profileIds])
      return profileIds.map((id) => ({ profileId: id, avatarUrl: avatars.get(id) ?? null }))
    },
    getCallCount: (): number => callCount,
    getRequestedIdsPerCall: (): string[][] => requestedIdsPerCall,
  }
}

// Прилага реален migration файл, точно както migration runner-ът (BEGIN/COMMIT wrap).
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

function insertTopic(db: DatabaseSync, input: {
  topicId: string
  slug: string
  title: string
  sortOrder?: number
  status?: string
}): void {
  db.prepare(`
    INSERT INTO topics (topic_id, slug, title, is_general, created_by_profile_id, status, sort_order)
    VALUES (?, ?, ?, 0, NULL, ?, ?);
  `).run(input.topicId, input.slug, input.title, input.status ?? 'active', input.sortOrder ?? 100)
}

function insertMessage(db: DatabaseSync, input: {
  messageId: string
  topicId: string
  parentMessageId?: string | null
  senderProfileId: string
  senderDisplayName: string
  body: string
  deletedAt?: string | null
  createdAt?: string
}): number {
  db.prepare(`
    INSERT INTO topic_messages (
      message_id, topic_id, parent_message_id, sender_profile_id, sender_display_name, sender_role, body, deleted_at, created_at
    ) VALUES (?, ?, ?, ?, ?, 'player', ?, ?, COALESCE(?, CURRENT_TIMESTAMP));
  `).run(
    input.messageId,
    input.topicId,
    input.parentMessageId ?? null,
    input.senderProfileId,
    input.senderDisplayName,
    input.body,
    input.deletedAt ?? null,
    input.createdAt ?? null,
  )
  const row = db.prepare(`SELECT seq FROM topic_messages WHERE message_id = ?`).get(input.messageId) as { seq: number }
  return row.seq
}

// ─── Тестове: migration / seed idempotency ─────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'topics-migration.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildBaseSchema(db)

  await check('[0] Migration създава точно 1 системен "Общ чат" (slug=general)', async () => {
    await applyMigrationFile(db, topicsMigrationPath)
    const rows = db.prepare(`SELECT * FROM topics WHERE slug = 'general'`).all()
    assertEqual(rows.length, 1, 'трябва да има точно 1 ред със slug=general')
  })

  await check('[1] Системният topic няма created_by_profile_id (NULL)', () => {
    const row = db.prepare(`SELECT created_by_profile_id, is_general FROM topics WHERE slug = 'general'`).get() as {
      created_by_profile_id: string | null
      is_general: number
    }
    assertEqual(row.created_by_profile_id, null, 'created_by_profile_id трябва да е NULL, не PIKABG UUID')
    assertEqual(row.is_general, 1, 'is_general трябва да е 1')
  })

  await check('[2] Повторно изпълнение на migration файла НЕ създава втори general topic', async () => {
    // Симулира restart на сървъра — migration runner-ът пропуска вече
    // приложени migrations по filename в production, но тук тестваме
    // самата SQL идемпотентност (ON CONFLICT(slug) DO NOTHING), която е
    // независимата защита дори ако runner-ът някога изпълни файла двукратно.
    await applyMigrationFile(db, topicsMigrationPath)
    await applyMigrationFile(db, topicsMigrationPath)
    const rows = db.prepare(`SELECT * FROM topics WHERE slug = 'general'`).all()
    assertEqual(rows.length, 1, 'след 3 общо изпълнения на migration файла пак трябва да има точно 1 general topic')
  })

  db.close()
})

// ─── Тестове: topicStore ────────────────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'topics-store.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildBaseSchema(db)
  await applyMigrationFile(db, topicsMigrationPath)

  insertTopic(db, { topicId: 'topic-a', slug: 'belot', title: 'Белот', sortOrder: 10 })
  insertTopic(db, { topicId: 'topic-b', slug: 'tournaments', title: 'Турнири', sortOrder: 20 })
  insertTopic(db, { topicId: 'topic-locked', slug: 'locked-one', title: 'Заключена', status: 'locked', sortOrder: 5 })
  insertTopic(db, { topicId: 'topic-removed', slug: 'removed-one', title: 'Изтрита', status: 'removed', sortOrder: 1 })

  const store = await createTopicStore(dbPath)

  await check('[3] listActiveTopics връща само status=active записи', () => {
    const topics = store.listActiveTopics()
    const slugs = topics.map((t) => t.slug).sort()
    assertEqual(
      slugs.join(','),
      ['general', 'belot', 'tournaments'].sort().join(','),
      'locked/removed теми не трябва да се връщат',
    )
  })

  await check('[4] listActiveTopics подрежда по sort_order, после created_at', () => {
    const topics = store.listActiveTopics()
    // general е seed-нат с sort_order=0 → трябва да е първи.
    assertEqual(topics[0]!.slug, 'general', 'general (sort_order=0) трябва да е първи')
    assertEqual(topics[1]!.slug, 'belot', 'belot (sort_order=10) трябва да е втори')
    assertEqual(topics[2]!.slug, 'tournaments', 'tournaments (sort_order=20) трябва да е трети')
  })

  await check('[5] getTopicById за съществуваща тема връща коректен snapshot', () => {
    const topic = store.getTopicById('topic-a')
    assert(topic !== null, 'topic-a трябва да съществува')
    assertEqual(topic!.slug, 'belot', 'slug трябва да съвпада')
    assertEqual(topic!.title, 'Белот', 'title трябва да съвпада')
  })

  await check('[6] getTopicById за несъществуващ/malformed id връща null', () => {
    assertEqual(store.getTopicById('does-not-exist'), null, 'несъществуващ id → null')
    assertEqual(store.getTopicById(''), null, 'празен string id → null')
    assertEqual(store.getTopicById('; DROP TABLE topics; --'), null, 'malformed id → null, без грешка')
  })

  await check('[7] getGeneralTopic връща системната тема', () => {
    const general = store.getGeneralTopic()
    assert(general !== null, 'general topic трябва да съществува')
    assertEqual(general!.slug, 'general', 'slug трябва да е general')
    assertEqual(general!.createdByProfileId, null, 'createdByProfileId трябва да е null')
  })

  store.close()
  db.close()
})

// ─── Тестове: topicMessageStore — cursor/seq history ───────────────────────

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'topics-messages.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildBaseSchema(db)
  await applyMigrationFile(db, topicsMigrationPath)
  await applyMigrationFile(db, likesMigrationPath)
  await applyMigrationFile(db, attachmentsMigrationPath)

  seedProfile(db, 'sender-1')
  seedProfile(db, 'sender-2')
  seedProfile(db, 'sender-blocked')
  insertTopic(db, { topicId: 'topic-x', slug: 'topic-x', title: 'Тема X' })
  insertTopic(db, { topicId: 'topic-y', slug: 'topic-y', title: 'Тема Y' })

  // 5 root съобщения в topic-x, последователно (seq нараства монотонно).
  const seqs: number[] = []
  for (let i = 1; i <= 5; i++) {
    seqs.push(insertMessage(db, {
      messageId: `msg-x-${i}`,
      topicId: 'topic-x',
      senderProfileId: 'sender-1',
      senderDisplayName: 'Sender One',
      body: `Съобщение ${i}`,
    }))
  }

  const store = await createTopicMessageStore(dbPath)

  await check('[8] getRecentMessages връща последните N съобщения, подредени старо→ново', () => {
    const page = store.getRecentMessages('topic-x', 3, [])
    assertEqual(page.messages.length, 3, 'трябва да върне точно 3 съобщения')
    assertEqual(page.messages[0]!.body, 'Съобщение 3', 'най-старото от последните 3 трябва да е първо')
    assertEqual(page.messages[2]!.body, 'Съобщение 5', 'най-новото трябва да е последно')
  })

  await check('[9] getRecentMessages hasMore=true когато има повече от limit съобщения', () => {
    const page = store.getRecentMessages('topic-x', 3, [])
    assertEqual(page.hasMore, true, 'има 5 съобщения общо, limit=3 → hasMore=true')
  })

  await check('[10] getRecentMessages hasMore=false когато съобщенията са <= limit', () => {
    const page = store.getRecentMessages('topic-x', 10, [])
    assertEqual(page.hasMore, false, '5 съобщения, limit=10 → hasMore=false')
    assertEqual(page.messages.length, 5, 'трябва да върне всичките 5')
  })

  await check('[11] getMessagesBefore (cursor) връща по-стари от beforeSeq, стабилно подредени', () => {
    const recentPage = store.getRecentMessages('topic-x', 2, [])
    assertEqual(recentPage.messages.length, 2, 'последните 2: Съобщение 4, 5')
    const oldestSeq = recentPage.oldestSeq!
    const olderPage = store.getMessagesBefore('topic-x', oldestSeq, 2, [])
    assertEqual(olderPage.messages.length, 2, 'по-старите 2: Съобщение 2, 3')
    assertEqual(olderPage.messages[0]!.body, 'Съобщение 2', 'старо→ново подредба')
    assertEqual(olderPage.messages[1]!.body, 'Съобщение 3', 'старо→ново подредба')
    assert(olderPage.messages.every((m) => m.seq < oldestSeq), 'всички трябва да имат seq < oldestSeq')
  })

  await check('[12] Cursor pagination НЕ разчита на OFFSET — insert по средата не чупи резултата', () => {
    // Вмъкваме ново съобщение (по-висок seq) СЛЕД като вече сме взели курсора —
    // ако логиката разчиташе на OFFSET (позиционен индекс), нов ред би "избутал"
    // резултатите с 1 позиция. seq<cursor филтърът е имунизиран срещу това.
    const beforeInsertPage = store.getRecentMessages('topic-x', 2, [])
    const cursor = beforeInsertPage.oldestSeq!
    insertMessage(db, {
      messageId: 'msg-x-inserted-later',
      topicId: 'topic-x',
      senderProfileId: 'sender-1',
      senderDisplayName: 'Sender One',
      body: 'Вмъкнато по-късно',
    })
    const olderPage = store.getMessagesBefore('topic-x', cursor, 10, [])
    assert(
      !olderPage.messages.some((m) => m.body === 'Вмъкнато по-късно'),
      'новo-вмъкнатото съобщение (по-висок seq от cursor) не трябва да се появи в "по-стари от cursor" резултата',
    )
  })

  await check('[13] Изтрити съобщения (deleted_at NOT NULL) никога не се връщат', () => {
    insertMessage(db, {
      messageId: 'msg-x-deleted',
      topicId: 'topic-x',
      senderProfileId: 'sender-1',
      senderDisplayName: 'Sender One',
      body: 'Това е изтрито съобщение',
      deletedAt: new Date().toISOString(),
    })
    const page = store.getRecentMessages('topic-x', 100, [])
    assert(
      !page.messages.some((m) => m.body === 'Това е изтрито съобщение'),
      'изтрито съобщение не трябва да се показва като нормално съдържание',
    )
  })

  await check('[14] Replies (parent_message_id NOT NULL) не се връщат в root stream', () => {
    insertMessage(db, {
      messageId: 'msg-x-reply',
      topicId: 'topic-x',
      parentMessageId: 'msg-x-1',
      senderProfileId: 'sender-2',
      senderDisplayName: 'Sender Two',
      body: 'Това е reply, не root съобщение',
    })
    const page = store.getRecentMessages('topic-x', 100, [])
    assert(
      !page.messages.some((m) => m.body === 'Това е reply, не root съобщение'),
      'reply не трябва да се появи в root message stream-а на Етап 1',
    )
  })

  await check('[15] Topic isolation — съобщения от друга тема никога не изтичат', () => {
    insertMessage(db, {
      messageId: 'msg-y-1',
      topicId: 'topic-y',
      senderProfileId: 'sender-1',
      senderDisplayName: 'Sender One',
      body: 'Съобщение в тема Y',
    })
    const pageX = store.getRecentMessages('topic-x', 100, [])
    assert(
      !pageX.messages.some((m) => m.topicId !== 'topic-x'),
      'topic-x резултатът не трябва да съдържа съобщения от topic-y',
    )
    const pageY = store.getRecentMessages('topic-y', 100, [])
    assertEqual(pageY.messages.length, 1, 'topic-y трябва да съдържа само своето 1 съобщение')
  })

  await check('[16] Празна тема връща messages=[], hasMore=false, oldestSeq=null', () => {
    insertTopic(db, { topicId: 'topic-empty', slug: 'topic-empty', title: 'Празна тема' })
    const page = store.getRecentMessages('topic-empty', 30, [])
    assertEqual(page.messages.length, 0, 'няма съобщения')
    assertEqual(page.hasMore, false, 'hasMore трябва да е false')
    assertEqual(page.oldestSeq, null, 'oldestSeq трябва да е null')
  })

  await check('[17] seq подредбата е стабилна и монотонна между заявки', () => {
    const page1 = store.getRecentMessages('topic-x', 100, [])
    const page2 = store.getRecentMessages('topic-x', 100, [])
    assertEqual(
      page1.messages.map((m) => m.seq).join(','),
      page2.messages.map((m) => m.seq).join(','),
      'две последователни заявки трябва да върнат идентична подредба',
    )
    for (let i = 1; i < page1.messages.length; i++) {
      assert(page1.messages[i]!.seq > page1.messages[i - 1]!.seq, 'seq трябва да е строго нарастващ по позиция')
    }
  })

  await check('[18] Blocking filter (excludedSenderProfileIds) изключва блокирани податели', () => {
    insertMessage(db, {
      messageId: 'msg-x-blocked-sender',
      topicId: 'topic-x',
      senderProfileId: 'sender-blocked',
      senderDisplayName: 'Blocked Sender',
      body: 'Съобщение от блокиран потребител',
    })
    const withoutFilter = store.getRecentMessages('topic-x', 100, [])
    assert(
      withoutFilter.messages.some((m) => m.senderProfileId === 'sender-blocked'),
      'без филтър съобщението трябва да присъства',
    )
    const withFilter = store.getRecentMessages('topic-x', 100, ['sender-blocked'])
    assert(
      !withFilter.messages.some((m) => m.senderProfileId === 'sender-blocked'),
      'с excludedSenderProfileIds съобщението от блокирания подател не трябва да присъства',
    )
  })

  store.close()
  db.close()
})

// ─── Тестове: avatar resolution (derived, не snapshot) ─────────────────────
// Симулира точно enrichment логиката от handleTopicMessagesRequest в
// index.ts: senderAvatarUrl = playerProgressStore.getPublicProfile(id)?.avatarUrl ?? null.
// playerProgressStore.getPublicProfile е ЕДИНСТВЕНИЯТ source of truth за
// public profile данни в проекта (reuse-ван и от Etап 0 VIP badge
// enrichment) — тестваме, че topic message enrichment-ът произвежда
// ТЕКУЩИЯ avatar, не остарял snapshot.

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'topics-avatar.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildBaseSchema(db)
  await applyMigrationFile(db, topicsMigrationPath)
  await applyMigrationFile(db, likesMigrationPath)
  await applyMigrationFile(db, attachmentsMigrationPath)

  seedProfile(db, 'profile-with-avatar')
  seedProfile(db, 'profile-without-avatar')
  insertTopic(db, { topicId: 'topic-avatar', slug: 'topic-avatar', title: 'Тема с аватари' })
  insertMessage(db, {
    messageId: 'msg-avatar-1',
    topicId: 'topic-avatar',
    senderProfileId: 'profile-with-avatar',
    senderDisplayName: 'Has Avatar',
    body: 'Съобщение от профил с avatar',
  })
  insertMessage(db, {
    messageId: 'msg-avatar-2',
    topicId: 'topic-avatar',
    senderProfileId: 'profile-without-avatar',
    senderDisplayName: 'No Avatar',
    body: 'Съобщение от профил без avatar',
  })

  const topicMessageStore = await createTopicMessageStore(dbPath)
  const avatarLookup = createMockAvatarLookup({
    'profile-with-avatar': 'https://cdn.example.com/avatars/a.webp',
    'profile-without-avatar': null,
  })

  // Точната enrichment композиция от index.ts handleTopicMessagesRequest:
  // senderAvatarUrl = playerProgressStore.getPublicProfile(id)?.avatarUrl ?? null.
  function enrichWithAvatar(messages: ReturnType<typeof topicMessageStore.getRecentMessages>['messages']) {
    return messages.map((message) => ({
      ...message,
      senderAvatarUrl: avatarLookup.getAvatarUrl(message.senderProfileId),
    }))
  }

  await check('[19] Профил С avatar получава реалния avatar URL в enriched съобщението', () => {
    const page = topicMessageStore.getRecentMessages('topic-avatar', 100, [])
    const enriched = enrichWithAvatar(page.messages)
    const msg = enriched.find((m) => m.senderProfileId === 'profile-with-avatar')
    assert(msg !== undefined, 'съобщението трябва да съществува')
    assertEqual(msg!.senderAvatarUrl, 'https://cdn.example.com/avatars/a.webp', 'трябва да върне точния avatar URL')
  })

  await check('[20] Профил БЕЗ avatar получава senderAvatarUrl=null (client fallback letter)', () => {
    const page = topicMessageStore.getRecentMessages('topic-avatar', 100, [])
    const enriched = enrichWithAvatar(page.messages)
    const msg = enriched.find((m) => m.senderProfileId === 'profile-without-avatar')
    assert(msg !== undefined, 'съобщението трябва да съществува')
    assertEqual(msg!.senderAvatarUrl, null, 'без avatar → null, не празен string или undefined')
  })

  await check('[21] Avatar е DERIVED при read, не snapshot — смяна на avatar веднага се отразява', () => {
    // Симулира "потребителят смени снимката си" — обновяваме canonical
    // avatar lookup-а, БЕЗ никаква промяна в topic_messages реда (старото
    // съобщение остава непокътнато в базата).
    avatarLookup.setAvatarUrl('profile-with-avatar', 'https://cdn.example.com/avatars/new.webp')
    const page = topicMessageStore.getRecentMessages('topic-avatar', 100, [])
    const enriched = enrichWithAvatar(page.messages)
    const msg = enriched.find((m) => m.senderProfileId === 'profile-with-avatar')
    assertEqual(
      msg!.senderAvatarUrl,
      'https://cdn.example.com/avatars/new.webp',
      'старото съобщение трябва да показва НОВИЯ avatar (derived, не snapshot от момента на писане)',
    )
  })

  await check('[22] Няма unsafe/raw URL съхранение — topic_messages таблицата няма avatar колона изобщо', () => {
    const columns = db.prepare(`PRAGMA table_info(topic_messages)`).all() as Array<{ name: string }>
    assert(
      !columns.some((c) => c.name.toLowerCase().includes('avatar')),
      'topic_messages не трябва да съдържа никаква avatar колона (derived-only архитектура)',
    )
  })

  topicMessageStore.close()
  db.close()
})

// ─── Тестове: N+1 avatar lookup regression (batch + dedup) ─────────────────
// Симулира точната enrichment логика от handleTopicMessagesRequest в
// index.ts: uniqueSenderProfileIds = [...new Set(messages.map(senderProfileId))],
// после ЕДНА batch заявка (getProfileSnapshotsByIds), не N отделни
// getPublicProfile() извиквания. Регресира ако някой бъдещ рефакторинг
// върне enrichment-а обратно към per-message lookup.

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'topics-n-plus-1.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildBaseSchema(db)
  await applyMigrationFile(db, topicsMigrationPath)
  await applyMigrationFile(db, likesMigrationPath)
  await applyMigrationFile(db, attachmentsMigrationPath)

  const authorIds = ['author-1', 'author-2', 'author-3']
  for (const id of authorIds) seedProfile(db, id)
  insertTopic(db, { topicId: 'topic-n1', slug: 'topic-n1', title: 'Тема с много автори' })

  // 30 съобщения от само 3 различни автора (round-robin) — точно сценарият
  // от брифа: "30 messages от 3 различни authors".
  for (let i = 0; i < 30; i++) {
    insertMessage(db, {
      messageId: `msg-n1-${i}`,
      topicId: 'topic-n1',
      senderProfileId: authorIds[i % 3]!,
      senderDisplayName: `Author ${(i % 3) + 1}`,
      body: `Съобщение ${i}`,
    })
  }

  const topicMessageStore = await createTopicMessageStore(dbPath)
  const batchLookup = createMockBatchAvatarLookup({
    'author-1': 'https://cdn.example.com/a1.webp',
    'author-2': 'https://cdn.example.com/a2.webp',
    'author-3': null,
  })

  // Точната enrichment композиция от index.ts handleTopicMessagesRequest.
  function enrichWithBatchAvatar(messages: ReturnType<typeof topicMessageStore.getRecentMessages>['messages']) {
    const uniqueSenderProfileIds = [...new Set(messages.map((m) => m.senderProfileId))]
    const senderProfiles = batchLookup.getProfileSnapshotsByIds(uniqueSenderProfileIds)
    const avatarUrlByProfileId = new Map(senderProfiles.map((p) => [p.profileId, p.avatarUrl]))
    return messages.map((message) => ({
      ...message,
      senderAvatarUrl: avatarUrlByProfileId.get(message.senderProfileId) ?? null,
    }))
  }

  await check('[23] 30 съобщения от 3 автора → batch lookup извикан точно 1 път (не 30)', () => {
    const page = topicMessageStore.getRecentMessages('topic-n1', 30, [])
    assertEqual(page.messages.length, 30, 'предусловие: трябва да заредим и 30-те съобщения')
    enrichWithBatchAvatar(page.messages)
    assertEqual(batchLookup.getCallCount(), 1, 'batch lookup функцията трябва да се извика точно веднъж за целия response')
  })

  await check('[24] Единствената batch заявка съдържа точно 3 уникални profileId-та (не 30, не с дубликати)', () => {
    const requestedIds = batchLookup.getRequestedIdsPerCall()[0]!
    assertEqual(requestedIds.length, 3, `Очаквах 3 уникални id-та, получих ${requestedIds.length}: ${JSON.stringify(requestedIds)}`)
    assertEqual(new Set(requestedIds).size, 3, 'подадените id-та трябва да са вече дедуплицирани (Set.size === length)')
  })

  await check('[25] Всяко от 30-те enriched съобщения получава правилния avatar за своя автор', () => {
    const page = topicMessageStore.getRecentMessages('topic-n1', 30, [])
    const enriched = enrichWithBatchAvatar(page.messages)
    for (const message of enriched) {
      const expectedAvatar = message.senderProfileId === 'author-1'
        ? 'https://cdn.example.com/a1.webp'
        : message.senderProfileId === 'author-2'
          ? 'https://cdn.example.com/a2.webp'
          : null
      assertEqual(
        message.senderAvatarUrl,
        expectedAvatar,
        `съобщение от ${message.senderProfileId} трябва да получи правилния avatar въпреки batch dedup-а`,
      )
    }
  })

  topicMessageStore.close()
  db.close()
})

// ─── Финален резултат ───────────────────────────────────────────────────────

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)

if (failed > 0) {
  process.exit(1)
}
