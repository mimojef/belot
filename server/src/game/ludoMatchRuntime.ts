import { randomUUID } from 'node:crypto'
import type { LudoRoom } from './ludoRoomsStore.js'
import { reduceLudoGame } from './ludoEngine/ludoEngineReducer.js'
import { createLudoAuthoritativeInitialState } from './ludoEngine/ludoEngineState.js'
import type { LudoColor, LudoDiceValue, LudoGameState, LudoPieceSlot } from './ludoEngine/ludoEngineTypes.js'
import type { LudoEngineEvent } from './ludoEngine/ludoEngineEvents.js'
import { pickLudoBotMove } from './ludoEngine/ludoBotPolicy.js'

export const LUDO_SERVER_ROLL_TIMEOUT_MS = 10_000
export const LUDO_SERVER_MOVE_TIMEOUT_MS = 15_000
export const LUDO_SERVER_BOT_THINK_DELAY_MS = 700
export const LUDO_FINISHED_MATCH_RETENTION_MS = 10_000

export type LudoMatchPlayer = {
  profileId: string
  displayName: string
  avatarUrl: string | null
  color: LudoColor
  connectionId: string
}

export type LudoMatchSnapshot = {
  matchId: string
  ludoRoomId: string
  stake: number
  revision: number
  serverNow: number
  deadlineAt: number | null
  players: Array<Omit<LudoMatchPlayer, 'connectionId'>>
  state: LudoGameState
  events: readonly LudoEngineEvent[]
  botControlledColors: readonly LudoColor[]
}

export type LudoMatchFailure = {
  ok: false
  code: 'ludo_match_not_found' | 'ludo_match_not_participant' | 'ludo_match_not_turn' | 'ludo_match_stale_action' | 'ludo_match_action_rejected' | 'ludo_match_finished'
  message: string
}

type Match = Omit<LudoMatchSnapshot, 'serverNow' | 'players' | 'events' | 'botControlledColors'> & {
  players: LudoMatchPlayer[]
  lastEvents: readonly LudoEngineEvent[]
  deadlineTimer: ReturnType<typeof setTimeout> | null
  finishedCleanupTimer: ReturnType<typeof setTimeout> | null
  botControlledColors: Set<LudoColor>
  pendingReclaims: Set<LudoColor>
}

type Options = {
  randomDie?: () => LudoDiceValue
  now?: () => number
  initialStateFactory?: (turnOrder: readonly LudoColor[]) => LudoGameState
  finishedMatchRetentionMs?: number
  onSnapshot: (match: LudoMatchSnapshot) => void
}

const ROOM_COLORS: readonly LudoColor[] = ['red', 'blue', 'green', 'yellow']
const CANONICAL_TURN_ORDER: readonly LudoColor[] = ['red', 'blue', 'yellow', 'green']

export function createLudoMatchRuntime(options: Options) {
  const matches = new Map<string, Match>()
  const profileToMatch = new Map<string, string>()
  const now = options.now ?? Date.now
  const finishedMatchRetentionMs = options.finishedMatchRetentionMs ?? LUDO_FINISHED_MATCH_RETENTION_MS
  const randomDie = options.randomDie ?? (() => (Math.floor(Math.random() * 6) + 1) as LudoDiceValue)

  const snapshot = (match: Match, includeEvents = true): LudoMatchSnapshot => ({
    matchId: match.matchId,
    ludoRoomId: match.ludoRoomId,
    stake: match.stake,
    revision: match.revision,
    serverNow: now(),
    deadlineAt: match.deadlineAt,
    players: match.players.map(({ connectionId: _connectionId, ...player }) => player),
    state: match.state,
    events: includeEvents ? match.lastEvents : [],
    botControlledColors: [...match.botControlledColors],
  })

  function scheduleDeadline(match: Match): void {
    if (match.deadlineTimer) clearTimeout(match.deadlineTimer)
    match.deadlineTimer = null
    if (match.state.status === 'finished') {
      match.deadlineAt = null
      return
    }
    if (match.state.turnPhase === 'waiting_for_roll' && match.pendingReclaims.has(match.state.activeColor)) {
      match.pendingReclaims.delete(match.state.activeColor)
      match.botControlledColors.delete(match.state.activeColor)
    }
    const isBotControlled = match.botControlledColors.has(match.state.activeColor)
    const delay = isBotControlled && (match.state.turnPhase === 'waiting_for_roll' || match.state.turnPhase === 'awaiting_move_selection')
      ? LUDO_SERVER_BOT_THINK_DELAY_MS
      : match.state.turnPhase === 'waiting_for_roll'
        ? LUDO_SERVER_ROLL_TIMEOUT_MS
        : match.state.turnPhase === 'awaiting_move_selection'
          ? LUDO_SERVER_MOVE_TIMEOUT_MS
          : null
    match.deadlineAt = delay === null ? null : now() + delay
    if (delay === null) return
    const expectedRevision = match.revision
    match.deadlineTimer = setTimeout(() => {
      if (match.revision !== expectedRevision || match.state.status === 'finished') return
      if (match.state.turnPhase === 'waiting_for_roll') applyRoll(match)
      else if (match.state.turnPhase === 'awaiting_move_selection') {
        const move = pickLudoBotMove(match.state.legalMoves)
        if (move) {
          const takeoverEvents: LudoEngineEvent[] = []
          if (!isBotControlled) {
            match.botControlledColors.add(match.state.activeColor)
            takeoverEvents.push({ type: 'bot_takeover_started', color: match.state.activeColor })
          }
          applyMove(match, move.slot, takeoverEvents)
        }
      }
    }, delay)
    match.deadlineTimer.unref()
  }

  function scheduleFinishedCleanup(match: Match): void {
    if (match.state.status !== 'finished' || match.finishedCleanupTimer) return
    match.finishedCleanupTimer = setTimeout(() => {
      if (matches.get(match.matchId) !== match || match.state.status !== 'finished') return
      matches.delete(match.matchId)
      match.players.forEach((player) => {
        if (profileToMatch.get(player.profileId) === match.matchId) profileToMatch.delete(player.profileId)
      })
      match.finishedCleanupTimer = null
    }, finishedMatchRetentionMs)
    match.finishedCleanupTimer.unref()
  }

  function commit(match: Match, state: LudoGameState, events: readonly LudoEngineEvent[]): void {
    match.state = state
    match.lastEvents = events
    match.revision += 1
    scheduleDeadline(match)
    options.onSnapshot(snapshot(match))
    scheduleFinishedCleanup(match)
  }

  function publishOrchestrationChange(match: Match, events: readonly LudoEngineEvent[]): void {
    match.lastEvents = events
    match.revision += 1
    options.onSnapshot(snapshot(match))
  }

  function advanceCompletedTurn(state: LudoGameState, events: readonly LudoEngineEvent[]): { state: LudoGameState; events: readonly LudoEngineEvent[] } {
    if (state.status === 'finished' || state.turnPhase !== 'turn_complete') return { state, events }
    const advanced = reduceLudoGame(state, { type: 'TURN_ADVANCED', color: state.activeColor, expectedTurnVersion: state.turnVersion })
    return { state: advanced.state, events: [...events, ...advanced.events] }
  }

  function applyRoll(match: Match): boolean {
    const started = reduceLudoGame(match.state, {
      type: 'ROLL_STARTED', color: match.state.activeColor, expectedTurnVersion: match.state.turnVersion,
    })
    if (started.state === match.state) return false
    const resolved = reduceLudoGame(started.state, {
      type: 'ROLL_RESOLVED', color: started.state.activeColor, expectedTurnVersion: started.state.turnVersion, value: randomDie(),
    })
    const final = advanceCompletedTurn(resolved.state, resolved.events)
    commit(match, final.state, final.events)
    return true
  }

  function applyMove(match: Match, slot: LudoPieceSlot, precedingEvents: readonly LudoEngineEvent[] = []): boolean {
    const moved = reduceLudoGame(match.state, {
      type: 'MOVE_REQUESTED', color: match.state.activeColor, expectedTurnVersion: match.state.turnVersion, slot,
    })
    if (moved.state === match.state) return false
    const final = advanceCompletedTurn(moved.state, [...precedingEvents, ...moved.events])
    commit(match, final.state, final.events)
    return true
  }

  function validate(matchId: string, profileId: string, expectedRevision: number): { match: Match; player: LudoMatchPlayer } | LudoMatchFailure {
    const match = matches.get(matchId)
    if (!match) return { ok: false, code: 'ludo_match_not_found', message: 'Ludo играта не беше намерена.' }
    if (match.state.status === 'finished') return { ok: false, code: 'ludo_match_finished', message: 'Ludo играта вече е приключила.' }
    const player = match.players.find((item) => item.profileId === profileId)
    if (!player) return { ok: false, code: 'ludo_match_not_participant', message: 'Не участваш в тази Ludo игра.' }
    if (expectedRevision !== match.revision) return { ok: false, code: 'ludo_match_stale_action', message: 'Играта вече е обновена.' }
    if (player.color !== match.state.activeColor) return { ok: false, code: 'ludo_match_not_turn', message: 'Не е твоят ред.' }
    return { match, player }
  }

  function createMatch(room: LudoRoom): LudoMatchSnapshot {
    const assigned = room.players.map((player, index) => ({ ...player, color: ROOM_COLORS[index]! }))
    const assignedColors = new Set(assigned.map((player) => player.color))
    const turnOrder = CANONICAL_TURN_ORDER.filter((color) => assignedColors.has(color))
    const match: Match = {
      matchId: randomUUID(), ludoRoomId: room.id, stake: room.stake, revision: 0,
      deadlineAt: null, players: assigned, state: options.initialStateFactory?.(turnOrder) ?? createLudoAuthoritativeInitialState(turnOrder),
      lastEvents: [], deadlineTimer: null, finishedCleanupTimer: null,
      botControlledColors: new Set(), pendingReclaims: new Set(),
    }
    matches.set(match.matchId, match)
    assigned.forEach((player) => profileToMatch.set(player.profileId, match.matchId))
    scheduleDeadline(match)
    const initial = snapshot(match, false)
    options.onSnapshot(initial)
    return initial
  }

  return {
    createMatch,
    requestState(profileId: string): LudoMatchSnapshot | null {
      const matchId = profileToMatch.get(profileId)
      const match = matchId ? matches.get(matchId) : null
      return match ? snapshot(match, false) : null
    },
    reconnect(profileId: string, connectionId: string): LudoMatchSnapshot | null {
      const matchId = profileToMatch.get(profileId)
      const match = matchId ? matches.get(matchId) : null
      const player = match?.players.find((item) => item.profileId === profileId)
      if (!match || !player) return null
      player.connectionId = connectionId
      return snapshot(match, false)
    },
    roll(matchId: string, profileId: string, expectedRevision: number): { ok: true } | LudoMatchFailure {
      const validated = validate(matchId, profileId, expectedRevision)
      if ('ok' in validated) return validated
      return applyRoll(validated.match) ? { ok: true } : { ok: false, code: 'ludo_match_action_rejected', message: 'Зарът не може да бъде хвърлен сега.' }
    },
    move(matchId: string, profileId: string, expectedRevision: number, slot: LudoPieceSlot): { ok: true } | LudoMatchFailure {
      const validated = validate(matchId, profileId, expectedRevision)
      if ('ok' in validated) return validated
      return applyMove(validated.match, slot) ? { ok: true } : { ok: false, code: 'ludo_match_action_rejected', message: 'Тази пионка няма валиден ход.' }
    },
    reclaim(matchId: string, profileId: string, expectedRevision: number): { ok: true } | LudoMatchFailure {
      const match = matches.get(matchId)
      if (!match) return { ok: false, code: 'ludo_match_not_found', message: 'Ludo играта не беше намерена.' }
      const player = match.players.find((item) => item.profileId === profileId)
      if (!player) return { ok: false, code: 'ludo_match_not_participant', message: 'Не участваш в тази Ludo игра.' }
      if (expectedRevision !== match.revision) return { ok: false, code: 'ludo_match_stale_action', message: 'Играта вече е обновена.' }
      if (!match.botControlledColors.has(player.color)) return { ok: true }
      if (match.state.activeColor === player.color && match.state.turnPhase !== 'waiting_for_roll') {
        match.pendingReclaims.add(player.color)
        return { ok: true }
      }
      match.botControlledColors.delete(player.color)
      const events: LudoEngineEvent[] = [{ type: 'human_control_resumed', color: player.color }]
      if (match.state.activeColor === player.color) commit(match, match.state, events)
      else publishOrchestrationChange(match, events)
      return { ok: true }
    },
    getMatch: (matchId: string) => matches.get(matchId),
    snapshotForMatch: (matchId: string, includeEvents = false) => {
      const match = matches.get(matchId)
      return match ? snapshot(match, includeEvents) : null
    },
    destroy() {
      matches.forEach((match) => {
        if (match.deadlineTimer) clearTimeout(match.deadlineTimer)
        if (match.finishedCleanupTimer) clearTimeout(match.finishedCleanupTimer)
      })
      matches.clear()
      profileToMatch.clear()
    },
  }
}

export type LudoMatchRuntime = ReturnType<typeof createLudoMatchRuntime>
