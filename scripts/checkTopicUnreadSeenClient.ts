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
})

await check('[3] flow clears active-topic unread and reconciles with server', () => {
  assert(flowSrc.includes('topicSeenInFlightByTopicId'), 'seen in-flight guard missing')
  assert(flowSrc.includes('topicSeenQueuedByTopicId'), 'seen queued guard missing')
  assert(flowSrc.includes('updateTopicUnreadCount(topicId, 0)'), 'active topic local clear missing')
  assert(flowSrc.includes('options.onTopicMarkSeen'), 'server mark-seen call missing')
  assert(flowSrc.includes('reconcileTopicsDirectoryFromServer'), 'server reconciliation helper missing')
})

await check('[4] active topic load, switch, catchup, roots, replies, and reconnect trigger mark-seen', () => {
  assert(flowSrc.includes('subscribeToTopicMessagesGapClosing(topicId)\n    void markActiveTopicSeen(topicId)'), 'initial load mark-seen missing')
  assert(flowSrc.includes('updateTopicUnreadCount(topicId, 0)'), 'topic switch clear missing')
  assert(flowSrc.includes("message.type === 'topic_message_catchup'"), 'catchup handler missing')
  assert(flowSrc.includes("message.type === 'topic_message'"), 'root realtime handler missing')
  assert(flowSrc.includes("message.type === 'topic_reply'"), 'reply realtime handler missing')
  assert(flowSrc.includes('void reconcileTopicsDirectoryFromServer()'), 'reconnect directory reconciliation missing')
})

await check('[5] unread/seen realtime messages update directory state', () => {
  assert(flowSrc.includes("message.type === 'topic_unread_count_changed'"), 'unread realtime handler missing')
  assert(flowSrc.includes("message.type === 'topic_seen_updated'"), 'seen realtime handler missing')
  assert(flowSrc.includes('message.unreadCount'), 'unreadCount reconciliation missing')
})

await check('[6] badge render is visual-only capped at 99 without plus suffix', () => {
  assert(renderSrc.includes('formatTopicUnreadBadgeCount'), 'badge formatter missing')
  assert(renderSrc.includes('return String(Math.min(normalized, 99))'), '99 visual cap missing')
  assert(renderSrc.includes('topic-unread-badge'), 'badge class missing')
  assert(renderSrc.includes('isActive ? null'), 'active topic badge should be hidden')
  assert(!renderSrc.includes("'99+'"), 'badge must never render 99+')
})

if (failed > 0) {
  console.error(`\nTopic unread/seen client checks failed: ${failed} failed, ${passed} passed.`)
  process.exit(1)
}

console.log(`\nTopic unread/seen client checks passed: ${passed} checks.\n`)
