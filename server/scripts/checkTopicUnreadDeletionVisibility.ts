/**
 * checkTopicUnreadDeletionVisibility.ts
 *
 * Фантомен unread в „Теми“ при самоизтриване (механизъм A): скрит профил
 * (активна заявка за изтриване) маха не само собствените си съобщения, а и
 * чуждите отговори под свой root — огледално на историята, която не показва
 * нишката. Изолирана temp база, без сървър.
 *
 * [H] Скрит root с чужди отговори — „Общи“, per-thread, Лафче, друга тема.
 * [C] Отмяна на заявката — бройките се връщат точно, read state непокътнат.
 * [R] Прочетени и непрочетени отговори в скрита нишка.
 * [P] Single == batch за всеки viewer, със и без изключения.
 * [D] Обикновено и модераторско изтриване — непроменено поведение.
 * [N] NULL семантика — root съобщения и осиротял отговор при непразен списък.
 * [T] 72-часово почистване — заявката не спира и не удължава срока; отмяна
 *     преди и след изтичането; без фантомни непрочетени.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTopicReadStateStore, type TopicReadStateStore } from '../src/db/topicReadStateStore.js'
import { createTopicMessageStore, type TopicMessageStore } from '../src/db/topicMessageStore.js'
import { createTopicHardDeleteService, type TopicHardDeleteService } from '../src/db/topicHardDeleteService.js'

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
const OTHER = 'topic-other'
const HIDDEN = 'hidden-author'
const VIEWERS = ['viewer-fresh', 'viewer-read-all', 'viewer-read-part']

let passed = 0
let failed = 0

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
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

const dir = await mkdtemp(join(tmpdir(), 'belot-topic-unread-deletion-visibility-'))
const dbPath = join(dir, 'topics.sqlite')
const raw = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
raw.exec('PRAGMA journal_mode = WAL;')
raw.exec(`CREATE TABLE profiles (profile_id TEXT PRIMARY KEY, display_name TEXT NOT NULL DEFAULT '', is_temporary INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`)
raw.exec(`CREATE TABLE accounts (account_id TEXT PRIMARY KEY);`)
for (const migrationPath of migrationPaths) raw.exec(await readFile(migrationPath, 'utf8'))
for (const profileId of [HIDDEN, 'alice', 'bob', ...VIEWERS]) {
  raw.prepare(`INSERT INTO profiles (profile_id, display_name) VALUES (?, ?)`).run(profileId, profileId)
}
raw.prepare(`INSERT INTO topics (topic_id, slug, title, is_general, created_by_profile_id, status, sort_order) VALUES (?, 'other', 'Друга', 0, NULL, 'active', 50)`).run(OTHER)

const readState: TopicReadStateStore = await createTopicReadStateStore(dbPath)
const messages: TopicMessageStore = await createTopicMessageStore(dbPath)
const hardDelete: TopicHardDeleteService = await createTopicHardDeleteService(dbPath)

for (const viewer of VIEWERS) readState.ensureReadStateForTopics(viewer, [GENERAL, LAFCHE, OTHER])

const post = (topicId: string, sender: string): string =>
  messages.insertMessage({ topicId, senderProfileId: sender, senderDisplayName: sender, senderRole: 'player', body: 'x' }).messageId
const reply = (topicId: string, sender: string, parentMessageId: string): string => {
  const result = messages.insertReply({ topicId, parentMessageId, senderProfileId: sender, senderDisplayName: sender, senderRole: 'player', body: 'x' })
  if (!result.ok) throw new Error('reply failed')
  return result.message.messageId
}
const seqOf = (messageId: string) => (raw.prepare('SELECT seq FROM topic_messages WHERE message_id = ?').get(messageId) as { seq: number }).seq

// „Общи“: видим root на alice с отговор от bob и от скрития; скрит root с два чужди отговора.
const visibleRoot = post(GENERAL, 'alice')
const bobUnderVisible = reply(GENERAL, 'bob', visibleRoot)
const hiddenUnderVisible = reply(GENERAL, HIDDEN, visibleRoot)
const hiddenRoot = post(GENERAL, HIDDEN)
const aliceUnderHidden = reply(GENERAL, 'alice', hiddenRoot)
const bobUnderHidden = reply(GENERAL, 'bob', hiddenRoot)
// Лафче и друга тема: скрит root + чужд отговор + нормален пост.
const lafcheHiddenRoot = post(LAFCHE, HIDDEN)
reply(LAFCHE, 'alice', lafcheHiddenRoot)
post(LAFCHE, 'bob')
const otherHiddenRoot = post(OTHER, HIDDEN)
reply(OTHER, 'bob', otherHiddenRoot)
post(OTHER, 'alice')

// viewer-read-all е прочел цялата скрита нишка; viewer-read-part — до първия отговор.
readState.markThreadSeenToLatestSeq('viewer-read-all', hiddenRoot)
raw.prepare(`INSERT INTO topic_thread_read_state (profile_id, root_message_id, last_seen_seq) VALUES ('viewer-read-part', ?, ?)`)
  .run(hiddenRoot, seqOf(aliceUnderHidden))

const none: string[] = []
const hiddenList = [HIDDEN]
const byViewer = (list: string[]) => new Map(VIEWERS.map((v) => [v, new Set(list)] as const))

function counts(viewer: string, excluded: string[]) {
  const ex = byViewer(excluded)
  return {
    generalSingle: readState.getGeneralThreadUnreadTotal(viewer, GENERAL, excluded),
    generalBatch: readState.getGeneralThreadUnreadTotalsForProfiles(GENERAL, VIEWERS, ex).get(viewer),
    hiddenThreadSingle: readState.getUnreadCountsByRootMessageIds(viewer, [hiddenRoot], excluded).get(hiddenRoot),
    hiddenThreadBatch: readState.getThreadUnreadCountsForProfiles(hiddenRoot, VIEWERS, ex).get(viewer),
    visibleThreadSingle: readState.getUnreadCountsByRootMessageIds(viewer, [visibleRoot], excluded).get(visibleRoot),
    visibleThreadBatch: readState.getThreadUnreadCountsForProfiles(visibleRoot, VIEWERS, ex).get(viewer),
    lafcheSingle: readState.getUnreadCountsByTopicIds(viewer, [LAFCHE], excluded).get(LAFCHE),
    lafcheBatch: readState.getUnreadCountForTopicForProfiles(LAFCHE, VIEWERS, ex).get(viewer),
    otherSingle: readState.getUnreadCountsByTopicIds(viewer, [OTHER], excluded).get(OTHER),
    otherBatch: readState.getUnreadCountForTopicForProfiles(OTHER, VIEWERS, ex).get(viewer),
  }
}

const readStateSnapshot = () => JSON.stringify({
  topic: raw.prepare('SELECT * FROM topic_read_state ORDER BY profile_id, topic_id').all(),
  thread: raw.prepare('SELECT * FROM topic_thread_read_state ORDER BY profile_id, root_message_id').all(),
  sender: raw.prepare('SELECT * FROM topic_sender_seen_state ORDER BY profile_id, topic_id, sender_profile_id').all(),
})

try {
  console.log('\n[H] Скрит root с чужди отговори')
  const visibleBefore = counts('viewer-fresh', none)
  const beforeByViewer = new Map(VIEWERS.map((viewer) => [viewer, JSON.stringify(counts(viewer, none))] as const))
  const stateBeforeHide = readStateSnapshot()

  await check('[H1] Без изключения (профилът е видим): скритата нишка се брои — root + 2 отговора', () => {
    assertEqual(visibleBefore.hiddenThreadSingle, 3, 'thread single')
    assertEqual(visibleBefore.generalSingle, 6, '„Общи“: visible root + 2 отговора + hidden root + 2 отговора')
  })

  await check('[H2] Скрит автор: „Общи“ брои само видимата нишка без отговора на скрития (alice root + bob)', () => {
    const c = counts('viewer-fresh', hiddenList)
    assertEqual(c.generalSingle, 2, '„Общи“ single')
    assertEqual(c.generalBatch, 2, '„Общи“ batch')
  })

  await check('[H3] Per-thread: скритата нишка = 0 (single и batch); видимата = 2', () => {
    const c = counts('viewer-fresh', hiddenList)
    assertEqual(c.hiddenThreadSingle, 0, 'hidden single')
    assertEqual(c.hiddenThreadBatch, 0, 'hidden batch')
    assertEqual(c.visibleThreadSingle, 2, 'visible single')
    assertEqual(c.visibleThreadBatch, 2, 'visible batch')
  })

  await check('[H4] Лафче и друга тема: чуждият отговор под скрит root не се брои; нормалният пост се брои', () => {
    const c = counts('viewer-fresh', hiddenList)
    assertEqual(c.lafcheSingle, 1, 'Лафче single')
    assertEqual(c.lafcheBatch, 1, 'Лафче batch')
    assertEqual(c.otherSingle, 1, 'друга single')
    assertEqual(c.otherBatch, 1, 'друга batch')
    const before = counts('viewer-fresh', none)
    assertEqual(before.lafcheSingle, 3, 'Лафче без изключения')
    assertEqual(before.otherSingle, 3, 'друга без изключения')
  })

  await check('[H5] Изчисляването не пише read state', () => {
    counts('viewer-fresh', hiddenList)
    assertEqual(readStateSnapshot(), stateBeforeHide, 'read state')
  })

  console.log('\n[R] Прочетени и непрочетени отговори')

  await check('[R1] Прочел цялата нишка: 0 при скрит и при видим автор', () => {
    assertEqual(counts('viewer-read-all', hiddenList).hiddenThreadSingle, 0, 'скрит')
    assertEqual(counts('viewer-read-all', none).hiddenThreadSingle, 0, 'видим')
  })

  await check('[R2] Прочел до първия отговор: скрит -> 0; видим -> 1 (само bob, alice остава прочетен)', () => {
    assertEqual(counts('viewer-read-part', hiddenList).hiddenThreadSingle, 0, 'скрит')
    const visible = counts('viewer-read-part', none)
    assertEqual(visible.hiddenThreadSingle, 1, 'видим single')
    assertEqual(visible.hiddenThreadBatch, 1, 'видим batch')
    assertEqual(seqOf(bobUnderHidden) > seqOf(aliceUnderHidden), true, 'ред на отговорите')
  })

  console.log('\n[C] Отмяна на заявката')

  await check('[C1] След отмяна (празен списък) бройките са точно предишните за всеки viewer', () => {
    for (const viewer of VIEWERS) {
      assertEqual(JSON.stringify(counts(viewer, none)), beforeByViewer.get(viewer), viewer)
    }
  })

  await check('[C2] Read state е непокътнат след скриване и отмяна', () => {
    assertEqual(readStateSnapshot(), stateBeforeHide, 'read state')
  })

  console.log('\n[P] Single == batch')

  await check('[P1] За всеки viewer и всеки списък (празен / скрит / скрит+alice) single == batch за всички броячи', () => {
    for (const excluded of [none, hiddenList, [HIDDEN, 'alice']]) {
      for (const viewer of VIEWERS) {
        const c = counts(viewer, excluded)
        const label = `${viewer} [${excluded.join(',')}]`
        assertEqual(c.generalBatch, c.generalSingle, `${label} „Общи“`)
        assertEqual(c.hiddenThreadBatch, c.hiddenThreadSingle, `${label} скрита нишка`)
        assertEqual(c.visibleThreadBatch, c.visibleThreadSingle, `${label} видима нишка`)
        assertEqual(c.lafcheBatch, c.lafcheSingle, `${label} Лафче`)
        assertEqual(c.otherBatch, c.otherSingle, `${label} друга`)
      }
    }
  })

  console.log('\n[N] NULL семантика')

  await check('[N1] Root съобщения (без родител) се броят при непразен списък — IS NULL guard', () => {
    const lonelyRoot = post(GENERAL, 'bob')
    const c = counts('viewer-fresh', hiddenList)
    assertEqual(c.generalSingle, 3, '„Общи“ +1 root')
    assertEqual(c.generalBatch, 3, '„Общи“ batch')
    messages.deleteOwnMessage({ topicId: GENERAL, messageId: lonelyRoot, ownerProfileId: 'bob' })
  })

  await check('[N2] Осиротял отговор (липсващ родител) — поведението е непроменено: брои се (non-general topic)', () => {
    raw.exec('PRAGMA foreign_keys = OFF;')
    raw.prepare(`INSERT INTO topic_messages (message_id, topic_id, parent_message_id, sender_profile_id, sender_display_name, sender_role, body) VALUES ('orphan-reply', ?, 'missing-root', 'bob', 'bob', 'player', 'x')`).run(OTHER)
    raw.exec('PRAGMA foreign_keys = ON;')
    const c = counts('viewer-fresh', hiddenList)
    assertEqual(c.otherSingle, 2, 'single')
    assertEqual(c.otherBatch, 2, 'batch')
    raw.prepare(`DELETE FROM topic_messages WHERE message_id = 'orphan-reply'`).run()
  })

  console.log('\n[D] Обикновено и модераторско изтриване')

  await check('[D1] Авторът изтрива свой отговор под видим root -> -1 (single и batch)', () => {
    messages.deleteOwnMessage({ topicId: GENERAL, messageId: bobUnderVisible, ownerProfileId: 'bob' })
    const c = counts('viewer-fresh', hiddenList)
    assertEqual(c.generalSingle, 1, 'single')
    assertEqual(c.generalBatch, 1, 'batch')
    assertEqual(c.visibleThreadSingle, 1, 'thread single')
  })

  await check('[D2] Модератор изтрива видимия root (каскада) -> 0 за „Общи“ при скрит автор', () => {
    messages.deleteMessage({ topicId: GENERAL, messageId: visibleRoot, actorAccountId: null, actorRole: 'admin' })
    const c = counts('viewer-fresh', hiddenList)
    assertEqual(c.generalSingle, 0, 'single')
    assertEqual(c.generalBatch, 0, 'batch')
  })

  await check('[D3] Модератор изтрива скрития root -> скритата нишка изчезва и след отмяна (0 за всички)', () => {
    messages.deleteMessage({ topicId: GENERAL, messageId: hiddenRoot, actorAccountId: null, actorRole: 'admin' })
    for (const viewer of VIEWERS) {
      const c = counts(viewer, none)
      assertEqual(c.generalSingle, 0, `${viewer} single`)
      assertEqual(c.generalBatch, 0, `${viewer} batch`)
      assertEqual(c.hiddenThreadSingle, 0, `${viewer} thread`)
    }
    void hiddenUnderVisible
  })

  console.log('\n[T] 72-часово почистване (index.ts runTopicInactivityCleanup: cutoff = сега - 72 ч)')

  const HOUR_MS = 60 * 60 * 1000
  const cutoffAt = (hoursFromNow: number) => new Date(Date.now() + hoursFromNow * HOUR_MS - 72 * HOUR_MS)
  const backdate = (messageIds: string[], hoursAgo: number) => {
    for (const id of messageIds) {
      raw.prepare(`UPDATE topic_messages SET created_at = datetime('now', ?) WHERE message_id = ?`).run(`-${hoursAgo} hours`, id)
    }
  }
  const isRootCandidate = (rootId: string, cutoff: Date) =>
    hardDelete.findInactiveRootCandidates(GENERAL, cutoff, 500).some((c) => c.rootMessageId === rootId)
  const isListed = (rootId: string, excluded: string[]) =>
    messages.getRecentMessages(GENERAL, 500, excluded).messages.some((m) => m.messageId === rootId)
  const rowCount = (sql: string, ...params: string[]) => (raw.prepare(sql).get(...params) as { c: number }).c
  const generalTotals = (excluded: string[]) => VIEWERS.map((viewer) => {
    const single = readState.getGeneralThreadUnreadTotal(viewer, GENERAL, excluded)
    const batch = readState.getGeneralThreadUnreadTotalsForProfiles(GENERAL, VIEWERS, byViewer(excluded)).get(viewer)
    assertEqual(batch, single, `${viewer} single == batch`)
    return single
  })

  // Изтекла скрита нишка: последна активност преди 80 ч.
  const expiredRoot = post(GENERAL, HIDDEN)
  const expiredReply = reply(GENERAL, 'alice', expiredRoot)
  backdate([expiredRoot, expiredReply], 80)
  readState.markThreadSeenToLatestSeq('viewer-read-all', expiredRoot)
  const topicReadStateBeforeCleanup = JSON.stringify(raw.prepare('SELECT * FROM topic_read_state ORDER BY profile_id, topic_id').all())

  await check('[T1] Скрита нишка с активност преди 80 ч е кандидат въпреки активната заявка; почистването я изтрива с отговорите, агрегата и thread read state', () => {
    assertEqual(isListed(expiredRoot, hiddenList), false, 'скрита в историята')
    assertEqual(isRootCandidate(expiredRoot, cutoffAt(0)), true, 'кандидат')
    const result = hardDelete.hardDeleteRoot({ topicId: GENERAL, rootMessageId: expiredRoot, inactivityCutoff: cutoffAt(0) })
    assertEqual(result.ok, true, 'hardDeleteRoot')
    assertEqual(rowCount('SELECT COUNT(*) AS c FROM topic_messages WHERE message_id IN (?, ?)', expiredRoot, expiredReply), 0, 'root + отговор')
    assertEqual(rowCount('SELECT COUNT(*) AS c FROM topic_root_latest_seq WHERE root_message_id = ?', expiredRoot), 0, 'агрегат')
    assertEqual(rowCount('SELECT COUNT(*) AS c FROM topic_thread_read_state WHERE root_message_id = ?', expiredRoot), 0, 'thread read state')
    assertEqual(JSON.stringify(raw.prepare('SELECT * FROM topic_read_state ORDER BY profile_id, topic_id').all()), topicReadStateBeforeCleanup, 'topic read state е непокътнат')
  })

  await check('[T2] Отмяна СЛЕД изтичането (напр. на 10-ия ден): нишката НЕ се възстановява; без фантомни непрочетени', () => {
    assertEqual(isListed(expiredRoot, none), false, 'не е в историята')
    assertEqual(JSON.stringify(generalTotals(none)), JSON.stringify([0, 0, 0]), 'бройки след отмяна')
    assertEqual(JSON.stringify(generalTotals(hiddenList)), JSON.stringify([0, 0, 0]), 'бройки докато е скрит')
  })

  // Неизтекла скрита нишка: последна активност преди 50 ч.
  const freshRoot = post(GENERAL, HIDDEN)
  const freshReply = reply(GENERAL, 'bob', freshRoot)
  backdate([freshRoot, freshReply], 50)
  const lastActivityOf = (rootId: string) =>
    (raw.prepare('SELECT m.created_at AS at FROM topic_root_latest_seq trl JOIN topic_messages m ON m.seq = trl.latest_seq WHERE trl.root_message_id = ?').get(rootId) as { at: string }).at
  const freshActivityBefore = lastActivityOf(freshRoot)
  const freshVisibleTotals = JSON.stringify(generalTotals(none))
  const stateBeforeFresh = readStateSnapshot()

  await check('[T3] Скрита нишка с активност преди 50 ч: още не е кандидат; докато е скрита не се брои', () => {
    assertEqual(isRootCandidate(freshRoot, cutoffAt(0)), false, 'кандидат преди срока')
    assertEqual(JSON.stringify(generalTotals(hiddenList)), JSON.stringify([0, 0, 0]), 'бройки докато е скрит')
  })

  await check('[T4] Отмяна ПРЕДИ изтичането: нишката отново е видима, бройките са точно предишните, read state непокътнат', () => {
    assertEqual(isListed(freshRoot, none), true, 'видима в историята')
    assertEqual(JSON.stringify(generalTotals(none)), freshVisibleTotals, 'бройки')
    assertEqual(JSON.stringify(generalTotals(none)), JSON.stringify([2, 2, 2]), 'root + чужд отговор за всеки viewer')
    assertEqual(readStateSnapshot(), stateBeforeFresh, 'read state')
  })

  await check('[T5] Срокът не е удължен: последната активност е същата; 23 ч по-късно (72 ч от активността) нишката се изтрива; без фантоми', () => {
    assertEqual(lastActivityOf(freshRoot), freshActivityBefore, 'последна активност')
    assertEqual(isRootCandidate(freshRoot, cutoffAt(21)), false, '+21 ч (71 ч) — още не')
    assertEqual(isRootCandidate(freshRoot, cutoffAt(23)), true, '+23 ч (73 ч) — кандидат')
    const result = hardDelete.hardDeleteRoot({ topicId: GENERAL, rootMessageId: freshRoot, inactivityCutoff: cutoffAt(23) })
    assertEqual(result.ok, true, 'hardDeleteRoot')
    assertEqual(JSON.stringify(generalTotals(none)), JSON.stringify([0, 0, 0]), 'бройки след почистването')
  })

  await check('[T6] Цяла тема на скрит създател (Б1 видимост): почистването я изтрива по нормалните правила, вкл. topic read state; бройки 0', () => {
    const hiddenTopic = 'topic-hidden-creator'
    raw.prepare(`INSERT INTO topics (topic_id, slug, title, is_general, created_by_profile_id, created_by_role, status, sort_order) VALUES (?, 'hidden-creator', 'Тема на скрития', 0, ?, 'player', 'active', 60)`).run(hiddenTopic, HIDDEN)
    for (const viewer of VIEWERS) readState.ensureReadStateForTopics(viewer, [hiddenTopic])
    const topicRoot = post(hiddenTopic, HIDDEN)
    const topicReply = reply(hiddenTopic, 'alice', topicRoot)
    backdate([topicRoot, topicReply], 80)
    assertEqual(hardDelete.findInactivityCandidates(cutoffAt(0), 500).some((c) => c.topicId === hiddenTopic), true, 'кандидат')
    const result = hardDelete.hardDeleteTopic({ topicId: hiddenTopic, reason: 'inactivity_expired', inactivityCutoff: cutoffAt(0) })
    assertEqual(result.ok, true, 'hardDeleteTopic')
    assertEqual(rowCount('SELECT COUNT(*) AS c FROM topic_read_state WHERE topic_id = ?', hiddenTopic), 0, 'topic read state')
    for (const viewer of VIEWERS) {
      assertEqual(readState.getUnreadCountsByTopicIds(viewer, [hiddenTopic], none).get(hiddenTopic), 0, `${viewer} single`)
      assertEqual(readState.getUnreadCountForTopicForProfiles(hiddenTopic, VIEWERS, byViewer(none)).get(viewer), 0, `${viewer} batch`)
    }
  })

  console.log('\n[V] Нишки за изчезване/връщане на отворените екрани (listLiveRootsTouchedBySender / getVisibleRootMessagesByIds)')

  const ownRoot = post(GENERAL, HIDDEN)
  const replyUnderOwn = reply(GENERAL, 'alice', ownRoot)
  const foreignRoot = post(GENERAL, 'bob')
  const hiddenReplyUnderForeign = reply(GENERAL, HIDDEN, foreignRoot)
  const deletedReplyRoot = post(GENERAL, 'alice')
  const deletedHiddenReply = reply(GENERAL, HIDDEN, deletedReplyRoot)
  messages.deleteOwnMessage({ topicId: GENERAL, messageId: deletedHiddenReply, ownerProfileId: HIDDEN })
  post(GENERAL, 'alice') // недокоснат root
  backdate([replyUnderOwn], 1)
  backdate([ownRoot], 3)
  backdate([hiddenReplyUnderForeign], 0)

  await check('[V1] Докоснати = собствен root + чужд root с жив отговор; не и root с изтрит отговор или недокоснат root', () => {
    const touched = messages.listLiveRootsTouchedBySender(GENERAL, HIDDEN, 100)
      .map((r) => `${r.rootMessageId === ownRoot ? 'own' : r.rootMessageId === foreignRoot ? 'foreign' : 'other'}:${r.rootSenderProfileId}`)
      .sort()
    assertEqual(JSON.stringify(touched), JSON.stringify([`foreign:bob`, `own:${HIDDEN}`]), 'докоснати')
  })

  await check('[V2] Връщане: root с активност = последния видим отговор; при скрит автор — не се връща; root без отговори — created_at', () => {
    const [restored] = messages.getVisibleRootMessagesByIds(GENERAL, [ownRoot], none)
    const replyAt = (raw.prepare(`SELECT created_at AS at FROM topic_messages WHERE message_id = ?`).get(replyUnderOwn) as { at: string }).at
    assertEqual(restored?.messageId, ownRoot, 'върнат')
    assertEqual(Date.parse(restored!.lastActivityAt), Date.parse(`${replyAt.replace(' ', 'T')}Z`), 'активност = отговора')
    assertEqual(messages.getVisibleRootMessagesByIds(GENERAL, [ownRoot], hiddenList).length, 0, 'скрит автор')
    const [foreign] = messages.getVisibleRootMessagesByIds(GENERAL, [foreignRoot], hiddenList)
    assertEqual(Date.parse(foreign!.lastActivityAt), Date.parse(foreign!.createdAt), 'отговорът на скрития не мести активността')
  })

  await check('[V3] Изтрита по 72-часовото правило нишка не се връща при отмяна', () => {
    backdate([ownRoot, replyUnderOwn], 80)
    const result = hardDelete.hardDeleteRoot({ topicId: GENERAL, rootMessageId: ownRoot, inactivityCutoff: cutoffAt(0) })
    assertEqual(result.ok, true, 'hardDeleteRoot')
    assertEqual(messages.getVisibleRootMessagesByIds(GENERAL, [ownRoot], none).length, 0, 'не се връща')
    assertEqual(messages.listLiveRootsTouchedBySender(GENERAL, HIDDEN, 100).some((r) => r.rootMessageId === ownRoot), false, 'не е докосната')
  })
} finally {
  hardDelete.close()
  readState.close()
  messages.close()
  raw.close()
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
