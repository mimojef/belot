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

const serverRoot = resolve(process.cwd())
const indexSrc = await readFile(resolve(serverRoot, 'src/index.ts'), 'utf8')
const protocolSrc = await readFile(resolve(serverRoot, 'src/protocol/messageTypes.ts'), 'utf8')
const migrationSrc = await readFile(resolve(serverRoot, 'database/migrations/20260812_004_create_topic_read_state.sql'), 'utf8')

console.log('\n=== Topic Unread / Seen (auth + realtime contract) ===\n')

await check('[1] only migration 004 owns topic read-state schema', () => {
  assert(migrationSrc.includes('CREATE TABLE IF NOT EXISTS topic_read_state'), 'topic_read_state table missing')
  assert(migrationSrc.includes('CREATE TABLE IF NOT EXISTS topic_sender_seen_state'), 'topic_sender_seen_state table missing')
  assert(migrationSrc.includes('idx_topic_messages_sender_topic_seq'), 'sender/topic/seq index missing')
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

await check('[3] topic list initializes read state and returns unread counts', () => {
  const helper = indexSrc.match(/function topicsWithUnreadCountsForProfile[\s\S]*?\n}\n/)?.[0] ?? ''
  assert(helper.includes('ensureReadStateForTopics'), 'topic list must initialize read state')
  assert(helper.includes('getUnreadCountsByTopicIds'), 'topic list must fetch unread counts')
  assert(helper.includes('getLobbyChatBlockedSet'), 'topic list must respect blocked senders')
})

await check('[4] realtime messages are in the shared protocol union', () => {
  assert(protocolSrc.includes("type: 'topic_unread_count_changed'"), 'topic_unread_count_changed type missing')
  assert(protocolSrc.includes("type: 'topic_seen_updated'"), 'topic_seen_updated type missing')
  assert(protocolSrc.includes('TopicUnreadCountChangedMessage'), 'TopicUnreadCountChangedMessage union member missing')
  assert(protocolSrc.includes('TopicSeenUpdatedMessage'), 'TopicSeenUpdatedMessage union member missing')
})

await check('[5] active topic subscribers are marked seen and inactive directory subscribers get unread counts', () => {
  const reconcile = indexSrc.match(/function reconcileTopicUnreadForDirectorySubscribers[\s\S]*?\n}\n/)?.[0] ?? ''
  assert(reconcile.includes('topicsDirectorySubscriberConnectionIds'), 'directory subscriber loop missing')
  assert(reconcile.includes('activeTopicId === topicId'), 'active topic branch missing')
  assert(reconcile.includes('markTopicSeenForActiveProfile'), 'active topic must mark seen')
  assert(reconcile.includes("type: 'topic_unread_count_changed'"), 'inactive subscribers must receive unread count')
})

await check('[6] root/reply create, delete, subscribe, and unblock flows reconcile unread state', () => {
  assert(indexSrc.includes('reconcileTopicUnreadForDirectorySubscribers(topicId, snapshot.senderProfileId)'), 'root message unread reconcile missing')
  assert(indexSrc.includes('reconcileTopicUnreadForDirectorySubscribers(topicId, snapshot.senderProfileId)'), 'reply unread reconcile missing')
  assert(indexSrc.includes('reconcileTopicUnreadForDirectorySubscribers(topicId)'), 'delete unread reconcile missing')
  assert(indexSrc.includes('markTopicSeenForActiveProfile(latestConnection.profileId, message.topicId)'), 'subscribe_topic_messages mark-seen missing')
  assert(indexSrc.includes('markSenderSeenThroughCurrent(myProfileId, targetProfileId)'), 'unblock sender boundary missing')
  assert(indexSrc.includes('broadcastTopicUnreadCountsToProfile(myProfileId)'), 'unblock unread rebroadcast missing')
})

if (failed > 0) {
  console.error(`\nTopic unread/seen auth+realtime checks failed: ${failed} failed, ${passed} passed.`)
  process.exit(1)
}

console.log(`\nTopic unread/seen auth+realtime checks passed: ${passed} checks.\n`)
