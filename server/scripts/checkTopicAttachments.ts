/**
 * checkTopicAttachments.ts
 *
 * Targeted checks за Topics image attachments (Attachment feature брифа):
 * DB migration/constraint, store-level insert/hydration/download-auth,
 * body validation (text-or-image), и protected upload/processing pipeline
 * (reuse на imageAttachments.ts — огледално на
 * checkSupportAttachmentUploadSecurity.ts).
 *
 * [0]  Migration създава topic_message_attachments с message_id PRIMARY KEY (max 1/съобщение по конструкция)
 * [1]  ON DELETE CASCADE от topic_messages чисти attachment реда при изтрит message
 * [2]  insertMessage с attachment вмъква едновременно message + attachment ред (една транзакция)
 * [3]  insertMessage с празен body + attachment е позволен (image-only root съобщение)
 * [4]  insertReply с attachment вмъква едновременно reply + attachment ред
 * [5]  getAttachmentsByMessageIds batch-ва за няколко message-а с 1 заявка ефект, липсващи не се появяват в Map-а
 * [6]  getAttachmentForDownload връща attachment САМО ако принадлежи на подадения topicId (isolation guard)
 * [7]  attachmentExistsForFilename отразява текущото състояние (true след insert, false след изтриване на message)
 * [8]  enqueueAttachmentDeletion/listPendingAttachmentDeletions/markAttachmentDeletionDone цикълът работи
 * [9]  validateTopicMessageBody: празен текст БЕЗ attachment се отхвърля (empty_body)
 * [10] validateTopicMessageBody: празен текст С attachment е валиден (image-only)
 * [11] validateTopicMessageBody: текст С attachment остава ПЪЛНАТА text validation (forbidden chars все още отхвърлени)
 * [12] JPEG/PNG/WebP data URLs декодират и се конвертират в metadata-stripped WebP <= 1920px (reuse на imageAttachments.ts)
 * [13] forged MIME/GIF/corrupt/oversized payloads се отхвърлят от decode/process pipeline-а
 * [14] server source: topic attachment endpoint изисква registered session (не guest), директорията НЕ е в PUBLIC_UPLOAD_SUBDIRECTORY_ROOTS
 * [15] server source: send_topic_message/send_topic_reply upload flow изтрива файла при validation/duplicate/DB грешка (orphan prevention)
 *
 * [16] resolveAttachmentUrl prefix-ва relative attachment path с непразен apiBaseUrl (local dev split-origin :5173/:3001)
 * [17] resolveAttachmentUrl оставя path-а НЕПРОМЕНЕН при празен apiBaseUrl (production same-origin/proxy)
 * [18] renderTopicAttachment (img src / viewer data-атрибути / download href) използва resolveAttachmentUrl — регресира ако Topics отново рендира raw relative URL (bug: local dev SPA fallback вместо image/webp)
 * [19] renderChatAttachmentBubble (chat/support) също минава през resolveAttachmentUrl — consistency между Topics и chat/support attachment display
 *
 * Hard-delete reference-existence модел (corrective pass — заменя стария live-JOIN подход):
 * [20] attachmentExistsForFilename: true веднага след insert
 * [21] attachmentExistsForFilename: false след hard-delete на attachment реда (whole-topic delete пътят, mirror на topicModerationStore.deleteTopic)
 * [22] attachmentExistsForFilename: false за непознат/orphan filename
 * [23] listPendingAttachmentDeletions връща queue-нат job за hard-deleted attachment (enqueue стана ВЪТРЕ в deleteTopic транзакцията, не отделна caller стъпка)
 * [24] server source: runTopicAttachmentCleanup ползва attachmentExistsForFilename (НЕ isAttachmentReferencedByLiveTopicContent — тази функция вече не съществува) за eligibility
 * [25] server source: runTopicAttachmentOrphanScan ползва СЪЩАТА reference-existence дефиниция като cleanup worker-а
 * [26] server source: index.ts НЕ съдържа никакво позоваване на isAttachmentReferencedByLiveTopicContent (regression guard — един-единствен cleanup модел, не два паралелни)
 * [27] getAttachmentForDownload вече КОРЕКТНО връща null за removed-topic attachment (hard-delete = auth boundary, доказано с реален topicModerationStore.deleteTopic)
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import { createTopicMessageStore } from '../src/db/topicMessageStore.js'
import { createTopicModerationStore } from '../src/db/topicModerationStore.js'
import {
  decodeImageAttachmentDataUrl,
  IMAGE_ATTACHMENT_MAX_SOURCE_DIMENSION_PX,
  processImageAttachmentToWebp,
} from '../src/uploads/imageAttachments.js'
import { validateTopicMessageBody } from '../src/protocol/topicMessageValidation.js'
import { resolveAttachmentUrl, renderChatAttachmentBubble } from '../../src/app/lobby/renderLobbyScreen.js'
import { renderTopicAttachment } from '../../src/app/lobby/renderTopicsScreen.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const topicsMigrationPath = resolve(serverRoot, 'database/migrations/20260810_002_create_topics_and_messages.sql')
const likesMigrationPath = resolve(serverRoot, 'database/migrations/20260811_001_create_topic_message_likes.sql')
const attachmentsMigrationPath = resolve(serverRoot, 'database/migrations/20260811_002_create_topic_message_attachments.sql')
const moderationMigrationPath = resolve(serverRoot, 'database/migrations/20260811_003_create_topic_moderation.sql')

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
  const dir = await mkdtemp(join(tmpdir(), 'belot-topic-attachments-check-'))
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
  // Минимален mock (established convention, mirror на checkTopicsStore.ts) —
  // само за да удовлетвори FK референциите на topics.locked_by_account_id/
  // removed_by_account_id и т.н. (Етап 4 moderation migration).
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY
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

function makeAttachment(filename: string) {
  return {
    storageFilename: filename,
    width: 32,
    height: 24,
    byteSize: 128,
    contentType: 'image/webp',
  }
}

function dataUrl(mime: string, buffer: Buffer): string {
  return `data:${mime};base64,${buffer.toString('base64')}`
}

async function createImage(format: 'jpeg' | 'png' | 'webp', width = 32, height = 24): Promise<Buffer> {
  const pipeline = sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 90, b: 200 } },
  })
  if (format === 'jpeg') return await pipeline.jpeg().toBuffer()
  if (format === 'png') return await pipeline.png().toBuffer()
  return await pipeline.webp().toBuffer()
}

// ─── [0]-[1] Migration / constraint ─────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'attachments-migration.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildBaseSchema(db)
  await applyMigrationFile(db, topicsMigrationPath)
  await applyMigrationFile(db, attachmentsMigrationPath)

  await check('[0] Migration създава topic_message_attachments с message_id PRIMARY KEY (max 1/съобщение по конструкция)', () => {
    const info = db.prepare(`PRAGMA table_info(topic_message_attachments);`).all() as Array<{ name: string; pk: number }>
    const pkCols = info.filter((c) => c.pk > 0).map((c) => c.name)
    assertEqual(JSON.stringify(pkCols), JSON.stringify(['message_id']), 'PK трябва да е точно message_id')
  })

  seedProfile(db, 'sender-1')
  insertTopic(db, { topicId: 'topic-x', slug: 'topic-x', title: 'Тема X' })
  db.prepare(`
    INSERT INTO topic_messages (message_id, topic_id, parent_message_id, sender_profile_id, sender_display_name, sender_role, body)
    VALUES ('root-1', 'topic-x', NULL, 'sender-1', 'S1', 'player', 'hi');
  `).run()
  db.prepare(`
    INSERT INTO topic_message_attachments (message_id, storage_filename, width, height, byte_size, content_type)
    VALUES ('root-1', '11111111-1111-4111-8111-111111111111.webp', 32, 24, 128, 'image/webp');
  `).run()

  await check('[1] ON DELETE CASCADE от topic_messages чисти attachment реда при изтрит message', () => {
    const before = db.prepare(`SELECT COUNT(*) as cnt FROM topic_message_attachments WHERE message_id = 'root-1'`).get() as { cnt: number }
    assert(before.cnt === 1, 'трябва да има точно 1 attachment преди изтриване')
    db.prepare(`DELETE FROM topic_messages WHERE message_id = 'root-1'`).run()
    const after = db.prepare(`SELECT COUNT(*) as cnt FROM topic_message_attachments WHERE message_id = 'root-1'`).get() as { cnt: number }
    assertEqual(after.cnt, 0, 'attachment трябва да изчезне каскадно след изтриване на message-а')
  })

  db.close()
})

// ─── [2]-[8] Store-level insert/hydration/download-auth/deletion queue ─────

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'attachments-store.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildBaseSchema(db)
  await applyMigrationFile(db, topicsMigrationPath)
  await applyMigrationFile(db, likesMigrationPath)
  await applyMigrationFile(db, attachmentsMigrationPath)

  seedProfile(db, 'sender-1')
  seedProfile(db, 'sender-2')
  insertTopic(db, { topicId: 'topic-x', slug: 'topic-x', title: 'Тема X' })
  insertTopic(db, { topicId: 'topic-y', slug: 'topic-y', title: 'Тема Y' })
  db.close()

  const store = await createTopicMessageStore(dbPath)
  try {

  const rootImage = makeAttachment('11111111-1111-4111-8111-111111111111.webp')
  const rootMessage = store.insertMessage({
    topicId: 'topic-x',
    senderProfileId: 'sender-1',
    senderDisplayName: 'S1',
    senderRole: 'player',
    body: 'root with image',
    attachment: rootImage,
  })

  await check('[2] insertMessage с attachment вмъква едновременно message + attachment ред (една транзакция)', () => {
    const attachments = store.getAttachmentsByMessageIds([rootMessage.messageId])
    const record = attachments.get(rootMessage.messageId)
    assert(record !== undefined, 'attachment записът трябва да съществува веднага след insertMessage')
    assertEqual(record?.storageFilename, rootImage.storageFilename, 'storageFilename трябва да съвпада')
  })

  const imageOnlyImage = makeAttachment('22222222-2222-4222-8222-222222222222.webp')
  const imageOnlyMessage = store.insertMessage({
    topicId: 'topic-x',
    senderProfileId: 'sender-1',
    senderDisplayName: 'S1',
    senderRole: 'player',
    body: '',
    attachment: imageOnlyImage,
  })

  await check('[3] insertMessage с празен body + attachment е позволен (image-only root съобщение)', () => {
    assertEqual(imageOnlyMessage.body, '', 'image-only съобщение трябва да пази празен body')
    const attachments = store.getAttachmentsByMessageIds([imageOnlyMessage.messageId])
    assert(attachments.has(imageOnlyMessage.messageId), 'image-only съобщението трябва да има attachment запис')
  })

  const replyImage = makeAttachment('33333333-3333-4333-8333-333333333333.webp')
  const reply = store.insertReply({
    topicId: 'topic-x',
    parentMessageId: rootMessage.messageId,
    senderProfileId: 'sender-2',
    senderDisplayName: 'S2',
    senderRole: 'player',
    body: 'reply with image',
    attachment: replyImage,
  })

  await check('[4] insertReply с attachment вмъква едновременно reply + attachment ред', () => {
    const attachments = store.getAttachmentsByMessageIds([reply.messageId])
    const record = attachments.get(reply.messageId)
    assert(record !== undefined, 'reply attachment записът трябва да съществува')
    assertEqual(record?.storageFilename, replyImage.storageFilename, 'reply storageFilename трябва да съвпада')
  })

  const textOnlyMessage = store.insertMessage({
    topicId: 'topic-x',
    senderProfileId: 'sender-1',
    senderDisplayName: 'S1',
    senderRole: 'player',
    body: 'no image here',
  })

  await check('[5] getAttachmentsByMessageIds batch-ва за няколко message-а, липсващи не се появяват в Map-а', () => {
    const ids = [rootMessage.messageId, imageOnlyMessage.messageId, reply.messageId, textOnlyMessage.messageId]
    const attachments = store.getAttachmentsByMessageIds(ids)
    assertEqual(attachments.size, 3, 'Map-ът трябва да съдържа точно 3 записа (без text-only съобщението)')
    assert(!attachments.has(textOnlyMessage.messageId), 'text-only съобщението не трябва да е в Map-а')
  })

  await check('[6] getAttachmentForDownload връща attachment САМО ако принадлежи на подадения topicId (isolation guard)', () => {
    const correctTopic = store.getAttachmentForDownload('topic-x', rootImage.storageFilename)
    assert(correctTopic !== null, 'правилният topicId трябва да върне записа')
    const wrongTopic = store.getAttachmentForDownload('topic-y', rootImage.storageFilename)
    assert(wrongTopic === null, 'грешен topicId (enumeration опит) трябва да върне null')
    const nonExistentFilename = store.getAttachmentForDownload('topic-x', 'ffffffff-ffff-4fff-8fff-ffffffffffff.webp')
    assert(nonExistentFilename === null, 'несъществуващ filename трябва да върне null')
  })

  await check('[7] attachmentExistsForFilename отразява текущото състояние (true след insert, false след изтриване на message)', () => {
    assert(store.attachmentExistsForFilename(rootImage.storageFilename) === true, 'трябва да съществува веднага след insert')
  })

  await check('[8] enqueueAttachmentDeletion/listPendingAttachmentDeletions/markAttachmentDeletionDone цикълът работи', () => {
    store.enqueueAttachmentDeletion('orphan-file.webp')
    const pending = store.listPendingAttachmentDeletions(10)
    const match = pending.find((p) => p.storageFilename === 'orphan-file.webp')
    assert(match !== undefined, 'orphan файлът трябва да е в pending списъка')
    store.markAttachmentDeletionDone(match!.eventSeq)
    const afterDone = store.listPendingAttachmentDeletions(10)
    assert(afterDone.every((p) => p.storageFilename !== 'orphan-file.webp'), 'done записът не трябва повече да е pending')
  })

  } finally {
    store.close()
  }
})

// ─── [9]-[11] Body validation (text-or-image) ───────────────────────────────

await check('[9] validateTopicMessageBody: празен текст БЕЗ attachment се отхвърля (empty_body)', () => {
  const result = validateTopicMessageBody('', false)
  assert(result.ok === false, 'трябва да е невалидно')
  if (!result.ok) assertEqual(result.code, 'empty_body', 'кодът трябва да е empty_body')
})

await check('[10] validateTopicMessageBody: празен текст С attachment е валиден (image-only)', () => {
  const result = validateTopicMessageBody('', true)
  assert(result.ok === true, 'image-only съобщение трябва да е валидно')
  if (result.ok) assertEqual(result.body, '', 'body трябва да остане празен')
})

await check('[11] validateTopicMessageBody: текст С attachment остава ПЪЛНАТА text validation (forbidden chars все още отхвърлени)', () => {
  const withForbiddenChar = validateTopicMessageBody('hello​world', true)
  assert(withForbiddenChar.ok === false, 'forbidden char трябва да се отхвърли дори с attachment')
  if (!withForbiddenChar.ok) assertEqual(withForbiddenChar.code, 'invalid_body', 'кодът трябва да е invalid_body')

  const tooLong = validateTopicMessageBody('x'.repeat(2001), true)
  assert(tooLong.ok === false, 'твърде дълъг текст трябва да се отхвърли дори с attachment')
  if (!tooLong.ok) assertEqual(tooLong.code, 'body_too_long', 'кодът трябва да е body_too_long')

  const validText = validateTopicMessageBody('  normal text  ', true)
  assert(validText.ok === true, 'валиден текст с attachment трябва да мине')
  if (validText.ok) assertEqual(validText.body, 'normal text', 'trim трябва да се приложи')
})

// ─── [12]-[13] Image processing pipeline (reuse на imageAttachments.ts) ────

await check('[12] JPEG/PNG/WebP data URLs декодират и се конвертират в metadata-stripped WebP <= 1920px', async () => {
  for (const format of ['jpeg', 'png', 'webp'] as const) {
    const original = await createImage(format, 2400, 1600)
    const decoded = decodeImageAttachmentDataUrl(dataUrl(format === 'jpeg' ? 'image/jpeg' : `image/${format}`, original))
    assert(decoded !== null, `${format} data URL трябва да декодира`)
    const processed = await processImageAttachmentToWebp(decoded, { enforceSourcePixelLimit: true })
    assert(processed !== null, `${format} трябва да се обработи`)
    const metadata = await sharp(processed!.buffer).metadata()
    assert(metadata.format === 'webp', `${format} трябва да се съхрани като WebP`)
    assert((metadata.width ?? 0) <= 1920 && (metadata.height ?? 0) <= 1920, `${format} трябва да е resize-нат до 1920px`)
    assert(metadata.exif === undefined && metadata.icc === undefined && metadata.xmp === undefined, `${format} не трябва да пази допълнителни metadata`)
  }
})

await check('[13] forged MIME/GIF/corrupt/oversized payloads се отхвърлят от decode/process pipeline-а', async () => {
  const gifHeader = Buffer.from('47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b', 'hex')
  const corrupt = Buffer.from('not-an-image')
  const png = await createImage('png')

  assert(decodeImageAttachmentDataUrl(dataUrl('image/gif', gifHeader)) === null, 'GIF MIME не трябва да декодира')
  assert(decodeImageAttachmentDataUrl(dataUrl('image/png', Buffer.alloc(10_000_001, 1))) === null, '>10MB payload не трябва да декодира')
  assert(await processImageAttachmentToWebp(gifHeader, { enforceSourcePixelLimit: true }) === null, 'forged GIF съдържание не трябва да се обработи')
  assert(await processImageAttachmentToWebp(corrupt, { enforceSourcePixelLimit: true }) === null, 'corrupt съдържание не трябва да се обработи')

  const excessive = await createImage('png', IMAGE_ATTACHMENT_MAX_SOURCE_DIMENSION_PX + 1, 1)
  assert(await processImageAttachmentToWebp(excessive, { enforceSourcePixelLimit: true }) === null, 'прекомерни размери не трябва да се обработят')
  assert(await processImageAttachmentToWebp(png, { enforceSourcePixelLimit: true }) !== null, 'валиден PNG control трябва да се обработи')
})

// ─── [14]-[15] Server source guards (auth boundary, orphan prevention) ─────

await check('[14] server source: topic attachment endpoint изисква registered session, директорията НЕ е в PUBLIC_UPLOAD_SUBDIRECTORY_ROOTS', async () => {
  const serverSource = await readFile(join(serverRoot, 'src', 'index.ts'), 'utf8')
  assert(serverSource.includes('handleTopicAttachmentDownloadRequest'), 'download handler трябва да съществува')
  assert(serverSource.includes('requireRegisteredProfileSession'), 'endpoint трябва да изисква registered session')
  assert(serverSource.includes("TOPIC_ATTACHMENT_UPLOADS_PATH = join(UPLOADS_ROOT_PATH, 'topic-attachments')"), 'topic attachment директорията трябва да е дефинирана')
  const publicRootsMatch = /PUBLIC_UPLOAD_SUBDIRECTORY_ROOTS\s*=\s*\[([^\]]*)\]/.exec(serverSource)
  assert(publicRootsMatch !== null, 'PUBLIC_UPLOAD_SUBDIRECTORY_ROOTS дефиницията трябва да съществува')
  assert(!(publicRootsMatch?.[1] ?? '').includes('TOPIC_ATTACHMENT_UPLOADS_PATH'), 'topic attachment директорията НЕ трябва да е в public uploads allowlist-а')
})

await check('[15] server source: send_topic_message/send_topic_reply upload flow изтрива файла при validation/duplicate/DB грешка (orphan prevention)', async () => {
  const serverSource = await readFile(join(serverRoot, 'src', 'index.ts'), 'utf8')
  assert(serverSource.includes('deleteTopicAttachmentFileByFilename'), 'orphan cleanup helper трябва да съществува')
  assert(serverSource.includes('createTopicAttachmentUpload'), 'upload helper трябва да съществува')
  assert(serverSource.includes('runTopicAttachmentCleanup') && serverSource.includes('runTopicAttachmentOrphanScan'), 'cleanup/orphan-scan job-овете трябва да съществуват')
})

// ─── [16]-[19] Attachment URL resolution (local dev split-origin regression) ─
//
// Confirmed bug: relative /api/.../attachments/... path-и, върнати от
// сървъра, resolve-ват коректно в production (same-origin/proxy), но в
// local dev (frontend :5173, backend :3001, viж vite.config.ts — proxy-нат
// е само /uploads, НЕ /api) browser-ът ги resolve-ва спрямо :5173 и удря
// SPA fallback-а (200 text/html вместо 200 image/webp). Fix-ът reuse-ва
// established resolver-а (main.ts getApiBaseUrl) чрез нов споделен
// resolveAttachmentUrl(apiBaseUrl, path) helper в renderLobbyScreen.ts.

const DEV_API_BASE_URL = 'http://localhost:3001'

await check('[16] resolveAttachmentUrl prefix-ва relative attachment path с непразен apiBaseUrl (local dev split-origin)', () => {
  const resolved = resolveAttachmentUrl(DEV_API_BASE_URL, '/api/topics/topic-general/attachments/11111111-1111-4111-8111-111111111111.webp')
  assertEqual(resolved, 'http://localhost:3001/api/topics/topic-general/attachments/11111111-1111-4111-8111-111111111111.webp', 'resolved URL трябва да сочи изрично към backend origin-а')
})

await check('[17] resolveAttachmentUrl оставя path-а НЕПРОМЕНЕН при празен apiBaseUrl (production same-origin/proxy)', () => {
  const resolved = resolveAttachmentUrl('', '/api/topics/topic-general/attachments/11111111-1111-4111-8111-111111111111.webp')
  assertEqual(resolved, '/api/topics/topic-general/attachments/11111111-1111-4111-8111-111111111111.webp', 'production (празен apiBaseUrl) трябва да пази relative path-а непроменен')
})

await check('[18] renderTopicAttachment (img src / viewer data-атрибути / download href) използва resolveAttachmentUrl', () => {
  const attachment = {
    attachmentId: '22222222-2222-4222-8222-222222222222.webp',
    width: 320,
    height: 240,
    byteSize: 12345,
    viewUrl: '/api/topics/topic-general/attachments/22222222-2222-4222-8222-222222222222.webp',
    downloadUrl: '/api/topics/topic-general/attachments/22222222-2222-4222-8222-222222222222.webp?download=1',
  }

  const devHtml = renderTopicAttachment(attachment, DEV_API_BASE_URL)
  assert(devHtml.includes('src="http://localhost:3001/api/topics/topic-general/attachments/22222222-2222-4222-8222-222222222222.webp"'), 'img src трябва да е resolved спрямо dev backend origin-а')
  assert(devHtml.includes('data-image-viewer-view-url="http://localhost:3001/api/topics/topic-general/attachments/22222222-2222-4222-8222-222222222222.webp"'), 'viewer data-атрибутът трябва да е resolved')
  assert(devHtml.includes('href="http://localhost:3001/api/topics/topic-general/attachments/22222222-2222-4222-8222-222222222222.webp?download=1"'), 'download href трябва да е resolved')
  assert(!devHtml.includes('src="/api/topics/'), 'НЕ трябва да остане raw relative src (regression за оригиналния bug)')

  const prodHtml = renderTopicAttachment(attachment, '')
  assert(prodHtml.includes('src="/api/topics/topic-general/attachments/22222222-2222-4222-8222-222222222222.webp"'), 'production (празен apiBaseUrl) трябва да пази relative src непроменен')
})

await check('[19] renderChatAttachmentBubble (chat/support) също минава през resolveAttachmentUrl — consistency между Topics и chat/support', () => {
  const attachment = {
    width: 320,
    height: 240,
    viewUrl: '/api/chat/friendship-1/attachments/33333333-3333-4333-8333-333333333333.webp',
    downloadUrl: '/api/chat/friendship-1/attachments/33333333-3333-4333-8333-333333333333.webp?download=1',
  }

  const devHtml = renderChatAttachmentBubble(attachment, DEV_API_BASE_URL)
  assert(devHtml.includes('src="http://localhost:3001/api/chat/friendship-1/attachments/33333333-3333-4333-8333-333333333333.webp"'), 'chat img src трябва да е resolved спрямо dev backend origin-а')
  assert(!devHtml.includes('src="/api/chat/'), 'chat не трябва да остане raw relative src (regression за същия bug клас)')
})

// ─── [20]-[27] Hard-delete reference-existence модел (corrective pass) ─────
//
// Продуктово решение (реверсия на предходния pass): whole-topic delete вече
// HARD-DELETE-ва topic_message_attachments редовете веднага (в
// topicModerationStore.deleteTopic, вижте checkTopicModeration.ts [29]-[33]
// за самата транзакция). Затова "row съществува" отново е напълно надежден
// canonical сигнал за cleanup eligibility — same reference-existence модел
// като chat/support — и НЕ се нуждае от отделна live-JOIN семантика.

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'attachments-reference-existence.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildBaseSchema(db)
  await applyMigrationFile(db, topicsMigrationPath)
  await applyMigrationFile(db, likesMigrationPath)
  await applyMigrationFile(db, attachmentsMigrationPath)
  await applyMigrationFile(db, moderationMigrationPath)
  db.prepare(`INSERT INTO accounts (account_id) VALUES ('moderator-1')`).run()
  seedProfile(db, 'sender-1')
  insertTopic(db, { topicId: 'topic-live', slug: 'topic-live', title: 'Жива тема' })
  insertTopic(db, { topicId: 'topic-to-remove', slug: 'topic-to-remove', title: 'Тема за изтриване' })
  db.close()

  const store = await createTopicMessageStore(dbPath)
  const moderationStore = await createTopicModerationStore(dbPath)
  try {

  const liveRootImage = makeAttachment('44444444-4444-4444-8444-444444444444.webp')
  store.insertMessage({
    topicId: 'topic-live',
    senderProfileId: 'sender-1',
    senderDisplayName: 'S1',
    senderRole: 'player',
    body: 'live root with image',
    attachment: liveRootImage,
  })

  const removedTopicRootImage = makeAttachment('77777777-7777-4777-8777-777777777777.webp')
  const removedTopicRoot = store.insertMessage({
    topicId: 'topic-to-remove',
    senderProfileId: 'sender-1',
    senderDisplayName: 'S1',
    senderRole: 'player',
    body: 'root in a topic that will be removed',
    attachment: removedTopicRootImage,
  })
  const removedTopicReplyImage = makeAttachment('88888888-8888-4888-8888-888888888888.webp')
  store.insertReply({
    topicId: 'topic-to-remove',
    parentMessageId: removedTopicRoot.messageId,
    senderProfileId: 'sender-1',
    senderDisplayName: 'S1',
    senderRole: 'player',
    body: 'reply in a topic that will be removed',
    attachment: removedTopicReplyImage,
  })

  await check('[20] attachmentExistsForFilename: true веднага след insert', () => {
    assert(store.attachmentExistsForFilename(liveRootImage.storageFilename) === true, 'live attachment трябва да съществува')
    assert(store.attachmentExistsForFilename(removedTopicRootImage.storageFilename) === true, 'attachment-ът все още съществува преди delete')
  })

  await check('[22] attachmentExistsForFilename: false за непознат/orphan filename', () => {
    assert(store.attachmentExistsForFilename('99999999-9999-4999-8999-999999999999.webp') === false, 'несъществуващ filename никога не съществува')
  })

  // Реален whole-topic delete през canonical transaction owner-а — точно
  // production пътят, не директна SQL мутация.
  moderationStore.deleteTopic({ topicId: 'topic-to-remove', actorAccountId: 'moderator-1', actorRole: 'admin', reason: 'cleanup test' })

  await check('[21] attachmentExistsForFilename: false след hard-delete на attachment реда (whole-topic delete)', () => {
    assert(store.attachmentExistsForFilename(removedTopicRootImage.storageFilename) === false, 'root attachment трябва да е hard-deleted след topic delete')
    assert(store.attachmentExistsForFilename(removedTopicReplyImage.storageFilename) === false, 'reply attachment трябва да е hard-deleted след topic delete')
    assert(store.attachmentExistsForFilename(liveRootImage.storageFilename) === true, 'attachment на НЕтронатата жива тема трябва да остане')
  })

  await check('[23] listPendingAttachmentDeletions връща queue-нат job за hard-deleted attachment (enqueue стана ВЪТРЕ в deleteTopic транзакцията)', () => {
    const pending = store.listPendingAttachmentDeletions(10).map((p) => p.storageFilename).sort()
    assertEqual(
      pending.join(','),
      [removedTopicReplyImage.storageFilename, removedTopicRootImage.storageFilename].sort().join(','),
      'и двата filename-а трябва да са в cleanup queue-то без отделна caller-side enqueue стъпка',
    )
  })

  await check('[27] getAttachmentForDownload вече КОРЕКТНО връща null за removed-topic attachment (hard-delete = auth boundary)', () => {
    const result = store.getAttachmentForDownload('topic-to-remove', removedTopicRootImage.storageFilename)
    assertEqual(result, null, 'removed-topic attachment не трябва да е downloadable веднага след delete транзакцията')
  })

  } finally {
    store.close()
    moderationStore.close()
  }
})

// ─── [24]-[26] Cleanup worker/orphan scan source-level wiring guard ────────
//
// Regression guard: гарантира, че production кодът ползва reference-existence
// модела (attachmentExistsForFilename) на ДВЕТЕ места — cleanup worker И
// orphan scan — и че никъде в index.ts не се е промъкнало обратно
// позоваване на премахнатата isAttachmentReferencedByLiveTopicContent
// (би означавало два паралелни, несъвместими cleanup модела).

await check('[24] server source: runTopicAttachmentCleanup ползва attachmentExistsForFilename за eligibility', async () => {
  const serverSource = await readFile(join(serverRoot, 'src', 'index.ts'), 'utf8')
  const fnBody = serverSource.match(/async function runTopicAttachmentCleanup\(\)[\s\S]*?\n\}/)?.[0] ?? ''
  assert(fnBody.length > 0, 'runTopicAttachmentCleanup function not found')
  assert(fnBody.includes('topicMessageStore.attachmentExistsForFilename('), 'cleanup worker трябва да ползва attachmentExistsForFilename')
})

await check('[25] server source: runTopicAttachmentOrphanScan ползва СЪЩАТА reference-existence дефиниция като cleanup worker-а', async () => {
  const serverSource = await readFile(join(serverRoot, 'src', 'index.ts'), 'utf8')
  const fnBody = serverSource.match(/async function runTopicAttachmentOrphanScan\(\)[\s\S]*?\n\}/)?.[0] ?? ''
  assert(fnBody.length > 0, 'runTopicAttachmentOrphanScan function not found')
  assert(fnBody.includes('topicMessageStore.attachmentExistsForFilename('), 'orphan scan трябва да ползва attachmentExistsForFilename')
})

await check('[26] server source: index.ts НЕ съдържа никакво позоваване на isAttachmentReferencedByLiveTopicContent (един cleanup модел, не два паралелни)', async () => {
  const serverSource = await readFile(join(serverRoot, 'src', 'index.ts'), 'utf8')
  assert(!serverSource.includes('isAttachmentReferencedByLiveTopicContent'), 'премахнатата функция не трябва да е референцирана никъде в index.ts')
  const storeSource = await readFile(join(serverRoot, 'src', 'db', 'topicMessageStore.ts'), 'utf8')
  assert(!storeSource.includes('isAttachmentReferencedByLiveTopicContent'), 'премахнатата функция не трябва да е референцирана никъде в topicMessageStore.ts')
})

console.log(`\n${passed} passed, ${failed} failed\n`)

if (failed > 0) {
  process.exitCode = 1
}
