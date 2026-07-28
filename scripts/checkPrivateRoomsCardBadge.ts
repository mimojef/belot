/**
 * Regression checks for the private rooms quick-action badge in the lobby.
 *
 * Semantics covered here:
 * - the red badge count is exactly the current server-authoritative private_rooms_list size;
 * - 0 rooms means no badge, positive counts render that count;
 * - desktop and mobile private-room cards both render the same badge;
 * - the badge is not driven by private_room_created_notice, unread state, localStorage, or clear-on-open logic.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPrivateRoomsBadgeCount } from '../src/app/lobby/renderLobbyScreen.ts'
import type { PrivateRoomSnapshot } from '../src/app/network/createGameServerClient.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const RENDER_PATH = join(REPO_ROOT, 'src', 'app', 'lobby', 'renderLobbyScreen.ts')
const CONTROLLER_PATH = join(REPO_ROOT, 'src', 'app', 'lobby', 'createLobbyFlowController.ts')

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}

function fail(label: string, reason: string): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason}`)
}

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err))
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function makeRooms(count: number): PrivateRoomSnapshot[] {
  return Array.from({ length: count }, (_, index) => ({ id: `room-${index + 1}` }) as PrivateRoomSnapshot)
}

function extractBlock(src: string, startMarker: string, endMarker: string, label: string): string {
  const start = src.indexOf(startMarker)
  assert(start !== -1, `${label}: missing start marker ${JSON.stringify(startMarker)}`)
  const afterStart = src.slice(start)
  const end = afterStart.indexOf(endMarker)
  assert(end !== -1, `${label}: missing end marker ${JSON.stringify(endMarker)}`)
  return afterStart.slice(0, end)
}

const renderSrc = normalizeLineEndings(await readFile(RENDER_PATH, 'utf8'))
const controllerSrc = normalizeLineEndings(await readFile(CONTROLLER_PATH, 'utf8'))

console.log('\n=== Private Rooms Card Badge Checks ===\n')

await check('[1] Badge count is exactly private_rooms_list size for 0/1/2/3 rooms', () => {
  for (const count of [0, 1, 2, 3]) {
    assertEqual(getPrivateRoomsBadgeCount(makeRooms(count)), count, `count ${count}`)
  }
})

await check('[2] Badge count follows authoritative removals without going negative', () => {
  assertEqual(getPrivateRoomsBadgeCount(makeRooms(3)), 3, 'three active private rooms')
  assertEqual(getPrivateRoomsBadgeCount(makeRooms(2)), 2, 'one room removed')
  assertEqual(getPrivateRoomsBadgeCount(makeRooms(0)), 0, 'all rooms removed')
})

await check('[3] Lobby render derives privateRoomsCount from state.privateRooms only', () => {
  assert(
    renderSrc.includes('const privateRoomsCount = getPrivateRoomsBadgeCount(state.privateRooms)'),
    'renderLobbyScreen must derive the badge count from state.privateRooms',
  )
})

await check('[4] Desktop private rooms card renders the red badge and has positioning context', () => {
  const block = extractBlock(
    renderSrc,
    '<div data-lobby-private-rooms-card="1" style="',
    '<div data-lobby-daily-rewards-card="1" style="',
    'desktop private rooms card',
  )
  assert(block.includes('position:relative;'), 'desktop card must provide positioning context for the absolute badge')
  assert(block.includes('${renderQuickActionBadge(privateRoomsCount)}'), 'desktop card must render the privateRoomsCount badge')
})

await check('[5] Mobile private rooms card renders the same red badge', () => {
  const mobileFn = extractBlock(
    renderSrc,
    'function renderMobileQuickActions(unclaimedMissionsCount: number, hasUnclaimedDailyReward: boolean, privateRoomsCount: number): string {',
    '<button type="button" data-lobby-daily-rewards-card="1"',
    'mobile quick actions private rooms card',
  )
  assert(mobileFn.includes('${renderQuickActionBadge(privateRoomsCount)}'), 'mobile card must render the privateRoomsCount badge')
})

await check('[6] private_rooms_list snapshot is the client-side source of state.privateRooms', () => {
  const block = extractBlock(
    controllerSrc,
    "if (message.type === 'private_rooms_list') {",
    "if (message.type === 'private_room_updated')",
    'private_rooms_list handler',
  )
  assert(block.includes('state.privateRooms = message.rooms'), 'private_rooms_list must replace state.privateRooms with the server snapshot')
  assert(block.includes('render()'), 'private_rooms_list must re-render the lobby after updating the snapshot')
})

await check('[7] Badge is not unread/new/localStorage/notice driven and is not cleared on open', () => {
  assert(!/privateRooms(?:Unread|New|Seen|Viewed|Notice)/.test(renderSrc), 'render must not introduce unread/new/seen private-room badge state')
  assert(!/localStorage\.[\s\S]{0,120}privateRooms|privateRooms[\s\S]{0,120}localStorage/.test(renderSrc), 'render must not persist private-room badge state in localStorage')

  const openHandler = extractBlock(
    controllerSrc,
    'onPrivateRoomsOpen: () => {',
    '\n      },',
    'onPrivateRoomsOpen handler',
  )
  assert(!openHandler.includes('privateRooms = []'), 'opening private rooms must not clear the authoritative room list')
  assert(!/privateRooms(?:Unread|New|Seen|Viewed|Badge|Notice|Count)/.test(openHandler), 'opening private rooms must not clear local badge state')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exitCode = 1
}
