/**
 * Source regression for friend online/offline dots in lobby UI.
 *
 * Keeps the change frontend-only and scoped to:
 * - Friends page desktop cards
 * - Friends page mobile cards
 * - Chat page mobile horizontal conversation list
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const projectRootArgIndex = process.argv.indexOf('--project-root')
const projectRoot = projectRootArgIndex >= 0 && process.argv[projectRootArgIndex + 1]
  ? resolve(process.argv[projectRootArgIndex + 1])
  : resolve(import.meta.dirname, '../..')

const renderSrc = readFileSync(resolve(projectRoot, 'src/app/lobby/renderLobbyScreen.ts'), 'utf8')
const networkSrc = readFileSync(resolve(projectRoot, 'src/app/network/createGameServerClient.ts'), 'utf8')

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

function check(label: string, fn: () => void): void {
  try {
    fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function findFunctionSource(name: string): string {
  const start = renderSrc.indexOf(`function ${name}`)
  assert(start >= 0, `missing function ${name}`)

  const nextFunction = renderSrc.indexOf('\nfunction ', start + 1)
  const nextExportedFunction = renderSrc.indexOf('\nexport function ', start + 1)
  const candidates = [nextFunction, nextExportedFunction].filter((index) => index > start)
  const end = candidates.length > 0 ? Math.min(...candidates) : renderSrc.length
  return renderSrc.slice(start, end)
}

const dotHelper = findFunctionSource('renderFriendOnlineStatusDot')
const desktopFriendCard = findFunctionSource('renderFriendRelationshipCard')
const mobileFriendCard = findFunctionSource('renderMobileFriendCard')
const mobileChatPanel = findFunctionSource('renderMobileChatPanel')
const desktopChatPanel = findFunctionSource('renderChatPanel')

console.log('\n=== Friend online status frontend source checks ===\n')

check('[1] Friends desktop renders online/offline dot classes from authoritative isOnline', () => {
  assert(dotHelper.includes('friend-online-status-dot--online'), 'missing online status class')
  assert(dotHelper.includes('friend-online-status-dot--offline'), 'missing offline status class')
  assert(dotHelper.includes("isOnline ? '#22c55e' : '#ef4444'"), 'dot colors must be green/red')
  assert(desktopFriendCard.includes("variant === 'friend' ? renderFriendOnlineStatusDot(relationship.isOnline) : ''"), 'desktop friends list must use relationship.isOnline only for accepted friends')
})

check('[2] Friends mobile indicator renders over the existing avatar wrapper', () => {
  assert(mobileFriendCard.includes('style="position:relative;width:52px;height:52px;flex:0 0 auto;"'), 'mobile avatar wrapper must remain fixed-size and relative')
  assert(mobileFriendCard.includes("variant === 'friend' ? renderFriendOnlineStatusDot(relationship.isOnline) : ''"), 'mobile friends list must use relationship.isOnline only for accepted friends')
})

check('[3] Chat mobile horizontal list adds dot inside mobile avatar wrapper', () => {
  assert(mobileChatPanel.includes('data-lobby-chat-conversation'), 'mobile chat conversation buttons must remain clickable')
  assert(mobileChatPanel.includes('style="position:relative;width:44px;height:44px;flex:0 0 auto;"'), 'mobile chat avatar wrapper must be fixed-size and relative')
  assert(mobileChatPanel.includes('renderFriendOnlineStatusDot(conversation.friend.isOnline)'), 'mobile chat must use existing conversation.friend.isOnline state')
})

check('[4] Chat desktop existing status renderer stays unchanged', () => {
  assert(desktopChatPanel.includes('const isOnline = conversation.friend.isOnline'), 'desktop chat must still read conversation.friend.isOnline')
  assert(
    desktopChatPanel.includes("position:absolute;bottom:-2px;right:-2px;width:11px;height:11px;border-radius:50%;background:${isOnline ? '#22c55e' : '#ef4444'};border:2px solid #050505;"),
    'desktop chat status markup changed unexpectedly',
  )
})

check('[5] No new polling/request/localStorage/WebSocket status inference', () => {
  assert(!dotHelper.includes('fetch('), 'status dot helper must not fetch')
  assert(!dotHelper.includes('localStorage'), 'status dot helper must not use localStorage')
  assert(!dotHelper.includes('WebSocket'), 'status dot helper must not create/use WebSocket')
  assert(networkSrc.includes('isOnline?: boolean'), 'renderer should rely on existing typed isOnline field')
})

check('[6] Players directory visibility guard remains admin/subadmin-only', () => {
  assert(
    renderSrc.includes('state.isAdminOrSubadmin && player.isOnline !== undefined'),
    'desktop Players directory online visibility guard changed',
  )
  assert(
    renderSrc.includes('renderMobilePlayerListCard(player, \'data-lobby-player-card\', state.isAdminOrSubadmin)'),
    'mobile Players directory should still pass state.isAdminOrSubadmin',
  )
})

check('[7] Friend click/navigation and unread behavior remains wired', () => {
  assert(desktopFriendCard.includes('data-lobby-friend-profile="${escapeHtml(profileId)}"'), 'desktop friend profile click target missing')
  assert(mobileFriendCard.includes('data-lobby-friend-profile="${escapeHtml(profileId)}"'), 'mobile friend profile click target missing')
  assert(mobileChatPanel.includes('conversation.unreadCount > 0'), 'mobile chat unread badge rendering missing')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
