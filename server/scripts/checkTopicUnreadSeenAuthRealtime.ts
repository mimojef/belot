import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
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

// CRLF fix: server/src е git-checked-out с CRLF line endings на тази
// платформа — regex-ите по-долу (/\n\}\n/ и т.н.) никога не match-ваха
// срещу суров CRLF текст (\r\n}\r\n съдържа \n}\n само за trailing частта,
// не при exact anchor match без \r толеранс). Тестовият parser логика, не
// production поведение — нормализираме веднъж тук при четене, source
// файловете остават непипнати.
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

const serverRoot = resolve(process.cwd())
const indexSrc = normalizeLineEndings(await readFile(resolve(serverRoot, 'src/index.ts'), 'utf8'))
const protocolSrc = normalizeLineEndings(await readFile(resolve(serverRoot, 'src/protocol/messageTypes.ts'), 'utf8'))
const migrationSrc = normalizeLineEndings(await readFile(resolve(serverRoot, 'database/migrations/20260812_004_create_topic_read_state.sql'), 'utf8'))
const threadMigrationSrc = normalizeLineEndings(await readFile(
  resolve(serverRoot, 'database/migrations/20260813_001_create_topic_thread_read_state.sql'),
  'utf8',
))

console.log('\n=== Topic Unread / Seen (auth + realtime contract) ===\n')

await check('[1] topic-level and thread-level read-state migrations own their schemas', () => {
  assert(migrationSrc.includes('CREATE TABLE IF NOT EXISTS topic_read_state'), 'topic_read_state table missing')
  assert(migrationSrc.includes('CREATE TABLE IF NOT EXISTS topic_sender_seen_state'), 'topic_sender_seen_state table missing')
  assert(migrationSrc.includes('idx_topic_messages_sender_topic_seq'), 'sender/topic/seq index missing')
  assert(threadMigrationSrc.includes('CREATE TABLE IF NOT EXISTS topic_thread_read_state'), 'topic_thread_read_state table missing')
  assert(threadMigrationSrc.includes('PRIMARY KEY (profile_id, root_message_id)'), 'thread read-state primary key missing')
  assert(threadMigrationSrc.includes('idx_topic_messages_topic_parent_seq'), 'topic/parent/seq index missing')
})

await check('[2] seen HTTP route uses registered session auth and rejects temporary profiles', () => {
  const handler = indexSrc.match(/async function handleTopicSeenRequest[\s\S]*?\n}\n/)?.[0] ?? ''
  assert(handler.includes('requireRegisteredProfileSession'), 'seen handler must require registered session')
  assert(handler.includes('playerProgressStore.isTemporaryProfile'), 'seen handler must check temporary profile state')
  assert(handler.includes('markTopicSeenToLatestSeq'), 'seen handler must mark latest seq')
  assert(indexSrc.includes('broadcastTopicSeenUpdatedToProfile(auth.profileId, topicId, result.state.lastSeenSeq)'), 'seen handler must broadcast topic_seen_updated')
  assert(indexSrc.includes("type: 'topic_seen_updated'"), 'topic_seen_updated payload missing')
  assert(indexSrc.includes("const match = /^\\/api\\/topics\\/([^/]+)\\/seen$/.exec(pathname)"), 'POST /api/topics/:topicId/seen matcher missing')
  assert(indexSrc.includes('handleTopicSeenRequest(req, res, requestUrl.pathname)'), 'POST /api/topics/:topicId/seen dispatch missing')
})

await check('[3] topic list initializes read state, returns unread counts, and does NOT filter by block relationship', () => {
  const helper = indexSrc.match(/function topicsWithUnreadCountsForProfile[\s\S]*?\n}\n/)?.[0] ?? ''
  assert(helper.includes('ensureReadStateForTopics'), 'topic list must initialize read state')
  assert(helper.includes('getUnreadCountsByTopicIds'), 'topic list must fetch unread counts')
  // VISIBILITY fix (диагностичен брифа: "block != hide public Topics content") —
  // Topics unread вече не изключва блокирани sender-и.
  assert(!helper.includes('getLobbyChatBlockedSet'), 'topic list unread must NOT filter by block relationship')
})

await check('[4] realtime messages are in the shared protocol union', () => {
  assert(protocolSrc.includes("type: 'topic_unread_count_changed'"), 'topic_unread_count_changed type missing')
  assert(protocolSrc.includes("type: 'topic_seen_updated'"), 'topic_seen_updated type missing')
  assert(protocolSrc.includes("type: 'topic_thread_unread_count_changed'"), 'topic_thread_unread_count_changed type missing')
  assert(protocolSrc.includes("type: 'topic_thread_seen_updated'"), 'topic_thread_seen_updated type missing')
  assert(protocolSrc.includes('TopicUnreadCountChangedMessage'), 'TopicUnreadCountChangedMessage union member missing')
  assert(protocolSrc.includes('TopicSeenUpdatedMessage'), 'TopicSeenUpdatedMessage union member missing')
  assert(protocolSrc.includes('TopicThreadUnreadCountChangedMessage'), 'TopicThreadUnreadCountChangedMessage union member missing')
  assert(protocolSrc.includes('TopicThreadSeenUpdatedMessage'), 'TopicThreadSeenUpdatedMessage union member missing')
})

// Обновено (perf audit batch follow-up): per-thread unread lookup-ът вече
// не е единичен getTopicThreadUnreadCountForProfile(profileId, rootMessageId)
// call — заменен с batch getTopicThreadUnreadCountsForProfiles(rootMessageId,
// uniqueProfileIds, ...), извикан ЕДИН път извън for-циклите за целия
// directory-subscriber profile set (фиксиран малък брой SQL statements,
// не loop по profileId). Виж checkTopicMessagesRealtime.ts [E6] за
// дълбочинна structural проверка на batch-ването; тук проверяваме само
// продуктовия contract (кои message types/branch-ове съществуват).
await check('[5] active legacy topics mark seen while General threads keep per-thread unread', () => {
  const reconcile = indexSrc.match(/function reconcileTopicUnreadForDirectorySubscribers[\s\S]*?\n}\n/)?.[0] ?? ''
  assert(reconcile.includes('topicsDirectorySubscriberConnectionIds'), 'directory subscriber loop missing')
  assert(reconcile.includes('activeTopicId === topicId'), 'active topic branch missing')
  assert(reconcile.includes('activeTopicId === topicId && !topic?.isGeneral'), 'General must not use topic-level active seen')
  assert(reconcile.includes('markTopicSeenForActiveProfile'), 'active topic must mark seen')
  assert(reconcile.includes("type: 'topic_unread_count_changed'"), 'inactive subscribers must receive unread count')
  assert(reconcile.includes("type: 'topic_thread_unread_count_changed'"), 'General thread unread event missing')
  assert(reconcile.includes('getTopicThreadUnreadCountsForProfiles(rootMessageId, uniqueProfileIds'), 'batch per-thread unread lookup missing')
})

await check('[6] root/reply create, delete, and subscribe flows reconcile unread state; unblock no longer resets sender-seen boundary', () => {
  assert(
    indexSrc.includes('reconcileTopicUnreadForDirectorySubscribers(topicId, snapshot.senderProfileId, snapshot.messageId)'),
    'root message unread reconcile missing',
  )
  assert(
    indexSrc.includes('reconcileTopicUnreadForDirectorySubscribers(topicId, snapshot.senderProfileId, snapshot.parentMessageId)'),
    'reply unread reconcile missing',
  )
  assert(
    indexSrc.includes('reconcileTopicUnreadForDirectorySubscribers(topicId, undefined, parentMessageId ?? messageId)'),
    'delete unread reconcile missing',
  )
  assert(indexSrc.includes('if (!topic.isGeneral)'), 'subscribe_topic_messages must guard topic-level seen for General')
  assert(indexSrc.includes('markTopicSeenForActiveProfile(profileId, message.topicId)'), 'subscribe_topic_messages mark-seen missing')
  // VISIBILITY fix: markSenderSeenThroughCurrent беше unblock-time компенсация
  // за стария exclusion модел (за да не "наводни" unread-а при unblock).
  // Block вече изобщо не изключва Topics unread, значи компенсацията вече
  // би прикривала реално непрочетени съобщения — премахната нарочно.
  const blockToggleHandler = indexSrc.match(/const result = blockStore\.toggleBlock\(myProfileId, targetProfileId\)[\s\S]{0,400}/)?.[0] ?? ''
  assert(blockToggleHandler.length > 0, 'block toggle handler не е намерен')
  assert(!blockToggleHandler.includes('markSenderSeenThroughCurrent'), 'block toggle handler-ът вече НЕ трябва да reset-ва sender-seen boundary при unblock')
  assert(!blockToggleHandler.includes('broadcastTopicUnreadCountsToProfile'), 'block toggle handler-ът вече НЕ трябва да force-ва unread rebroadcast при unblock')
})

if (failed > 0) {
  console.error(`\nTopic unread/seen auth+realtime checks failed: ${failed} failed, ${passed} passed.`)
  process.exit(1)
}

console.log(`\nTopic unread/seen auth+realtime checks passed: ${passed} checks.\n`)
