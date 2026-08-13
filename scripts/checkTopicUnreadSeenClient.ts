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

function projectRoot(): string {
  const flag = '--project-root='
  const arg = process.argv.find((value) => value.startsWith(flag))
  return arg ? resolve(arg.slice(flag.length)) : process.cwd()
}

const root = projectRoot()
const mainSrc = await readFile(resolve(root, 'src/main.ts'), 'utf8')
const flowSrc = await readFile(resolve(root, 'src/app/lobby/createLobbyFlowController.ts'), 'utf8')
const renderSrc = await readFile(resolve(root, 'src/app/lobby/renderTopicsScreen.ts'), 'utf8')
const networkSrc = await readFile(resolve(root, 'src/app/network/createGameServerClient.ts'), 'utf8')

console.log('\n=== Topic Unread / Seen (client contract) ===\n')

await check('[1] client TopicSnapshot carries canonical unreadCount', () => {
  const topicType = networkSrc.match(/export type TopicSnapshot = \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert(topicType.includes('unreadCount: number'), 'TopicSnapshot.unreadCount missing')
})

await check('[2] main wires POST /seen into lobby controller', () => {
  assert(mainSrc.includes('/seen'), 'markTopicSeen endpoint missing')
  assert(mainSrc.includes('method: \'POST\''), 'markTopicSeen must POST')
  assert(mainSrc.includes('onTopicMarkSeen: (topicId) => markTopicSeen(topicId)'), 'controller option missing')
  assert(mainSrc.includes('/messages/${encodeURIComponent(rootMessageId)}/seen'), 'markTopicThreadSeen endpoint missing')
  assert(mainSrc.includes('onTopicThreadMarkSeen: (topicId, rootMessageId) => markTopicThreadSeen(topicId, rootMessageId)'), 'thread seen controller option missing')
})

await check('[3] flow keeps legacy topic seen separate from General thread seen', () => {
  assert(flowSrc.includes('topicSeenInFlightByTopicId'), 'seen in-flight guard missing')
  assert(flowSrc.includes('topicSeenQueuedByTopicId'), 'seen queued guard missing')
  assert(flowSrc.includes('topicThreadSeenInFlightByRootId'), 'thread seen in-flight guard missing')
  assert(flowSrc.includes('topicThreadSeenQueuedByRootId'), 'thread seen queued guard missing')
  assert(flowSrc.includes('if (isGeneralTopicId(topicId)) return'), 'General topic must not use topic-level mark-seen')
  assert(flowSrc.includes('onTopicThreadMarkSeen'), 'thread server mark-seen call missing')
  assert(flowSrc.includes('options.onTopicMarkSeen'), 'server mark-seen call missing')
  assert(flowSrc.includes('reconcileTopicsDirectoryFromServer'), 'server reconciliation helper missing')
})

await check('[4] General open does not clear unread; exact thread open does', () => {
  assert(/subscribeToTopicMessagesGapClosing\(topicId\)\s+void markActiveTopicSeen\(topicId\)/.test(flowSrc), 'legacy topic initial mark-seen path missing')
  assert(flowSrc.includes('state.activeTopicId !== null && !isGeneralTopicId(state.activeTopicId)'), 'General initial open must not local-clear unread')
  assert(flowSrc.includes('if (!isGeneralTopicId(topicId))'), 'General topic switch must not local-clear unread')
  assert(flowSrc.includes('void markTopicThreadSeen(rootMessageId)'), 'thread open mark-seen missing')
  assert(flowSrc.includes("message.type === 'topic_message_catchup'"), 'catchup handler missing')
  assert(flowSrc.includes("message.type === 'topic_message'"), 'root realtime handler missing')
  assert(flowSrc.includes("message.type === 'topic_reply'"), 'reply realtime handler missing')
  assert(flowSrc.includes('void reconcileTopicsDirectoryFromServer()'), 'reconnect directory reconciliation missing')
})

await check('[5] unread/seen realtime messages update directory state', () => {
  assert(flowSrc.includes("message.type === 'topic_unread_count_changed'"), 'unread realtime handler missing')
  assert(flowSrc.includes("message.type === 'topic_seen_updated'"), 'seen realtime handler missing')
  assert(flowSrc.includes("message.type === 'topic_thread_unread_count_changed'"), 'thread unread realtime handler missing')
  assert(flowSrc.includes("message.type === 'topic_thread_seen_updated'"), 'thread seen realtime handler missing')
  assert(flowSrc.includes('updateTopicThreadUnreadCount(message.rootMessageId'), 'thread unread reconciliation missing')
  assert(flowSrc.includes('message.topicUnreadCount'), 'General aggregate reconciliation missing')
  assert(flowSrc.includes('message.unreadCount'), 'unreadCount reconciliation missing')
})

await check('[6] badge render uses shared 99/100 notification formatter', () => {
  assert(renderSrc.includes('formatTopicUnreadBadgeCount'), 'badge formatter missing')
  assert(renderSrc.includes('return formatNotificationBadgeCount(count)'), 'topic badge must reuse shared notification formatter')
  assert(renderSrc.includes('data-topics-general-badge="1"'), 'General topic badge node missing')
  assert(renderSrc.includes('data-topic-thread-unread-badge'), 'thread card unread badge node missing')
  assert(renderSrc.includes('const generalUnreadBadge = formatTopicUnreadBadgeCount(generalUnreadTotal)'), 'General badge must use canonical topic-general unread formatter')
})

await check('[7] Lobby initial auth lifecycle loads topic directory unread metadata without message history', () => {
  const refreshStart = flowSrc.indexOf('async function refreshTopicsDirectoryMetadata(): Promise<boolean>')
  const refreshEnd = flowSrc.indexOf('async function reconcileTopicsDirectoryFromServer', refreshStart)
  const refreshBody = refreshStart >= 0 && refreshEnd > refreshStart ? flowSrc.slice(refreshStart, refreshEnd) : ''
  assert(mainSrc.includes('syncLobbyTopicsDirectoryMetadata'), 'main must sync topics directory metadata during auth lifecycle')
  assert(mainSrc.includes('await syncLobbyTopicsDirectoryMetadata()'), 'auth lifecycle must await topics metadata sync')
  assert(refreshBody.includes('refreshTopicsDirectoryMetadata'), 'controller topics metadata refresh helper missing')
  assert(flowSrc.includes('topicsLoadedForProfileId'), 'profile guard for topics metadata missing')
  assert(refreshBody.includes('latestAuthSession?.profile.profileId !== profileId'), 'stale profile metadata guard missing')
  assert(refreshBody.includes('subscribeToTopicsDirectory()'), 'topics directory realtime subscription missing after metadata load')
  assert(!refreshBody.includes('onTopicMessagesLoad'), 'metadata refresh must not load topic message history')
})

if (failed > 0) {
  console.error(`\nTopic unread/seen client checks failed: ${failed} failed, ${passed} passed.`)
  process.exit(1)
}

console.log(`\nTopic unread/seen client checks passed: ${passed} checks.\n`)
