/**
 * checkPrivateRoomBotFillGating.ts
 *
 * Unit tests for server/src/game/privateRoomsStore.ts's beginBotFill(), the
 * atomic pre-condition gate for the "Запълни с ботове" feature. Exercises
 * the store directly (pure in-memory module, no WS/DB needed) to prove the
 * race-condition and authorization guarantees described in the task spec.
 *
 * Covers:
 *  - Only the host connection may trigger bot-fill.
 *  - Requires 2 or 3 human members (not 1, and 4 already auto-starts via
 *    the existing onRoomFull path before beginBotFill could ever run).
 *  - A successful call synchronously detaches the room from the store
 *    (mirrors the existing room-full auto-start pattern) — proving:
 *      * the room disappears from listRooms() (removed from the public
 *        list immediately, before any bot/game-start work happens),
 *      * a concurrent join_private_room for the same id now fails with
 *        "table no longer exists" instead of seating a 5th participant,
 *      * a double-click / duplicate bot-fill command fails cleanly
 *        (idempotent — second call is a clear no-op error, not a crash
 *        or a second game start),
 *      * a member who left just before the command reduces the room to
 *        an invalid member count and bot-fill is rejected accordingly.
 *  - onRoomsChanged fires exactly once for the detach (list broadcast).
 */

import { createPrivateRoomsStore, type PrivateRoom } from '../src/game/privateRoomsStore.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  PASS  ${label}`)
    passed++
  } else {
    console.error(`  FAIL  ${label}`)
    failed++
  }
}

type Callbacks = {
  onRoomsChanged: () => void
  onRoomFull: (room: PrivateRoom) => void
  onRoomExpired: (room: PrivateRoom) => void
  onRoomClosed: (room: PrivateRoom) => void
  onMemberLeft: (room: PrivateRoom, member: unknown) => void
}

function createTrackedStore() {
  const events: string[] = []
  const callbacks: Callbacks = {
    onRoomsChanged: () => events.push('roomsChanged'),
    onRoomFull: () => events.push('roomFull'),
    onRoomExpired: () => events.push('roomExpired'),
    onRoomClosed: () => events.push('roomClosed'),
    onMemberLeft: () => events.push('memberLeft'),
  }
  const store = createPrivateRoomsStore(callbacks as never)
  return { store, events }
}

function makeMember(id: string) {
  return {
    connectionId: `conn-${id}`,
    profileId: `profile-${id}`,
    displayName: `Player ${id}`,
    avatarUrl: null,
    level: 5,
    rankTitle: null,
  }
}

// ---------------------------------------------------------------------------
// [1] Lone host (1 member) → rejected
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const created = store.createRoom({ ...makeMember('host'), stake: 1000, isLocked: false })
  if (!created.ok) throw new Error('setup failed')

  const result = store.beginBotFill('conn-host')
  check('[1] lone host (1 member) cannot fill with bots', !result.ok)
  check('[1b] room still listed after rejected attempt', store.listRooms().some((r) => r.id === created.room.id))
}

// ---------------------------------------------------------------------------
// [2] 2 members → accepted
// ---------------------------------------------------------------------------
{
  const { store, events } = createTrackedStore()
  const created = store.createRoom({ ...makeMember('host'), stake: 1000, isLocked: false })
  if (!created.ok) throw new Error('setup failed')
  const joined = store.joinRoom({ privateRoomId: created.room.id, ...makeMember('guest1') })
  if (!joined.ok) throw new Error('setup failed')

  events.length = 0
  const result = store.beginBotFill('conn-host')
  check('[2] host with 2 members can trigger bot-fill', result.ok && result.room.members.length === 2)
  check('[2b] onRoomsChanged fired exactly once for the detach', events.filter((e) => e === 'roomsChanged').length === 1)
  check('[2c] no onRoomFull/onRoomClosed/onRoomExpired side-fired', !events.includes('roomFull') && !events.includes('roomClosed') && !events.includes('roomExpired'))
}

// ---------------------------------------------------------------------------
// [3] 3 members → accepted
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const created = store.createRoom({ ...makeMember('host'), stake: 1000, isLocked: false })
  if (!created.ok) throw new Error('setup failed')
  store.joinRoom({ privateRoomId: created.room.id, ...makeMember('guest1') })
  store.joinRoom({ privateRoomId: created.room.id, ...makeMember('guest2') })

  const result = store.beginBotFill('conn-host')
  check('[3] host with 3 members can trigger bot-fill', result.ok && result.room.members.length === 3)
}

// ---------------------------------------------------------------------------
// [4] Non-host member cannot trigger bot-fill
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const created = store.createRoom({ ...makeMember('host'), stake: 1000, isLocked: false })
  if (!created.ok) throw new Error('setup failed')
  store.joinRoom({ privateRoomId: created.room.id, ...makeMember('guest1') })

  const result = store.beginBotFill('conn-guest1')
  check('[4] a non-host member cannot trigger bot-fill', !result.ok)
  check('[4b] room untouched after rejected non-host attempt', store.listRooms().some((r) => r.id === created.room.id))
}

// ---------------------------------------------------------------------------
// [5] Double-click: second beginBotFill call after a successful one fails cleanly
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const created = store.createRoom({ ...makeMember('host'), stake: 1000, isLocked: false })
  if (!created.ok) throw new Error('setup failed')
  store.joinRoom({ privateRoomId: created.room.id, ...makeMember('guest1') })

  const first = store.beginBotFill('conn-host')
  const second = store.beginBotFill('conn-host')

  check('[5] first bot-fill call succeeds', first.ok)
  check('[5b] second (duplicate) bot-fill call is rejected, not a crash or a second start', !second.ok)
}

// ---------------------------------------------------------------------------
// [6] Join-during-fill: a join arriving right after bot-fill detaches the
// room fails with "table no longer exists" instead of seating a 5th player.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const created = store.createRoom({ ...makeMember('host'), stake: 1000, isLocked: false })
  if (!created.ok) throw new Error('setup failed')
  store.joinRoom({ privateRoomId: created.room.id, ...makeMember('guest1') })

  const fillResult = store.beginBotFill('conn-host')
  check('[6] bot-fill succeeds first', fillResult.ok)

  const lateJoin = store.joinRoom({ privateRoomId: created.room.id, ...makeMember('late') })
  check('[6b] a join racing right after bot-fill fails (room already gone)', !lateJoin.ok)
  check(
    '[6c] room no longer listed, so no 5th participant / duplicate seat is possible',
    !store.listRooms().some((r) => r.id === created.room.id),
  )
}

// ---------------------------------------------------------------------------
// [7] Leave-before-start: a member leaving right before bot-fill can drop
// the room below the 2-human minimum, and the command is rejected.
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const created = store.createRoom({ ...makeMember('host'), stake: 1000, isLocked: false })
  if (!created.ok) throw new Error('setup failed')
  store.joinRoom({ privateRoomId: created.room.id, ...makeMember('guest1') })

  store.leaveRoom('conn-guest1')
  const result = store.beginBotFill('conn-host')
  check('[7] host alone (guest left just before) cannot fill with bots', !result.ok)
}

// ---------------------------------------------------------------------------
// [8] Host who already left cannot trigger bot-fill (stale connectionId)
// ---------------------------------------------------------------------------
{
  const { store } = createTrackedStore()
  const created = store.createRoom({ ...makeMember('host'), stake: 1000, isLocked: false })
  if (!created.ok) throw new Error('setup failed')
  store.joinRoom({ privateRoomId: created.room.id, ...makeMember('guest1') })
  store.joinRoom({ privateRoomId: created.room.id, ...makeMember('guest2') })

  // Host leaves with others present → room closes entirely (existing
  // dissolve-on-host-leave behaviour, unchanged by this feature).
  store.closeRoom('conn-host')
  const result = store.beginBotFill('conn-host')
  check('[8] a stale/former host connectionId cannot trigger bot-fill on a closed room', !result.ok)
}

// ---------------------------------------------------------------------------
// [9] 4th human joining concurrently with the fill command: whichever wins
// (join reaching 4 first triggers the existing normal onRoomFull path;
// bot-fill winning first detaches the room before the join can land) is a
// safe terminal state — never both.
// ---------------------------------------------------------------------------
{
  const { store, events } = createTrackedStore()
  const created = store.createRoom({ ...makeMember('host'), stake: 1000, isLocked: false })
  if (!created.ok) throw new Error('setup failed')
  store.joinRoom({ privateRoomId: created.room.id, ...makeMember('guest1') })
  store.joinRoom({ privateRoomId: created.room.id, ...makeMember('guest2') })

  // Scenario A: the 4th human's join is processed first (single-threaded
  // event loop — one message handler runs to completion before the next).
  events.length = 0
  const fourthJoin = store.joinRoom({ privateRoomId: created.room.id, ...makeMember('guest3') })
  check('[9] 4th human join completes normally (existing auto-start path)', fourthJoin.ok)
  check('[9b] room-full callback fired for the 4-human case', events.includes('roomFull'))

  // The room is now gone — a subsequent bot-fill command (arriving just
  // after) must find nothing to act on.
  const lateFill = store.beginBotFill('conn-host')
  check('[9c] a bot-fill command racing right after the 4th join is safely rejected', !lateFill.ok)
}

console.log('')
console.log(`Passed: ${passed}, Failed: ${failed}`)

// Rooms created above via privateRoomsStore.createRoom() schedule a real
// setTimeout for their expiry (10-20 min) — several test scenarios above
// intentionally leave a room "dangling" (rejected bot-fill attempts) to
// prove it's untouched, so those timers are never cancelled. Exit
// explicitly instead of waiting for the event loop to drain naturally.
process.exit(failed > 0 ? 1 : 0)
