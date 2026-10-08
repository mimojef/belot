// Node-side fixtures за checkReactionCountdownBrowser.ts — строят room
// snapshot-и с РЕАЛНИЯ сървърен код (createServerRoom ->
// initializeRoomAuthoritativeGameState -> advanceRoomAuthoritativeGame ->
// createRoomSnapshotMessage), така че клиентът в браузъра получава точно
// това, което production сървърът би изпратил.

import { createServerRoom } from '../../server/src/core/createServerRoom.js'
import type { Seat, ServerRoom } from '../../server/src/core/serverTypes.js'
import { initializeRoomAuthoritativeGameState } from '../../server/src/game/initializeRoomAuthoritativeGameState.js'
import { advanceRoomAuthoritativeGame } from '../../server/src/game/advanceRoomAuthoritativeGame.js'
import { getRoomAuthoritativeGameState } from '../../server/src/game/getRoomAuthoritativeGameState.js'
import { resumeHumanControlForRoom } from '../../server/src/game/resumeHumanControlForRoom.js'
import { abandonHumanControlForRoom } from '../../server/src/game/abandonHumanControlForRoom.js'
import { syncRoomWithAuthoritativeState } from '../../server/src/game/syncRoomWithAuthoritativeState.js'
import { submitServerBidAction } from '../../server/src/game/submitServerBidAction.js'
import { pickServerBotBidAction } from '../../server/src/game/pickServerBotBidAction.js'
import { pickServerBotPlayCard } from '../../server/src/game/pickServerBotPlayCard.js'
import { submitServerPlayCard } from '../../server/src/game/submitServerPlayCard.js'
import { SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG } from '../../server/src/game/antiBadLuck/serverAntiBadLuckTypes.js'
import type { ServerAuthoritativeGameState } from '../../server/src/game/serverGameTypes.js'
import { createRoomSnapshotMessage } from '../../server/src/protocol/createRoomSnapshotMessage.js'

export type { Seat, ServerRoom }
export type FixturePhase = 'cutting' | 'bidding' | 'playing'

const SEATS: Seat[] = ['bottom', 'right', 'top', 'left']

function humanParticipant(seat: Seat): any {
  return {
    kind: 'human',
    playerId: `player-${seat}`,
    connectionId: `conn-${seat}`,
    isConnected: true,
    joinedAt: 1,
    lastSeenAt: 1,
    reconnectToken: `token-${seat}`,
    permanentlyLeftAt: null,
    identity: {
      accountId: null,
      profileId: `profile-${seat}`,
      username: null,
      displayName: `Играч ${seat}`,
      avatarUrl: null,
      level: 3,
      rankTitle: null,
      skillRating: null,
      gender: 'male',
    },
  }
}

export function stateOf(room: ServerRoom): ServerAuthoritativeGameState {
  const state = getRoomAuthoritativeGameState(room)
  if (state === null) throw new Error('authoritative state missing')
  return state
}

function isPhaseTurnActive(state: ServerAuthoritativeGameState, phase: FixturePhase): boolean {
  if (state.phase !== phase || state.timer.activeSeat === null) return false
  if (phase === 'cutting') return state.round.selectedCutIndex === null
  if (phase === 'bidding') return !state.bidding.hasEnded && state.bidding.currentSeat !== null
  return state.playing?.hasStarted === true && state.playing.currentTurnSeat !== null
}

/**
 * Стая (случайна при humanTurnTimeoutMs=undefined, иначе частна) в дадената
 * фаза, с 4 човека, нито един поет от бот, и ПРЯСНО стартиран човешки таймер
 * за текущия seat (startedAt = реалното Date.now(), чрез реалния
 * resumeHumanControlForRoom — същият път като "Върни се").
 */
export function buildRoomAtPhase(phase: FixturePhase, humanTurnTimeoutMs: number | undefined): ServerRoom {
  const isPrivate = humanTurnTimeoutMs !== undefined
  const base = createServerRoom({
    config: {
      isPrivate,
      isPrivateTableOrigin: isPrivate,
      stakeAmount: 5000,
      ...(isPrivate ? { humanTurnTimeoutMs } : {}),
    },
  })
  const seats = { ...base.seats }
  for (const seat of SEATS) seats[seat] = { ...seats[seat], participant: humanParticipant(seat) }
  let room = initializeRoomAuthoritativeGameState({ ...base, seats })

  // Придвижване с фалшиво време (изтичанията водят до поемане от бот).
  let fakeNow = Date.now()
  for (let i = 0; i < 40_000 && !isPhaseTurnActive(stateOf(room), phase); i += 1) {
    fakeNow += 50
    room = advanceRoomAuthoritativeGame(room, fakeNow, SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG)
  }
  if (!isPhaseTurnActive(stateOf(room), phase)) throw new Error(`could not reach ${phase}`)

  // Връщаме всички под човешки контрол; последен — текущият seat, за да
  // получи пресен пълен таймер спрямо реалния часовник.
  const activeSeat = stateOf(room).timer.activeSeat as Seat
  for (const seat of SEATS) {
    if (seat === activeSeat) continue
    const resumed = resumeHumanControlForRoom(room, seat)
    if (resumed.ok) room = resumed.room
  }
  const resumed = resumeHumanControlForRoom(room, activeSeat)
  if (!resumed.ok) throw new Error(resumed.message)
  return resumed.room
}

export function getActiveSeat(room: ServerRoom): Seat {
  const seat = stateOf(room).timer.activeSeat
  if (seat === null) throw new Error('no active seat')
  return seat
}

// Текущият bidder обявява (валидно действие от реалния bot picker) ->
// сървърът стартира таймер за следващия seat спрямо реалния Date.now().
export function advanceBiddingToNextSeat(room: ServerRoom): ServerRoom {
  const state = stateOf(room)
  const seat = state.bidding.currentSeat as Seat
  const next = submitServerBidAction(state, pickServerBotBidAction(state, seat))
  return syncRoomWithAuthoritativeState(room, next, Date.now())
}

// Текущият играч изиграва валидна карта (реалния bot picker) -> таймер за
// следващия seat. Ползва се само за първата карта на взятка (без trick
// collection delay).
export function advancePlayingToNextSeat(room: ServerRoom): ServerRoom {
  const state = stateOf(room)
  const seat = state.playing?.currentTurnSeat as Seat
  const card = pickServerBotPlayCard(state, seat)
  if (card === null) throw new Error('no card to play')
  const next = submitServerPlayCard(state, seat, card.id)
  return syncRoomWithAuthoritativeState(room, next, Date.now())
}

// "Нов пълен период" за текущия seat от СЕГА (реалният път на "Върни се").
export function restartCurrentTurn(room: ServerRoom): ServerRoom {
  const result = resumeHumanControlForRoom(room, getActiveSeat(room))
  if (!result.ok) throw new Error(result.message)
  return result.room
}

// Текущият seat е поет от бот (същият път като изрично напускане) ->
// таймерът му става 800ms.
export function handCurrentSeatToBot(room: ServerRoom): ServerRoom {
  const result = abandonHumanControlForRoom(room, getActiveSeat(room))
  if (!result.ok) throw new Error(result.message)
  return result.room
}

export function snapshotJson(room: ServerRoom, perspective: Seat): string {
  return JSON.stringify(createRoomSnapshotMessage(room, perspective))
}
