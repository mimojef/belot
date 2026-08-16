/**
 * checkPrivateRoomWaitTimeSelection.ts
 *
 * Verifies the server-side "selectable private-room wait time" feature:
 *  - parseClientMessage('create_private_room') validation of the new
 *    waitMinutes field (server/src/protocol/parseClientMessage.ts);
 *  - privateRoomsStore.createRoom() using waitMinutes*60_000 for expiresAt,
 *    fully decoupled from isLocked (server/src/game/privateRoomsStore.ts);
 *  - the existing lifecycle guarantees still hold: expiresAt is set once and
 *    never touched by join/leave/reconnect; the timer is cancelled exactly
 *    once on room-full, bot-fill, manual close, or "last member leaves";
 *  - race conditions: expiry racing a final join, expiry racing bot-fill,
 *    an expiry callback firing after the room was already removed, no
 *    double private_room_expired equivalent (onRoomExpired called once).
 *
 * Uses real fake timers (vi-less — a hand-rolled clock override) so timing
 * assertions are deterministic, not flaky wall-clock waits.
 */

import { parseClientMessage } from '../src/protocol/parseClientMessage.js'
import { createPrivateRoomsStore, type PrivateRoom, type PrivateRoomBotOccupant } from '../src/game/privateRoomsStore.js'
import { setSupportedMatchStakes } from '../src/matchmaking/matchmakingTypes.js'

// isSupportedStake() (used by the create_private_room parser branch) checks
// against SUPPORTED_MATCH_STAKES, which is populated at server startup from
// matchRoomsStore — not at import time. Seed it here so stake=5000 validates
// the same way it does in production.
setSupportedMatchStakes([5000, 8000, 10000, 15000, 20000])

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

// ---------------------------------------------------------------------------
// Deterministic fake clock: overrides Date.now, setTimeout, clearTimeout so
// scheduleExpiry()'s real setTimeout calls become instantly and precisely
// controllable, without relying on real wall-clock delays.
// ---------------------------------------------------------------------------
type FakeTimer = { id: number; fireAt: number; callback: () => void; cleared: boolean }

class FakeClock {
  private currentTime = 1_700_000_000_000
  private nextId = 1
  private timers: FakeTimer[] = []

  now(): number {
    return this.currentTime
  }

  setTimeout(callback: () => void, delay: number): number {
    const id = this.nextId++
    this.timers.push({ id, fireAt: this.currentTime + Math.max(delay, 0), callback, cleared: false })
    return id
  }

  clearTimeout(id: number): void {
    const timer = this.timers.find((t) => t.id === id)
    if (timer) timer.cleared = true
  }

  activeTimerCount(): number {
    return this.timers.filter((t) => !t.cleared).length
  }

  // Advances the clock and fires any timers whose fireAt has been reached,
  // in fireAt order — mirrors Node's event loop ordering closely enough for
  // this store's single-timer-per-room usage.
  advanceTo(targetTime: number): void {
    while (true) {
      const due = this.timers
        .filter((t) => !t.cleared && t.fireAt <= targetTime)
        .sort((a, b) => a.fireAt - b.fireAt)[0]
      if (due === undefined) break
      this.currentTime = due.fireAt
      due.cleared = true
      due.callback()
    }
    this.currentTime = Math.max(this.currentTime, targetTime)
  }

  advanceBy(deltaMs: number): void {
    this.advanceTo(this.currentTime + deltaMs)
  }
}

function installFakeClock(): FakeClock {
  const clock = new FakeClock()
  ;(globalThis as any).__originalDateNow = Date.now
  ;(globalThis as any).__originalSetTimeout = globalThis.setTimeout
  ;(globalThis as any).__originalClearTimeout = globalThis.clearTimeout

  Date.now = () => clock.now()
  ;(globalThis as any).setTimeout = (cb: () => void, delay?: number) => clock.setTimeout(cb, delay ?? 0)
  ;(globalThis as any).clearTimeout = (id: any) => clock.clearTimeout(id)

  return clock
}

function restoreRealClock(): void {
  Date.now = (globalThis as any).__originalDateNow
  globalThis.setTimeout = (globalThis as any).__originalSetTimeout
  globalThis.clearTimeout = (globalThis as any).__originalClearTimeout
}

function makeCreateInput(overrides: Partial<Parameters<ReturnType<typeof createPrivateRoomsStore>['createRoom']>[0]> = {}) {
  return {
    connectionId: overrides.connectionId ?? 'conn-host',
    profileId: overrides.profileId ?? 'host-profile',
    displayName: overrides.displayName ?? 'Host',
    avatarUrl: null,
    level: 5,
    rankTitle: null,
    stake: 5000 as const,
    isLocked: overrides.isLocked ?? false,
    waitMinutes: overrides.waitMinutes ?? (15 as const),
  }
}

const noBlocks = () => false

function makeJoinInput(privateRoomId: string, connectionId: string, profileId: string, team: 'A' | 'B', slotIndex: 0 | 1) {
  return {
    privateRoomId,
    connectionId,
    profileId,
    displayName: `Player ${profileId}`,
    avatarUrl: null,
    level: 5,
    rankTitle: null,
    team,
    slotIndex,
    isBlockedWith: noBlocks,
  }
}

function makeBotOccupant(id: string): PrivateRoomBotOccupant {
  return {
    kind: 'bot',
    botProfileId: `bot-${id}`,
    botCode: 'CATALOG_BOT',
    difficulty: 'normal',
    identity: {
      accountId: null,
      profileId: `bot-${id}`,
      username: null,
      displayName: `Bot ${id}`,
      avatarUrl: null,
      level: 7,
      rankTitle: 'Новак',
      skillRating: 1000,
      gender: null,
    },
  }
}

// ---------------------------------------------------------------------------
// [1] Parser validation
// ---------------------------------------------------------------------------
function checkParserCase(label: string, waitMinutesJson: string | undefined, expected: 'accept' | 'reject', expectedValue?: number): void {
  const body: Record<string, unknown> = { type: 'create_private_room', stake: 5000, isLocked: false }
  const raw = waitMinutesJson === undefined
    ? JSON.stringify(body)
    : `{"type":"create_private_room","stake":5000,"isLocked":false,"waitMinutes":${waitMinutesJson}}`

  const result = parseClientMessage(raw)

  if (expected === 'reject') {
    check(label, result === null)
    return
  }

  check(
    label,
    result !== null && result.type === 'create_private_room' && (result as any).waitMinutes === expectedValue,
  )
}

checkParserCase('[P1] missing waitMinutes -> defaults to 15', undefined, 'accept', 15)
checkParserCase('[P2] waitMinutes=5 -> accepted as 5', '5', 'accept', 5)
checkParserCase('[P3] waitMinutes=10 -> accepted as 10', '10', 'accept', 10)
checkParserCase('[P4] waitMinutes=15 -> accepted as 15', '15', 'accept', 15)
checkParserCase('[P5] waitMinutes=30 -> accepted as 30', '30', 'accept', 30)
checkParserCase('[P6] waitMinutes=0 -> rejected (parse failure, not coerced)', '0', 'reject')
checkParserCase('[P7] waitMinutes=7 -> rejected', '7', 'reject')
checkParserCase('[P8] waitMinutes=-5 -> rejected', '-5', 'reject')
checkParserCase('[P9] waitMinutes=60 -> rejected', '60', 'reject')
checkParserCase('[P10] waitMinutes="15" (string) -> rejected, NOT coerced to number 15', '"15"', 'reject')
checkParserCase('[P11] waitMinutes=null -> rejected', 'null', 'reject')
checkParserCase('[P12] waitMinutes=true (boolean) -> rejected', 'true', 'reject')
checkParserCase('[P13] waitMinutes={} (object) -> rejected', '{}', 'reject')
checkParserCase('[P14] waitMinutes=[15] (array) -> rejected', '[15]', 'reject')

{
  // Whole-message parse failure: invalid waitMinutes must reject the ENTIRE
  // create_private_room message, not just silently drop the field.
  const raw = '{"type":"create_private_room","stake":5000,"isLocked":false,"waitMinutes":7}'
  const result = parseClientMessage(raw)
  check('[P15] invalid waitMinutes rejects the whole message (result is null, not a partial object)', result === null)
}

// ---------------------------------------------------------------------------
// [2] Store: expiresAt derivation, decoupled from isLocked
// ---------------------------------------------------------------------------
{
  const clock = installFakeClock()
  try {
    for (const waitMinutes of [5, 10, 15, 30] as const) {
      for (const isLocked of [false, true]) {
        const store = createPrivateRoomsStore({
          onRoomsChanged: () => {},
          onRoomReady: () => {},
          onRoomExpired: () => {},
          onRoomClosed: () => {},
          onMemberLeft: () => {},
        })
        const before = Date.now()
        const result = store.createRoom(makeCreateInput({ waitMinutes, isLocked, connectionId: `c-${waitMinutes}-${isLocked}` }))
        check(
          `[S1] waitMinutes=${waitMinutes} isLocked=${isLocked}: expiresAt = createdAt + ${waitMinutes}*60000`,
          result.ok && result.room.expiresAt === before + waitMinutes * 60_000,
        )
      }
    }

    // Same waitMinutes, open vs locked -> identical TTL delta (isLocked no
    // longer influences the timeout at all).
    const storeA = createPrivateRoomsStore({ onRoomsChanged: () => {}, onRoomReady: () => {}, onRoomExpired: () => {}, onRoomClosed: () => {}, onMemberLeft: () => {} })
    const storeB = createPrivateRoomsStore({ onRoomsChanged: () => {}, onRoomReady: () => {}, onRoomExpired: () => {}, onRoomClosed: () => {}, onMemberLeft: () => {} })
    const resA = storeA.createRoom(makeCreateInput({ waitMinutes: 10, isLocked: false, connectionId: 'ca' }))
    const resB = storeB.createRoom(makeCreateInput({ waitMinutes: 10, isLocked: true, connectionId: 'cb' }))
    check(
      '[S2] open and locked rooms with the same waitMinutes get the exact same TTL delta',
      resA.ok && resB.ok && (resA.room.expiresAt - resA.room.createdAt) === (resB.room.expiresAt - resB.room.createdAt),
    )
  } finally {
    restoreRealClock()
  }
}

// ---------------------------------------------------------------------------
// [3] Store: expiresAt untouched by join / leave / reconnect
// ---------------------------------------------------------------------------
{
  const clock = installFakeClock()
  try {
    const store = createPrivateRoomsStore({ onRoomsChanged: () => {}, onRoomReady: () => {}, onRoomExpired: () => {}, onRoomClosed: () => {}, onMemberLeft: () => {} })
    const created = store.createRoom(makeCreateInput({ waitMinutes: 10, connectionId: 'host-conn' }))
    if (!created.ok) throw new Error('setup failed')
    const originalExpiresAt = created.room.expiresAt

    clock.advanceBy(60_000)
    const joined = store.joinTeam(makeJoinInput(created.room.id, 'guest-conn', 'guest-profile', 'B', 0))
    check('[S3] join does not change expiresAt', joined.ok && joined.room.expiresAt === originalExpiresAt)

    clock.advanceBy(30_000)
    store.leaveRoom('guest-conn')
    const afterLeave = store.getRoomByConnectionId('host-conn')
    check('[S4] leave (with members remaining) does not change expiresAt', afterLeave !== null && afterLeave.expiresAt === originalExpiresAt)

    clock.advanceBy(30_000)
    const reconnected = store.reconnectMember('host-conn-2', 'host-profile')
    check('[S5] reconnect does not change expiresAt', reconnected !== null && reconnected.expiresAt === originalExpiresAt)
  } finally {
    restoreRealClock()
  }
}

// ---------------------------------------------------------------------------
// [4] Timer cancellation on every documented exit path, exactly once
// ---------------------------------------------------------------------------
{
  const clock = installFakeClock()
  try {
    // 4a: room-full via join cancels the timer (no expiry fires afterwards).
    {
      let expiredCount = 0
      const store = createPrivateRoomsStore({ onRoomsChanged: () => {}, onRoomReady: () => {}, onRoomExpired: () => { expiredCount++ }, onRoomClosed: () => {}, onMemberLeft: () => {} })
      const created = store.createRoom(makeCreateInput({ waitMinutes: 5, connectionId: 'h1' }))
      if (!created.ok) throw new Error('setup failed')
      store.joinTeam(makeJoinInput(created.room.id, 'p2', 'pr2', 'A', 1))
      store.joinTeam(makeJoinInput(created.room.id, 'p3', 'pr3', 'B', 0))
      store.joinTeam(makeJoinInput(created.room.id, 'p4', 'pr4', 'B', 1)) // 4th member -> room full, cancelExpiry
      clock.advanceBy(10 * 60_000)
      check('[S6] room becoming full cancels the expiry timer (onRoomExpired never fires)', expiredCount === 0)
    }

    // 4b: manual close cancels the timer.
    {
      let expiredCount = 0
      const store = createPrivateRoomsStore({ onRoomsChanged: () => {}, onRoomReady: () => {}, onRoomExpired: () => { expiredCount++ }, onRoomClosed: () => {}, onMemberLeft: () => {} })
      const created = store.createRoom(makeCreateInput({ waitMinutes: 5, connectionId: 'h2' }))
      if (!created.ok) throw new Error('setup failed')
      store.closeRoom('h2')
      clock.advanceBy(10 * 60_000)
      check('[S7] manual close cancels the expiry timer', expiredCount === 0)
    }

    // 4c: last member leaving (0 remaining) cancels the timer.
    {
      let expiredCount = 0
      const store = createPrivateRoomsStore({ onRoomsChanged: () => {}, onRoomReady: () => {}, onRoomExpired: () => { expiredCount++ }, onRoomClosed: () => {}, onMemberLeft: () => {} })
      const created = store.createRoom(makeCreateInput({ waitMinutes: 5, connectionId: 'h3' }))
      if (!created.ok) throw new Error('setup failed')
      store.leaveRoom('h3') // solo host leaves -> 0 members remaining
      clock.advanceBy(10 * 60_000)
      check('[S8] 0 remaining members cancels the expiry timer', expiredCount === 0)
    }

    // 4d: bots completing both teams cancels the timer. Unlike the old
    // whole-table beginBotFill(), completing a room now takes one
    // addBotToTeam() call per team (each needs its own human owner) — put
    // one human on each team so both can add a bot and the room reaches 4/4.
    {
      let expiredCount = 0
      const store = createPrivateRoomsStore({ onRoomsChanged: () => {}, onRoomReady: () => {}, onRoomExpired: () => { expiredCount++ }, onRoomClosed: () => {}, onMemberLeft: () => {} })
      const created = store.createRoom(makeCreateInput({ waitMinutes: 5, connectionId: 'h4' }))
      if (!created.ok) throw new Error('setup failed')
      store.joinTeam(makeJoinInput(created.room.id, 'p2', 'pr2', 'B', 0))
      const addBotA = store.addBotToTeam({ connectionId: 'h4', team: 'A', botOccupant: makeBotOccupant('a'), isBlockedWith: noBlocks })
      check('[S9a] addBotToTeam(A) succeeds (room not complete yet)', addBotA.ok && addBotA.readyToStart === false)
      const addBotB = store.addBotToTeam({ connectionId: 'p2', team: 'B', botOccupant: makeBotOccupant('b'), isBlockedWith: noBlocks })
      check('[S9b] addBotToTeam(B) completes the room (4/4)', addBotB.ok && addBotB.readyToStart === true)
      clock.advanceBy(10 * 60_000)
      check('[S10] bot-fill cancels the expiry timer', expiredCount === 0)
    }
  } finally {
    restoreRealClock()
  }
}

// ---------------------------------------------------------------------------
// [5] Actual expiry still fires when nothing intervenes
// ---------------------------------------------------------------------------
{
  const clock = installFakeClock()
  try {
    let expiredRooms: PrivateRoom[] = []
    const store = createPrivateRoomsStore({ onRoomsChanged: () => {}, onRoomReady: () => {}, onRoomExpired: (room) => { expiredRooms.push(room) }, onRoomClosed: () => {}, onMemberLeft: () => {} })
    const created = store.createRoom(makeCreateInput({ waitMinutes: 5, connectionId: 'h5' }))
    if (!created.ok) throw new Error('setup failed')
    clock.advanceBy(5 * 60_000)
    check('[S11] room expires exactly once after its full waitMinutes elapses', expiredRooms.length === 1 && expiredRooms[0]!.id === created.room.id)
    check('[S12] expired room is removed from the store (getRoomByConnectionId returns null)', store.getRoomByConnectionId('h5') === null)
  } finally {
    restoreRealClock()
  }
}

// ---------------------------------------------------------------------------
// [6] Race conditions
// ---------------------------------------------------------------------------
{
  const clock = installFakeClock()
  try {
    // 6a: expiry racing the final (4th) join — join happens first (Node's
    // single-threaded event loop guarantees synchronous handlers run to
    // completion before a "concurrently due" timer callback), so cancelExpiry
    // has already run by the time the clock would have fired the timer.
    {
      let expiredCount = 0
      let fullCount = 0
      const store = createPrivateRoomsStore({ onRoomsChanged: () => {}, onRoomReady: () => { fullCount++ }, onRoomExpired: () => { expiredCount++ }, onRoomClosed: () => {}, onMemberLeft: () => {} })
      const created = store.createRoom(makeCreateInput({ waitMinutes: 5, connectionId: 'r1' }))
      if (!created.ok) throw new Error('setup failed')
      store.joinTeam(makeJoinInput(created.room.id, 'p2', 'pr2', 'A', 1))
      store.joinTeam(makeJoinInput(created.room.id, 'p3', 'pr3', 'B', 0))
      clock.advanceBy(5 * 60_000 - 1) // 1ms before expiry
      store.joinTeam(makeJoinInput(created.room.id, 'p4', 'pr4', 'B', 1)) // 4th join, right at the edge
      clock.advanceBy(60_000) // push well past the original expiry instant
      check('[R1] expiry-vs-last-join race: room becomes full, never expires (no double outcome)', fullCount === 1 && expiredCount === 0)
    }

    // 6b: expiry racing bot completion — both addBotToTeam calls (one per
    // team, each needing its own human owner) happen before the clock is
    // advanced to the expiry instant, so they win deterministically.
    {
      let expiredCount = 0
      const store = createPrivateRoomsStore({ onRoomsChanged: () => {}, onRoomReady: () => {}, onRoomExpired: () => { expiredCount++ }, onRoomClosed: () => {}, onMemberLeft: () => {} })
      const created = store.createRoom(makeCreateInput({ waitMinutes: 5, connectionId: 'r2' }))
      if (!created.ok) throw new Error('setup failed')
      store.joinTeam(makeJoinInput(created.room.id, 'p2', 'pr2', 'B', 0))
      clock.advanceBy(5 * 60_000 - 1)
      store.addBotToTeam({ connectionId: 'r2', team: 'A', botOccupant: makeBotOccupant('a'), isBlockedWith: noBlocks })
      const secondBotFill = store.addBotToTeam({ connectionId: 'p2', team: 'B', botOccupant: makeBotOccupant('b'), isBlockedWith: noBlocks })
      clock.advanceBy(60_000)
      check('[R2] expiry-vs-bot-completion race: both bot-adds succeed, no expiry fires afterwards', secondBotFill.ok && secondBotFill.readyToStart === true && expiredCount === 0)
    }

    // 6c: an expiry callback firing after the room was already removed by
    // another path must be a no-op (guarded by `if (current)` inside
    // scheduleExpiry) — simulated here by manually closing the room, then
    // forcibly advancing the clock past the original expiry instant; the
    // store's internal guard must prevent a stale fire, which is already
    // covered by [S7], but this additionally checks calling close() again
    // doesn't throw or double-fire.
    {
      let expiredCount = 0
      let closedCount = 0
      const store = createPrivateRoomsStore({ onRoomsChanged: () => {}, onRoomReady: () => {}, onRoomExpired: () => { expiredCount++ }, onRoomClosed: () => { closedCount++ }, onMemberLeft: () => {} })
      const created = store.createRoom(makeCreateInput({ waitMinutes: 5, connectionId: 'r3' }))
      if (!created.ok) throw new Error('setup failed')
      const closeResult = store.closeRoom('r3')
      check('[R3] manual close succeeds', closeResult.ok)
      clock.advanceBy(10 * 60_000)
      check('[R3b] no stale expiry fires after the room was already closed', expiredCount === 0 && closedCount === 1)

      const secondClose = store.closeRoom('r3')
      check('[R3c] closing an already-removed room fails gracefully (no throw, ok:false)', secondClose.ok === false)
    }

    // 6d: a started game (room removed via join-to-full) must never receive
    // an expiry — proven by [R1] above (fullCount===1, expiredCount===0);
    // additionally verify the room is fully gone from the store so nothing
    // downstream could still reference it as "pending".
    {
      const store = createPrivateRoomsStore({ onRoomsChanged: () => {}, onRoomReady: () => {}, onRoomExpired: () => {}, onRoomClosed: () => {}, onMemberLeft: () => {} })
      const created = store.createRoom(makeCreateInput({ waitMinutes: 5, connectionId: 'r4' }))
      if (!created.ok) throw new Error('setup failed')
      store.joinTeam(makeJoinInput(created.room.id, 'p2', 'pr2', 'A', 1))
      store.joinTeam(makeJoinInput(created.room.id, 'p3', 'pr3', 'B', 0))
      store.joinTeam(makeJoinInput(created.room.id, 'p4', 'pr4', 'B', 1))
      check('[R4] a started (room-full) game leaves no trace in the private-rooms store', store.listRooms().length === 0)
    }
  } finally {
    restoreRealClock()
  }
}

console.log('')
console.log(`Passed: ${passed}, Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
