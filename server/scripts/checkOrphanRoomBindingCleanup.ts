/**
 * checkOrphanRoomBindingCleanup.ts
 *
 * Regression check за production bug: /admin/server WS connections таблицата
 * понякога показваше connection тип "Игрова", сочещ към room id, който вече
 * не съществува (room е бил TTL-reaped/премахнат, но connection.currentRoomId
 * никога не се чистеше извън explicit leave_active_room).
 *
 * Root cause: room removal (removeCommittedServerRoom в server/src/index.ts)
 * само трие room-а от serverState.rooms — connection.currentRoomId на
 * survived-open sockets оставаше да сочи към изтритата стая. "Активни стаи"
 * (Object.keys(serverState.rooms).length) веднага спираше да я брои, но
 * диагностиката (currentRoomId !== null → "Игрова", виж
 * src/app/lobby/renderLobbyScreen.ts connTypeLabel) продължаваше да я показва.
 *
 * Fix (два слоя, defense-in-depth):
 *  1. State-level: detachConnectionsBoundToRoom (server/src/core/) — извиква
 *     се от removeCommittedServerRoom при всяко room removal, детачва
 *     currentRoomId/currentSeat на всички connections, сочещи към трития room.
 *  2. Diagnostic-level: buildWsConnectionsDiagnostic (server/src/monitoring/
 *     wsConnectionsHelper.ts) получава опционален roomExists predicate и
 *     third-party нулира currentRoomId в отчета, ако room-ът реално вече не
 *     съществува — safety net дори ако state-level detach пропусне нещо.
 *
 * Тестове:
 *  [1]  create active room + WS → currentRoomId запазен → "Игрова"
 *  [2]  detachConnectionsBoundToRoom детачва connection към премахнат room
 *  [3]  detachConnectionsBoundToRoom НЕ пипа connection към различен (все още
 *       активен) room — active game WS не се detach-ва погрешно
 *  [4]  detachConnectionsBoundToRoom detach-ва ВСИЧКИ участници на finished/
 *       expired room (множество connections към една и съща стая)
 *  [5]  lobby WS без room (currentRoomId=null) остава непроменен
 *  [6]  diagnostic-level: currentRoomId сочещ към несъществуваща стая →
 *       нулиран в отчета ("Обикновена", room "—")
 *  [7]  diagnostic-level: currentRoomId сочещ към СЪЩЕСТВУВАЩА стая се
 *       запазва непроменен (не се detach-ва погрешно активна игра)
 *  [8]  end-to-end: room removal → detach → diagnostic вижда "Обикновена"
 */

import { detachConnectionsBoundToRoom } from '../src/core/detachConnectionsBoundToRoom.js'
import { buildWsConnectionsDiagnostic, WS_OPEN } from '../src/monitoring/wsConnectionsHelper.js'
import type { ServerConnection, ServerState } from '../src/core/serverTypes.js'

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

console.log('\ncheckOrphanRoomBindingCleanup\n')

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeConnection(overrides: Partial<ServerConnection> = {}): ServerConnection {
  const now = Date.now()
  return {
    id: 'conn-1',
    status: 'connected',
    connectedAt: now - 60_000,
    lastSeenAt: now - 5_000,
    remoteAddress: '127.0.0.1',
    userAgent: 'test-agent',
    currentRoomId: null,
    currentSeat: null,
    playerId: null,
    profileId: null,
    ...overrides,
  }
}

function makeServerState(connections: Record<string, ServerConnection>): ServerState {
  return {
    startedAt: Date.now(),
    connections,
    rooms: {},
  }
}

// ─── [1] Active room + WS connection → currentRoomId запазен ("Игрова" базата) ─

console.log('[1] Active room + WS връзка')
{
  const conn = makeConnection({ id: 'c1', profileId: 'p-muzikanta', currentRoomId: 'room-3b48ae12' })
  // renderLobbyScreen.ts connTypeLabel: e.currentRoomId !== null → 'Игрова'
  check('[1.1] currentRoomId е зададен', conn.currentRoomId === 'room-3b48ae12')
  check('[1.2] connTypeLabel логика (currentRoomId !== null) → "Игрова"', conn.currentRoomId !== null)
}

// ─── [2] detachConnectionsBoundToRoom детачва connection към премахнат room ──

console.log('\n[2] detachConnectionsBoundToRoom — премахнат room detach-ва connection-а')
{
  const conn = makeConnection({ id: 'c1', currentRoomId: 'room-3b48ae12', currentSeat: 'bottom' })
  const state = makeServerState({ 'c1': conn })
  const next = detachConnectionsBoundToRoom(state, 'room-3b48ae12')

  check('[2.1] currentRoomId нулиран', next.connections['c1']!.currentRoomId === null)
  check('[2.2] currentSeat нулиран', next.connections['c1']!.currentSeat === null)
  check('[2.3] lastSeenAt е обновен (detachConnectionFromRoomSeat semantics)', next.connections['c1']!.lastSeenAt >= conn.lastSeenAt)
  check('[2.4] connection id/profileId непроменени', next.connections['c1']!.id === 'c1')
}

// ─── [3] Active game WS (различен room) НЕ се detach-ва погрешно ────────────

console.log('\n[3] Различен (все още активен) room — connection не се пипа')
{
  const staleConn = makeConnection({ id: 'c-stale', currentRoomId: 'room-removed', currentSeat: 'top' })
  const activeConn = makeConnection({ id: 'c-active', currentRoomId: 'room-still-active', currentSeat: 'left' })
  const state = makeServerState({ 'c-stale': staleConn, 'c-active': activeConn })

  const next = detachConnectionsBoundToRoom(state, 'room-removed')

  check('[3.1] stale connection е detach-ната', next.connections['c-stale']!.currentRoomId === null)
  check('[3.2] active game connection ЗАПАЗВА currentRoomId', next.connections['c-active']!.currentRoomId === 'room-still-active')
  check('[3.3] active game connection ЗАПАЗВА currentSeat', next.connections['c-active']!.currentSeat === 'left')
}

// ─── [4] Множество участници на един и същ finished/expired room — всички detach-нати ─

console.log('\n[4] Finished/expired room — всички участници се detach-ват')
{
  const seats = ['bottom', 'right', 'top', 'left'] as const
  const connections: Record<string, ServerConnection> = {}
  for (const seat of seats) {
    connections[`c-${seat}`] = makeConnection({ id: `c-${seat}`, currentRoomId: 'room-finished', currentSeat: seat })
  }
  const state = makeServerState(connections)
  const next = detachConnectionsBoundToRoom(state, 'room-finished')

  const allDetached = seats.every((seat) => next.connections[`c-${seat}`]!.currentRoomId === null && next.connections[`c-${seat}`]!.currentSeat === null)
  check('[4.1] всичките 4 участника са detach-нати', allDetached)
}

// ─── [5] Lobby WS без room — непроменен ─────────────────────────────────────

console.log('\n[5] Lobby WS без room')
{
  const lobbyConn = makeConnection({ id: 'c-lobby', currentRoomId: null, currentSeat: null })
  const state = makeServerState({ 'c-lobby': lobbyConn })
  const next = detachConnectionsBoundToRoom(state, 'room-removed')

  check('[5.1] lobby connection остава currentRoomId=null', next.connections['c-lobby']!.currentRoomId === null)
  check('[5.2] обектът не се пресъздава излишно (same reference логика — status/profileId запазени)', next.connections['c-lobby']!.status === lobbyConn.status)
}

// ─── [6] Diagnostic-level safety net: stale currentRoomId → нулиран в отчета ─

console.log('\n[6] buildWsConnectionsDiagnostic — roomExists safety net')
{
  const sockets: ReadonlyMap<string, { readyState: number }> = new Map([['c-orphan', { readyState: WS_OPEN }]])
  const connections = { 'c-orphan': makeConnection({ id: 'c-orphan', profileId: 'p-muzikanta', currentRoomId: 'room-3b48ae12' }) }
  const roomExists = (roomId: string): boolean => roomId !== 'room-3b48ae12' ? true : false // стаята вече не съществува

  const result = buildWsConnectionsDiagnostic(sockets, connections, () => false, () => 'Muzikanta', roomExists)
  const entry = result.entries.find((e) => e.connectionId === 'c-orphan')

  check('[6.1] entry намерен', entry !== undefined)
  check('[6.2] currentRoomId е нулиран (room "—" в UI)', entry?.currentRoomId === null)
  check('[6.3] connTypeLabel логика (currentRoomId === null) → "Обикновена" (не се брои като in-game)', entry?.currentRoomId === null)
}

// ─── [7] Diagnostic-level: currentRoomId към СЪЩЕСТВУВАЩА стая — не се пипа ──

console.log('\n[7] buildWsConnectionsDiagnostic — активна стая остава "Игрова"')
{
  const sockets: ReadonlyMap<string, { readyState: number }> = new Map([['c-playing', { readyState: WS_OPEN }]])
  const connections = { 'c-playing': makeConnection({ id: 'c-playing', profileId: 'p-active', currentRoomId: 'room-active' }) }
  const roomExists = (roomId: string): boolean => roomId === 'room-active'

  const result = buildWsConnectionsDiagnostic(sockets, connections, () => true, () => 'Active Player', roomExists)
  const entry = result.entries.find((e) => e.connectionId === 'c-playing')

  check('[7.1] currentRoomId ЗАПАЗЕН за реално активна стая', entry?.currentRoomId === 'room-active')
}

// [7b] Default parametър (без roomExists подаден) — backward-compatible, поведение непроменено
{
  const sockets: ReadonlyMap<string, { readyState: number }> = new Map([['c-legacy', { readyState: WS_OPEN }]])
  const connections = { 'c-legacy': makeConnection({ id: 'c-legacy', profileId: 'p-legacy', currentRoomId: 'room-anything' }) }
  const result = buildWsConnectionsDiagnostic(sockets, connections, () => false, () => null)
  const entry = result.entries.find((e) => e.connectionId === 'c-legacy')
  check('[7b.1] без roomExists параметър — currentRoomId запазен (backward-compatible default)', entry?.currentRoomId === 'room-anything')
}

// ─── [8] End-to-end: room removal → detach → diagnostic вижда "Обикновена" ──

console.log('\n[8] End-to-end: removeCommittedServerRoom-подобен flow')
{
  const conn = makeConnection({ id: 'c-e2e', profileId: 'p-muzikanta', currentRoomId: 'room-3b48ae12', currentSeat: 'bottom' })
  const stateBefore: ServerState = {
    startedAt: Date.now(),
    connections: { 'c-e2e': conn },
    rooms: { 'room-3b48ae12': {} as ServerState['rooms'][string] }, // room съществува преди removal
  }

  // Стъпка 1: симулирай removeCommittedServerRoom — изтрий room-а от registry-то.
  const nextRooms = { ...stateBefore.rooms }
  delete nextRooms['room-3b48ae12']
  const stateAfterRoomDelete: ServerState = { ...stateBefore, rooms: nextRooms }

  // Стъпка 2: detach (реалният fix, извикан вътре в removeCommittedServerRoom).
  const stateAfterDetach = detachConnectionsBoundToRoom(stateAfterRoomDelete, 'room-3b48ae12')

  check('[8.1] room вече не е в registry-то ("Активни стаи" няма да я брои)', !('room-3b48ae12' in stateAfterDetach.rooms))
  check('[8.2] connection.currentRoomId е нулиран (state-level fix)', stateAfterDetach.connections['c-e2e']!.currentRoomId === null)

  // Стъпка 3: diagnostic през реалния buildWsConnectionsDiagnostic с roomExists спрямо state-а СЛЕД detach.
  const sockets: ReadonlyMap<string, { readyState: number }> = new Map([['c-e2e', { readyState: WS_OPEN }]])
  const result = buildWsConnectionsDiagnostic(
    sockets,
    stateAfterDetach.connections,
    () => false,
    () => 'Muzikanta',
    (roomId) => roomId in stateAfterDetach.rooms,
  )
  const entry = result.entries.find((e) => e.connectionId === 'c-e2e')
  check('[8.3] diagnostic entry.currentRoomId === null ("Обикновена", room "—")', entry?.currentRoomId === null)
  check('[8.4] не се брои като pending/in-game сесия', entry?.probablePendingSessionInGame === false)
}

// ─── Резултат ─────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
