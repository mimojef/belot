/**
 * checkBelotSpectatorRegistry.ts
 *
 * Unit regression за Belot Spectator Mode Phase 2A — registry, watch
 * authorization и централния spectator fan-out. Pure (без spawn-нат сървър).
 *
 * Покрива:
 *   [R1]  watch/unwatch: connection->room + reverse index атомарно
 *   [R2]  една connection гледа максимум една маса (watch на друга премества)
 *   [R3]  повторен watch на същата маса е idempotent
 *   [R4]  removeRoom чисти всички spectators на стаята и само тях
 *   [R5]  isProfileSpectatingBelot е profile-level (multi-tab), resolve-ва
 *         profileId live (няма втори profile source of truth)
 *   [E1]  feature flag OFF -> feature_disabled (дори за иначе валиден watch,
 *         дори с active VIP — VIP gate-ът никога не се достига)
 *   [E2]  валидна private playing маса + active VIP -> ok
 *   [E3]  неактивна connection / без профил -> deny
 *   [E4]  несъществуваща / tournament / guest / matchmaking / finished маса -> deny
 *   [E5]  participant (вкл. permanently-left) -> deny
 *   [E6]  active game commitment / connection.currentRoomId -> deny
 *   [E7]  Ludo spectator -> deny (взаимно изключване)
 *   [E8]  профилът вече гледа ДРУГА маса -> deny; СЪЩАТА -> ok
 *   [E9]  eligibility не мутира подадените обекти
 *   [V1]  Phase 2C: без active VIP -> vip_required, преди room проверките
 *   [V2]  изтекъл VIP (isActive=false) -> vip_required
 *   [V3]  VIP gate-ът се проверява СЛЕД not_authenticated, но ПРЕДИ
 *         room_not_found/room_not_watchable/participant/commitment
 *   [V4]  evaluateVipSpectatorGateEligibility: pure, само isActive решава
 *   [F1]  fan-out без spectators -> нищо не се строи/сериализира
 *   [F2]  fan-out: payload се сериализира ВЕДНЪЖ за N spectators, идентичен низ
 *   [F3]  fan-out: connection, станала participant -> evict + belot_spectate_ended
 *   [F4]  fan-out: изчезнала connection -> evict; затворен socket -> skip
 *   [F5]  broadcastRoomSnapshots вика spectator hook-а СЛЕД player snapshot-ите,
 *         без да променя player payload-ите; hook грешка не чупи broadcast-а
 *   [F6]  feature flag env: OFF по подразбиране, ON само при "1"
 */

import { WebSocket } from 'ws'

const { createBelotSpectatorRegistry, isProfileSpectatingBelot, findProfileSpectatorConnectionIds } = await import(
  '../src/core/belotSpectatorRegistry.js'
)
const { evaluateBelotSpectatorWatchEligibility } = await import('../src/core/evaluateBelotSpectatorWatchEligibility.js')
const { evaluateVipSpectatorGateEligibility } = await import('../src/core/evaluateVipSpectatorGateEligibility.js')
const { broadcastBelotSpectatorSnapshot } = await import('../src/core/broadcastBelotSpectatorSnapshot.js')
const { broadcastRoomSnapshots, setBroadcastRoomSnapshotsSpectatorHook } = await import('../src/core/broadcastRoomSnapshots.js')
const { isBelotSpectatorFeatureEnabled } = await import('../src/core/belotSpectatorFeatureFlag.js')

let passed = 0
let failed = 0
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ok ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('\n═══ checkBelotSpectatorRegistry ═══')

type Seat = 'bottom' | 'right' | 'top' | 'left'
const SEATS: Seat[] = ['bottom', 'right', 'top', 'left']

function connection(id: string, profileId: string | null, overrides: Record<string, unknown> = {}): any {
  return {
    id,
    status: 'connected',
    connectedAt: 1,
    lastSeenAt: 1,
    remoteAddress: null,
    userAgent: null,
    currentRoomId: null,
    currentSeat: null,
    playerId: null,
    profileId,
    sessionId: null,
    ...overrides,
  }
}

function human(seat: Seat, profileId: string, overrides: Record<string, unknown> = {}): any {
  return {
    kind: 'human',
    playerId: `player-${seat}`,
    connectionId: `conn-player-${seat}`,
    isConnected: true,
    joinedAt: 1,
    lastSeenAt: 1,
    reconnectToken: `token-${seat}`,
    permanentlyLeftAt: null,
    identity: {
      accountId: null,
      profileId,
      username: null,
      displayName: `P ${seat}`,
      avatarUrl: null,
      level: 1,
      rankTitle: null,
      skillRating: null,
      gender: null,
    },
    ...overrides,
  }
}

function playingAuthoritativeState(): any {
  return {
    phase: 'bidding',
    phaseEnteredAt: 1,
    targetScore: 151,
    players: Object.fromEntries(SEATS.map((s) => [s, { seat: s, team: s === 'bottom' || s === 'top' ? 'A' : 'B', mode: 'human', controlledByBot: false }])),
    round: { dealerSeat: 'bottom', cutterSeat: 'left', firstBidderSeat: 'right', firstDealSeat: 'right', selectedCutIndex: 3 },
    deck: [],
    hands: { bottom: [], right: [], top: [], left: [] },
    bidding: { entries: [], currentSeat: 'right', winningBid: null, hasStarted: true, hasEnded: false, consecutivePasses: 0 },
    declarations: [],
    matchDeclarationMissionCounts: {},
    matchDeclarationMissionCountsBySeat: {},
    currentTrick: { leaderSeat: null, currentSeat: null, plays: [], winnerSeat: null, trickIndex: 0 },
    wonTricks: { A: [], B: [] },
    playing: null,
    scoring: null,
    matchEnded: null,
    score: { round: {}, match: { teamA: 0, teamB: 0 }, carryOver: { teamA: 0, teamB: 0 } },
    timer: { activeSeat: null, startedAt: null, durationMs: null, expiresAt: null },
  }
}

function room(id: string, configOverrides: Record<string, unknown> = {}, roomOverrides: Record<string, unknown> = {}): any {
  return {
    id,
    status: 'playing',
    createdAt: 1,
    updatedAt: 1,
    hostPlayerId: null,
    config: {
      maxPlayers: 4,
      allowBots: true,
      isPrivate: true,
      joinCode: null,
      stakeAmount: 5000,
      targetScore: 151,
      turnTimeMs: 15000,
      reconnectGraceMs: 60000,
      isPrivateTableOrigin: true,
      ...configOverrides,
    },
    seats: {
      bottom: { seat: 'bottom', team: 'A', participant: human('bottom', 'profile-player-bottom') },
      right: { seat: 'right', team: 'B', participant: human('right', 'profile-player-right') },
      top: { seat: 'top', team: 'A', participant: human('top', 'profile-player-top') },
      left: { seat: 'left', team: 'B', participant: human('left', 'profile-player-left') },
    },
    game: { phase: 'bidding', stateVersion: 1, startedAt: 1, updatedAt: 1, activeTimerId: null, timerDeadlineAt: null, authoritativeState: playingAuthoritativeState() },
    replayVotes: [],
    leaveVotes: [],
    ...roomOverrides,
  }
}

function baseEligibilityInput(overrides: Record<string, unknown> = {}): any {
  return {
    featureEnabled: true,
    connection: connection('conn-spectator', 'profile-spectator'),
    room: room('room-1'),
    // Phase 2C: default fixture профил е active VIP, за да изолираме
    // room/participant/commitment тестовете (E2-E9) от VIP gate-а — VIP-
    // specific поведение се тества отделно по-долу (V1-V4).
    vipStatus: { isActive: true },
    profileHasActiveGameCommitment: false,
    profileIsLudoSpectating: false,
    profileWatchedRoomIds: [],
    ...overrides,
  }
}

// ─── Registry ─────────────────────────────────────────────────────────────

await check('[R1] watch/unwatch keep connection->room and reverse index in sync', () => {
  const registry = createBelotSpectatorRegistry()
  assert(registry.watch('c1', 'room-1') === null, 'first watch has no previous room')
  registry.watch('c2', 'room-1')
  assert(registry.getWatchedRoomId('c1') === 'room-1', 'c1 watches room-1')
  assert(JSON.stringify(registry.listSpectatorConnectionIds('room-1').sort()) === JSON.stringify(['c1', 'c2']), 'reverse index has both')
  assert(registry.unwatch('c1') === 'room-1', 'unwatch returns the room')
  assert(registry.unwatch('c1') === null, 'second unwatch is a no-op')
  assert(JSON.stringify(registry.listSpectatorConnectionIds('room-1')) === JSON.stringify(['c2']), 'reverse index updated')
  registry.unwatch('c2')
  assert(registry.size() === 0 && registry.listSpectatorConnectionIds('room-1').length === 0, 'fully empty after cleanup')
})

await check('[R2] one connection watches at most one room (watching another moves it atomically)', () => {
  const registry = createBelotSpectatorRegistry()
  registry.watch('c1', 'room-1')
  assert(registry.watch('c1', 'room-2') === 'room-1', 'returns previous room')
  assert(registry.listSpectatorConnectionIds('room-1').length === 0, 'removed from room-1 index')
  assert(JSON.stringify(registry.listSpectatorConnectionIds('room-2')) === JSON.stringify(['c1']), 'present in room-2 index')
  assert(registry.size() === 1, 'still a single subscription')
})

await check('[R3] repeated watch of the same room is idempotent', () => {
  const registry = createBelotSpectatorRegistry()
  registry.watch('c1', 'room-1')
  assert(registry.watch('c1', 'room-1') === 'room-1', 'same room returned')
  assert(registry.size() === 1 && registry.listSpectatorConnectionIds('room-1').length === 1, 'no duplicate entries')
})

await check('[R4] removeRoom clears all spectators of that room and only them', () => {
  const registry = createBelotSpectatorRegistry()
  registry.watch('c1', 'room-1')
  registry.watch('c2', 'room-1')
  registry.watch('c3', 'room-2')
  const removed = registry.removeRoom('room-1').sort()
  assert(JSON.stringify(removed) === JSON.stringify(['c1', 'c2']), `removed=${JSON.stringify(removed)}`)
  assert(!registry.isConnectionSpectating('c1') && !registry.isConnectionSpectating('c2'), 'room-1 spectators gone')
  assert(registry.getWatchedRoomId('c3') === 'room-2', 'other room untouched')
  assert(registry.removeRoom('room-1').length === 0, 'second removeRoom is a no-op')
})

await check('[R5] profile-level spectating resolves profileId live (multi-tab, no second source of truth)', () => {
  const registry = createBelotSpectatorRegistry()
  const profileByConnection = new Map<string, string | null>([['tab-1', 'profile-x'], ['tab-2', 'profile-x'], ['other', 'profile-y']])
  const resolve = (id: string) => profileByConnection.get(id) ?? null
  assert(!isProfileSpectatingBelot(registry, 'profile-x', resolve), 'not spectating initially')
  registry.watch('tab-2', 'room-1')
  assert(isProfileSpectatingBelot(registry, 'profile-x', resolve), 'any tab of the profile counts')
  assert(!isProfileSpectatingBelot(registry, 'profile-y', resolve), 'other profile unaffected')
  assert(!isProfileSpectatingBelot(registry, null, resolve), 'null profile is never spectating')
  assert(JSON.stringify(findProfileSpectatorConnectionIds(registry, 'profile-x', resolve)) === JSON.stringify(['tab-2']), 'finds the spectating tab')
  profileByConnection.delete('tab-2') // connection gone from connection registry
  assert(!isProfileSpectatingBelot(registry, 'profile-x', resolve), 'live resolution: vanished connection no longer maps to the profile')
})

// ─── Eligibility ──────────────────────────────────────────────────────────

await check('[E1] feature flag OFF -> feature_disabled even for an otherwise valid watch', () => {
  const result = evaluateBelotSpectatorWatchEligibility(baseEligibilityInput({ featureEnabled: false }))
  assert(!result.ok && result.code === 'feature_disabled', JSON.stringify(result))
})

await check('[E2] valid private playing room -> ok', () => {
  const result = evaluateBelotSpectatorWatchEligibility(baseEligibilityInput())
  assert(result.ok && result.profileId === 'profile-spectator', JSON.stringify(result))
})

await check('[E3] inactive connection / unauthenticated -> deny', () => {
  const inactive = evaluateBelotSpectatorWatchEligibility(baseEligibilityInput({ connection: connection('c', 'p', { status: 'disconnected' }) }))
  assert(!inactive.ok && inactive.code === 'connection_inactive', JSON.stringify(inactive))
  const missing = evaluateBelotSpectatorWatchEligibility(baseEligibilityInput({ connection: null }))
  assert(!missing.ok && missing.code === 'connection_inactive', JSON.stringify(missing))
  const guest = evaluateBelotSpectatorWatchEligibility(baseEligibilityInput({ connection: connection('c', null) }))
  assert(!guest.ok && guest.code === 'not_authenticated', JSON.stringify(guest))
})

await check('[E4] missing / tournament / guest / matchmaking / waiting / finished rooms -> deny', () => {
  const cases: Array<[string, any, string]> = [
    ['missing', null, 'room_not_found'],
    ['tournament', room('r', { isTournamentMatchOrigin: true }), 'room_not_watchable'],
    ['guest trial', room('r', { isGuestTrial: true }), 'room_not_watchable'],
    ['public matchmaking', room('r', { isPrivateTableOrigin: false }), 'room_not_watchable'],
    ['waiting', room('r', {}, { status: 'waiting' }), 'room_not_watchable'],
    ['finished', room('r', {}, { status: 'finished' }), 'room_not_watchable'],
  ]
  const ended = room('r')
  ended.game.authoritativeState.matchEnded = { winnerTeam: 'A', targetScore: 151, finalScore: { teamA: 151, teamB: 0 }, endedAt: 1 }
  cases.push(['match ended', ended, 'room_not_watchable'])
  const bootstrap = room('r')
  bootstrap.game.authoritativeState = { kind: 'bootstrap' }
  cases.push(['bootstrap state', bootstrap, 'room_not_watchable'])
  for (const [label, candidate, code] of cases) {
    const result = evaluateBelotSpectatorWatchEligibility(baseEligibilityInput({ room: candidate }))
    assert(!result.ok && result.code === code, `${label}: ${JSON.stringify(result)}`)
  }
})

await check('[E5] room participant (incl. permanently-left) -> participant', () => {
  const asParticipant = evaluateBelotSpectatorWatchEligibility(
    baseEligibilityInput({ connection: connection('c', 'profile-player-top') }),
  )
  assert(!asParticipant.ok && asParticipant.code === 'participant', JSON.stringify(asParticipant))
  const leftRoom = room('r')
  leftRoom.seats.right.participant = human('right', 'profile-left-earlier', { permanentlyLeftAt: 5 })
  const asLeft = evaluateBelotSpectatorWatchEligibility(
    baseEligibilityInput({ room: leftRoom, connection: connection('c', 'profile-left-earlier') }),
  )
  assert(!asLeft.ok && asLeft.code === 'participant', JSON.stringify(asLeft))
})

await check('[E6] active game commitment or attached connection -> active_game_commitment', () => {
  const committed = evaluateBelotSpectatorWatchEligibility(baseEligibilityInput({ profileHasActiveGameCommitment: true }))
  assert(!committed.ok && committed.code === 'active_game_commitment', JSON.stringify(committed))
  const attached = evaluateBelotSpectatorWatchEligibility(
    baseEligibilityInput({ connection: connection('c', 'profile-spectator', { currentRoomId: 'room-x', currentSeat: 'top' }) }),
  )
  assert(!attached.ok && attached.code === 'active_game_commitment', JSON.stringify(attached))
})

await check('[E7] Ludo spectator -> ludo_spectating (mutual exclusion)', () => {
  const result = evaluateBelotSpectatorWatchEligibility(baseEligibilityInput({ profileIsLudoSpectating: true }))
  assert(!result.ok && result.code === 'ludo_spectating', JSON.stringify(result))
})

await check('[E8] profile already watching ANOTHER room -> deny; SAME room -> ok', () => {
  const other = evaluateBelotSpectatorWatchEligibility(baseEligibilityInput({ profileWatchedRoomIds: ['room-2'] }))
  assert(!other.ok && other.code === 'already_watching_other_room', JSON.stringify(other))
  const same = evaluateBelotSpectatorWatchEligibility(baseEligibilityInput({ profileWatchedRoomIds: ['room-1'] }))
  assert(same.ok, JSON.stringify(same))
})

await check('[E9] eligibility evaluation never mutates its inputs', () => {
  const input = baseEligibilityInput({ profileHasActiveGameCommitment: true })
  const before = JSON.stringify(input)
  evaluateBelotSpectatorWatchEligibility(input)
  evaluateBelotSpectatorWatchEligibility(baseEligibilityInput())
  assert(JSON.stringify(input) === before, 'input must be unchanged')
})

// ─── VIP gate (Phase 2C) ────────────────────────────────────────────────────

await check('[V1] no active VIP -> vip_required, no role bypass encoded in the gate', () => {
  const result = evaluateBelotSpectatorWatchEligibility(baseEligibilityInput({ vipStatus: { isActive: false } }))
  assert(!result.ok && result.code === 'vip_required', JSON.stringify(result))
})

await check('[V2] expired VIP (isActive=false) -> vip_required, identical to never having VIP', () => {
  const result = evaluateBelotSpectatorWatchEligibility(baseEligibilityInput({ vipStatus: { isActive: false } }))
  assert(!result.ok && result.code === 'vip_required', JSON.stringify(result))
})

await check('[V3] VIP gate runs after not_authenticated but before room/participant/commitment checks', () => {
  // Guest (no profileId) -> not_authenticated wins even without VIP info mattering.
  const guest = evaluateBelotSpectatorWatchEligibility(
    baseEligibilityInput({ connection: connection('c', null), vipStatus: { isActive: false } }),
  )
  assert(!guest.ok && guest.code === 'not_authenticated', JSON.stringify(guest))

  // Authenticated, no VIP, room missing/not watchable/participant/committed —
  // vip_required must win over ALL of those, proving the gate is checked first.
  const missingRoom = evaluateBelotSpectatorWatchEligibility(
    baseEligibilityInput({ room: null, vipStatus: { isActive: false } }),
  )
  assert(!missingRoom.ok && missingRoom.code === 'vip_required', JSON.stringify(missingRoom))

  const participantNoVip = evaluateBelotSpectatorWatchEligibility(
    baseEligibilityInput({ connection: connection('c', 'profile-player-top'), vipStatus: { isActive: false } }),
  )
  assert(!participantNoVip.ok && participantNoVip.code === 'vip_required', JSON.stringify(participantNoVip))

  const committedNoVip = evaluateBelotSpectatorWatchEligibility(
    baseEligibilityInput({ profileHasActiveGameCommitment: true, vipStatus: { isActive: false } }),
  )
  assert(!committedNoVip.ok && committedNoVip.code === 'vip_required', JSON.stringify(committedNoVip))

  // flag OFF + no VIP -> feature_disabled still wins (flag check is first of all).
  const flagOff = evaluateBelotSpectatorWatchEligibility(
    baseEligibilityInput({ featureEnabled: false, vipStatus: { isActive: false } }),
  )
  assert(!flagOff.ok && flagOff.code === 'feature_disabled', JSON.stringify(flagOff))
})

await check('[V4] evaluateVipSpectatorGateEligibility: pure, decided only by isActive', () => {
  const allowed = evaluateVipSpectatorGateEligibility({ vipStatus: { isActive: true } })
  assert(allowed.ok, JSON.stringify(allowed))
  const denied = evaluateVipSpectatorGateEligibility({ vipStatus: { isActive: false } })
  assert(!denied.ok && denied.code === 'vip_required', JSON.stringify(denied))
})

// ─── Fan-out ──────────────────────────────────────────────────────────────

type FakeSocket = { readyState: number; sent: string[]; send: (data: string) => void }
function fakeSocket(readyState: number = WebSocket.OPEN): FakeSocket {
  const socket: FakeSocket = { readyState, sent: [], send: (data: string) => { socket.sent.push(data) } }
  return socket
}

function countSpectatorStringify<T>(fn: () => T): { result: T; count: number } {
  const original = JSON.stringify
  let count = 0
  ;(JSON as any).stringify = (value: any, ...rest: any[]) => {
    if (value !== null && typeof value === 'object' && value.type === 'belot_spectator_snapshot') count += 1
    return (original as any)(value, ...rest)
  }
  try {
    return { result: fn(), count }
  } finally {
    ;(JSON as any).stringify = original
  }
}

await check('[F1] fan-out with no spectators builds/serializes nothing', () => {
  const registry = createBelotSpectatorRegistry()
  const { result, count } = countSpectatorStringify(() =>
    broadcastBelotSpectatorSnapshot({ room: room('room-1'), registry, getConnection: () => null, getSocket: () => null }),
  )
  assert(result === 0 && count === 0, `sent=${result} stringify=${count}`)
})

await check('[F2] payload serialized ONCE for N spectators, identical string to each', () => {
  const registry = createBelotSpectatorRegistry()
  const sockets = new Map<string, FakeSocket>()
  const connections = new Map<string, any>()
  for (let i = 0; i < 5; i += 1) {
    const id = `spec-${i}`
    registry.watch(id, 'room-1')
    sockets.set(id, fakeSocket())
    connections.set(id, connection(id, `profile-spec-${i}`))
  }
  const { result, count } = countSpectatorStringify(() =>
    broadcastBelotSpectatorSnapshot({
      room: room('room-1'),
      registry,
      getConnection: (id) => connections.get(id) ?? null,
      getSocket: (id) => (sockets.get(id) as any) ?? null,
    }),
  )
  assert(result === 5, `expected 5 sends, got ${result}`)
  assert(count === 1, `expected exactly 1 serialization, got ${count}`)
  const payloads = [...sockets.values()].map((s) => s.sent[0])
  assert(payloads.every((p) => p === payloads[0]), 'all spectators receive the identical payload')
  const parsed = JSON.parse(payloads[0]!)
  assert(parsed.type === 'belot_spectator_snapshot' && parsed.yourSeat === null, 'payload is the spectator snapshot')
})

await check('[F3] a spectator connection that became a participant is evicted with belot_spectate_ended', () => {
  const registry = createBelotSpectatorRegistry()
  registry.watch('spec-attached', 'room-1')
  registry.watch('spec-seated-profile', 'room-1')
  const sockets = { 'spec-attached': fakeSocket(), 'spec-seated-profile': fakeSocket() } as Record<string, FakeSocket>
  const connections: Record<string, any> = {
    'spec-attached': connection('spec-attached', 'profile-a', { currentRoomId: 'other-room', currentSeat: 'top' }),
    // профилът седи в самата стая (напр. през друг път) -> не може да е spectator
    'spec-seated-profile': connection('spec-seated-profile', 'profile-player-left'),
  }
  const sent = broadcastBelotSpectatorSnapshot({
    room: room('room-1'),
    registry,
    getConnection: (id) => connections[id] ?? null,
    getSocket: (id) => (sockets[id] as any) ?? null,
  })
  assert(sent === 0, 'no spectator snapshot may be sent to a participant')
  for (const id of Object.keys(sockets)) {
    assert(!registry.isConnectionSpectating(id), `${id} must be evicted`)
    const frames = sockets[id]!.sent.map((s) => JSON.parse(s))
    assert(frames.length === 1 && frames[0].type === 'belot_spectate_ended' && frames[0].reason === 'game_commitment', `${id} frames=${JSON.stringify(frames)}`)
  }
})

await check('[F4] vanished connection evicted; closed socket skipped without error', () => {
  const registry = createBelotSpectatorRegistry()
  registry.watch('gone', 'room-1')
  registry.watch('closed', 'room-1')
  const closedSocket = fakeSocket(WebSocket.CLOSED)
  const sent = broadcastBelotSpectatorSnapshot({
    room: room('room-1'),
    registry,
    getConnection: (id) => (id === 'closed' ? connection('closed', 'p') : null),
    getSocket: (id) => (id === 'closed' ? (closedSocket as any) : null),
  })
  assert(sent === 0, 'nothing sent')
  assert(!registry.isConnectionSpectating('gone'), 'vanished connection evicted')
  assert(closedSocket.sent.length === 0, 'closed socket not written to')
})

await check('[F5] broadcastRoomSnapshots: spectator hook runs after player snapshots, player payloads unchanged, hook errors isolated', () => {
  const testRoom = room('room-hook')
  const playerSockets = new Map<string, FakeSocket>()
  for (const seat of SEATS) playerSockets.set(`conn-player-${seat}`, fakeSocket())
  const order: string[] = []
  for (const [id, socket] of playerSockets) {
    const originalSend = socket.send
    socket.send = (data: string) => { order.push(`player:${id}`); originalSend(data) }
  }

  // Без hook — baseline player payloads.
  setBroadcastRoomSnapshotsSpectatorHook(null)
  broadcastRoomSnapshots(testRoom, playerSockets as any)
  const baseline = [...playerSockets.values()].map((s) => JSON.parse(s.sent.pop()!))

  order.length = 0
  setBroadcastRoomSnapshotsSpectatorHook(() => { order.push('spectator-hook') })
  broadcastRoomSnapshots(testRoom, playerSockets as any)
  const withHook = [...playerSockets.values()].map((s) => JSON.parse(s.sent.pop()!))
  assert(order[order.length - 1] === 'spectator-hook' && order.filter((o) => o === 'spectator-hook').length === 1, `order=${JSON.stringify(order)}`)
  assert(order.slice(0, 4).every((o) => o.startsWith('player:')), 'players served first')
  assert(JSON.stringify(baseline) === JSON.stringify(withHook), 'player snapshots must be byte-identical with the hook installed')
  assert(withHook.every((frame) => frame.type === 'room_snapshot' && frame.yourSeat !== null), 'players still get seat-personalized room_snapshot')

  setBroadcastRoomSnapshotsSpectatorHook(() => { throw new Error('boom') })
  const originalError = console.error
  console.error = () => {}
  try {
    broadcastRoomSnapshots(testRoom, playerSockets as any) // must not throw
  } finally {
    console.error = originalError
    setBroadcastRoomSnapshotsSpectatorHook(null)
  }
  assert([...playerSockets.values()].every((s) => s.sent.length === 1), 'players still served when the hook throws')
})

await check('[F6] feature flag env: OFF by default, ON only for exactly "1"', () => {
  const original = process.env.BELOT_SPECTATOR_ENABLED
  try {
    delete process.env.BELOT_SPECTATOR_ENABLED
    assert(isBelotSpectatorFeatureEnabled() === false, 'default OFF')
    for (const value of ['0', 'true', 'yes', '', ' 1']) {
      process.env.BELOT_SPECTATOR_ENABLED = value
      assert(isBelotSpectatorFeatureEnabled() === false, `"${value}" must be OFF`)
    }
    process.env.BELOT_SPECTATOR_ENABLED = '1'
    assert(isBelotSpectatorFeatureEnabled() === true, '"1" is ON')
  } finally {
    if (original === undefined) delete process.env.BELOT_SPECTATOR_ENABLED
    else process.env.BELOT_SPECTATOR_ENABLED = original
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
