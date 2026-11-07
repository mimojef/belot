// Event-driven driver за реален server-authoritative Белот flow (ползва се от
// checkPhysicalShuffle.ts и simulatePhysicalShuffle.ts). Прескача директно до
// следващия timer/auto-advance; човешките места изчакват timeout → bot
// takeover (както в production), ботовете играят с production логиката.

import type { ServerRoom } from '../../src/core/serverTypes.js'
import { addBotToRoom } from '../../src/core/addBotToRoom.js'
import { addHumanToRoom } from '../../src/core/addHumanToRoom.js'
import { createRoomWithHumanHost } from '../../src/core/createRoomWithHumanHost.js'
import type { ServerAntiBadLuckConfig } from '../../src/game/antiBadLuck/serverAntiBadLuckTypes.js'
import { advanceRoomAuthoritativeGame } from '../../src/game/advanceRoomAuthoritativeGame.js'
import { getRoomAuthoritativeGameState } from '../../src/game/getRoomAuthoritativeGameState.js'
import { getServerPhaseAutoAdvanceExpiry } from '../../src/game/getServerPhaseAutoAdvanceExpiry.js'
import { getServerTimerExpiry } from '../../src/game/getServerTimerExpiry.js'
import { initializeRoomAuthoritativeGameState } from '../../src/game/initializeRoomAuthoritativeGameState.js'
import { syncRoomWithAuthoritativeState } from '../../src/game/syncRoomWithAuthoritativeState.js'
import type { ServerAuthoritativeGameState, ServerCard } from '../../src/game/serverGameTypes.js'

export function isRotationOf(source: readonly ServerCard[], target: readonly ServerCard[]): boolean {
  if (source.length !== target.length) return false
  const offset = source.findIndex((card) => card.id === target[0]?.id)
  if (offset < 0) return false
  return target.every((card, index) => card.id === source[(index + offset) % source.length]!.id)
}

// Брой наредени двойки (a, b), съседни в source, които остават съседни (a
// непосредствено над b) в target. Пълно случайно разбъркване: очаквано
// (n−1)/n ≈ 0.97 от 31 двойки.
export function preservedAdjacentPairs(source: readonly ServerCard[], target: readonly ServerCard[]): number {
  const position = new Map(target.map((card, index) => [card.id, index]))
  let count = 0
  for (let index = 0; index + 1 < source.length; index += 1) {
    if (position.get(source[index + 1]!.id) === position.get(source[index]!.id)! + 1) count += 1
  }
  return count
}

export type Driven = { room: ServerRoom; now: number }

let roomCounter = 0

export function buildRealisticRoom(prefix = 'round-driver'): ServerRoom {
  roomCounter += 1
  const id = `${prefix}-${roomCounter}`
  const { room: r1 } = createRoomWithHumanHost({ roomId: id, connectionId: `conn-${id}-1`, identity: { displayName: 'Player 1' } })
  const { room: r2 } = addHumanToRoom(r1, { connectionId: `conn-${id}-2`, identity: { displayName: 'Player 2' } })
  const { room: r3 } = addBotToRoom(r2, { difficulty: 'normal', behaviorPreset: 'balanced', identity: { displayName: 'Bot 3' } })
  const { room: r4 } = addBotToRoom(r3, { difficulty: 'normal', behaviorPreset: 'balanced', identity: { displayName: 'Bot 4' } })
  return initializeRoomAuthoritativeGameState(r4)
}

export const auth = (room: ServerRoom): ServerAuthoritativeGameState => getRoomAuthoritativeGameState(room)!

export const withState = (room: ServerRoom, state: ServerAuthoritativeGameState): ServerRoom =>
  syncRoomWithAuthoritativeState(room, state)

export function driveUntil(
  start: Driven,
  config: ServerAntiBadLuckConfig,
  predicate: (state: ServerAuthoritativeGameState) => boolean,
  maxSteps = 4000,
): Driven {
  let { room, now } = start
  for (let step = 0; step < maxSteps; step += 1) {
    const state = auth(room)
    if (predicate(state)) return { room, now }
    if (state.phase === 'match-ended') throw new Error('match ended before predicate')
    const expiries = [getServerTimerExpiry(state), getServerPhaseAutoAdvanceExpiry(state)].filter((value): value is number => value !== null)
    const cutPending = state.phase === 'cutting' && state.round.selectedCutIndex !== null
    now = cutPending || expiries.length === 0 ? now + 1 : Math.max(now, Math.min(...expiries))
    room = advanceRoomAuthoritativeGame(room, now, config)
  }
  throw new Error(`driveUntil: predicate not reached (phase=${auth(room).phase})`)
}

export const isNewRoundCutting = (previousDealer: string | null) => (state: ServerAuthoritativeGameState) =>
  state.phase === 'cutting' && state.round.selectedCutIndex === null && state.round.dealerSeat !== previousDealer

// Нов мач → спира в cutting на първото раздаване.
export function startMatch(config: ServerAntiBadLuckConfig, prefix?: string): Driven {
  return driveUntil({ room: buildRealisticRoom(prefix), now: Date.now() }, config, (state) => state.phase === 'cutting')
}

// Изиграва текущото раздаване до scoring или next-round (всички пас).
export function playRoundToEnd(start: Driven, config: ServerAntiBadLuckConfig): Driven {
  return driveUntil(start, config, (state) => state.phase === 'scoring' || state.phase === 'next-round')
}
