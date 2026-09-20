import { randomInt } from 'node:crypto'
import type { LudoRoom } from './ludoRoomsStore.js'
import { reduceLudoGame } from './ludoEngine/ludoEngineReducer.js'
import { createLudoAuthoritativeInitialState } from './ludoEngine/ludoEngineState.js'
import type { LudoColor, LudoDiceValue, LudoGameState, LudoPieceSlot } from './ludoEngine/ludoEngineTypes.js'
import type { LudoEngineEvent } from './ludoEngine/ludoEngineEvents.js'
import { pickLudoBotMove } from './ludoEngine/ludoBotPolicy.js'

export const LUDO_SERVER_ROLL_TIMEOUT_MS = 10_000
export const LUDO_SERVER_MOVE_TIMEOUT_MS = 15_000
export const LUDO_SERVER_BOT_THINK_DELAY_MS = 1_500
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
  code: 'ludo_match_not_found' | 'ludo_match_not_participant' | 'ludo_match_not_turn' | 'ludo_match_stale_action' | 'ludo_match_action_rejected' | 'ludo_match_finished' | 'ludo_match_leave_unsupported'
  message: string
}

// Резултат от computeInitialMatchData — цвят assignment (2-player рандом
// избор чрез randomTwoPlayerCreatorColor) + initial engine state, изчислени
// ЧИСТО (без никаква мутация на runtime state). Изложено публично като
// buildInitialMatch() (виж task spec §3 "КРИТИЧЕН START TRANSACTION") —
// caller-ът (attemptLudoRoomStart.ts) го извиква ТОЧНО ВЕДНЪЖ ПРЕДИ atomic
// debit транзакцията, персистира РЕЗУЛТАТА атомарно с debit-а, и подава
// СЪЩИЯ обект обратно на createMatch() по-долу — гарантира, че персистираният
// snapshot и реалният in-memory match виждат ЕДИН И СЪЩ (не два отделни
// random) резултат от randomTwoPlayerCreatorColor()/initialStateFactory.
export type LudoInitialMatchData = {
  players: Array<Omit<LudoMatchPlayer, 'connectionId'>>
  state: LudoGameState
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
  randomTwoPlayerCreatorColor?: () => LudoColor
  now?: () => number
  initialStateFactory?: (turnOrder: readonly LudoColor[]) => LudoGameState
  finishedMatchRetentionMs?: number
  onSnapshot: (match: LudoMatchSnapshot) => void
}

const ROOM_COLORS: readonly LudoColor[] = ['red', 'blue', 'green', 'yellow']
const CANONICAL_TURN_ORDER: readonly LudoColor[] = ['red', 'blue', 'yellow', 'green']
const OPPOSITE_COLOR: Readonly<Record<LudoColor, LudoColor>> = {
  red: 'yellow',
  yellow: 'red',
  blue: 'green',
  green: 'blue',
}

export function createLudoMatchRuntime(options: Options) {
  const matches = new Map<string, Match>()
  const profileToMatch = new Map<string, string>()
  const now = options.now ?? Date.now
  const finishedMatchRetentionMs = options.finishedMatchRetentionMs ?? LUDO_FINISHED_MATCH_RETENTION_MS
  const randomDie = options.randomDie ?? (() => (Math.floor(Math.random() * 6) + 1) as LudoDiceValue)
  const randomTwoPlayerCreatorColor = options.randomTwoPlayerCreatorColor ?? (() => ROOM_COLORS[randomInt(ROOM_COLORS.length)]!)

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
    const expectedDeadlineAt = match.deadlineAt
    const expectedActiveColor = match.state.activeColor
    const expectedTurnPhase = match.state.turnPhase
    match.deadlineTimer = setTimeout(() => {
      if (
        match.state.status === 'finished' ||
        match.deadlineAt !== expectedDeadlineAt ||
        match.state.activeColor !== expectedActiveColor ||
        match.state.turnPhase !== expectedTurnPhase
      ) return
      if (isBotControlled && !match.botControlledColors.has(match.state.activeColor)) return
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

  // Чисто изчисление (виж LudoInitialMatchData doc коментара по-горе) — НЕ
  // мутира matches/profileToMatch, safe за извикване ПРЕДИ реалния match да
  // бъде persisted/създаден (atomic-start transaction, виж task spec §3).
  function computeInitialMatchData(room: LudoRoom, matchId: string): LudoInitialMatchData {
    void matchId // резервирано за бъдещ per-match deterministic seeding, засега color assignment-ът не зависи от matchId
    const creatorColor = room.playerCount === 2 ? randomTwoPlayerCreatorColor() : null
    const assigned = room.players.map((player, index) => ({
      ...player,
      color: creatorColor === null
        ? ROOM_COLORS[index]!
        : player.profileId === room.hostProfileId
          ? creatorColor
          : OPPOSITE_COLOR[creatorColor],
    }))
    const turnOrder = creatorColor === null
      ? CANONICAL_TURN_ORDER.filter((color) => assigned.some((player) => player.color === color))
      : [creatorColor, OPPOSITE_COLOR[creatorColor]]
    const state = options.initialStateFactory?.(turnOrder) ?? createLudoAuthoritativeInitialState(turnOrder)
    const players = assigned.map(({ connectionId: _connectionId, ...rest }) => rest)
    return { players, state }
  }

  function createMatch(room: LudoRoom, matchId: string, precomputed?: LudoInitialMatchData): LudoMatchSnapshot {
    // precomputed (виж task spec §3) идва от attemptLudoRoomStart.ts, вече
    // извикало buildInitialMatch() ВЕДНЪЖ и persisted-нало резултата атомарно
    // с debit-а — тук НЕ бива да се преизчислява (втори randomTwoPlayer-
    // CreatorColor() call би дал ДРУГ цвят от persisted snapshot-а). Ако
    // липсва (директен createMatch извикване без atomic-start — тестове/
    // mock harness), fallback-ва към старото поведение — computeInitialMatchData
    // тук за първи път.
    const data = precomputed ?? computeInitialMatchData(room, matchId)
    // room.players носи ЖИВИЯ connectionId (стаята е fresh/active) — цветът
    // идва от data.players (precomputed или току-що computed), merge-нати по
    // profileId. За restored matches (restoreMatch по-долу) няма room обект
    // изобщо, затова тази merge логика е специфична за createMatch пътя.
    const assigned: LudoMatchPlayer[] = room.players.map((roomPlayer) => {
      const colorInfo = data.players.find((player) => player.profileId === roomPlayer.profileId)!
      return { ...roomPlayer, color: colorInfo.color }
    })
    const match: Match = {
      // matchId се генерира и предава ОТВЪН (attemptLudoRoomStart.ts) —
      // НЕ тук с randomUUID() — защото същият id вече служи като
      // ludo_match_economy_ledger scope за atomic stake debit-а, извършен
      // ПРЕДИ това извикване (виж task spec §"ATOMIC DEBIT ПРИ УСПЕШЕН
      // START"). Двата трябва да са СЪЩИЯТ id, иначе payoutLudoMatchWinner
      // не би намерил pot-а по-късно.
      matchId, ludoRoomId: room.id, stake: room.stake, revision: 0,
      deadlineAt: null, players: assigned, state: data.state,
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

  // Boot recovery (виж task spec §4) — reconstruct-ва match-а от persisted
  // snapshot без НИКАКВА нова randomness/debit (matchId/players/state/
  // botControlledColors идват директно от DB-то). НЕ вика options.onSnapshot
  // (тих boot-time insert — никой не е свързан още, а и не искаме излишен
  // re-persist веднага след като точно това е бил load-натия ред). Timer
  // rebase (виж task spec §6, mirror-нато Belot rebaseServerStateToEventAt
  // semantics — ФРЕШ пълен timeout прозорец спрямо restore момента, НЕ
  // "остатъчно време" replay): scheduleDeadline() винаги смята delay-а
  // наново спрямо now() и текущата turnPhase/botControlled статус, никога от
  // стар persisted deadlineAt — затова просто извикването ѝ тук вече дава
  // точно исканото поведение, без допълнителна "remaining time" логика.
  function restoreMatch(persisted: LudoMatchSnapshot): void {
    if (matches.has(persisted.matchId)) return // defensive — не би трябвало да се случи (boot-only извикване, преди connections)
    const players: LudoMatchPlayer[] = persisted.players.map((player) => ({
      ...player,
      // Никога не наследявай stale WebSocket connection id след restart (виж
      // task spec §1/§5) — реалният production connection-id формат никога
      // не е празен низ, затова е безопасен sentinel. reconnect()
      // презаписва connectionId безусловно при следващия ludo_game_state_
      // request от играча (виж reconnect() по-долу) — не сравнява със
      // старата стойност, затова този sentinel никога не се използва за
      // route-ване на съобщения.
      connectionId: '',
    }))
    const match: Match = {
      matchId: persisted.matchId,
      ludoRoomId: persisted.ludoRoomId,
      stake: persisted.stake,
      revision: persisted.revision,
      deadlineAt: null,
      players,
      state: persisted.state,
      lastEvents: [],
      deadlineTimer: null,
      finishedCleanupTimer: null,
      // Canonical bot/human ownership запазено ТОЧНО както е било persisted
      // (виж task spec §5: "Ако seat е бил botControlled ПРЕДИ crash: запази
      // това canonical състояние. Ако е бил human-controlled: не го
      // превръщай произволно веднага в permanent bot") — pendingReclaims
      // нарочно НЕ се персистира/възстановява: тесен presentation-timing
      // флаг (виж декларацията му по-долу), безсмислен след restart, защото
      // никое mid-flight bot действие не преживява process kill.
      botControlledColors: new Set(persisted.botControlledColors),
      pendingReclaims: new Set(),
    }
    matches.set(match.matchId, match)
    // Виж task spec §9 "SERVER RESTART PERSISTENCE": explicit-forfeit-нал
    // profile НЕ влиза в profileToMatch след restore — той вече освободи
    // active membership-а си ПРЕДИ crash-а (виж leave()), restart-ът не
    // бива да го "върне" обратно в commitment-а. Display roster (match.
    // players, точно над тук) остава пълен независимо — display roster !=
    // active membership, огледално на живия (non-restart) forfeit път.
    players
      .filter((player) => !persisted.state.leftColors.includes(player.color))
      .forEach((player) => profileToMatch.set(player.profileId, match.matchId))
    scheduleDeadline(match)
    scheduleFinishedCleanup(match)
  }

  return {
    createMatch,
    buildInitialMatch: computeInitialMatchData,
    restoreMatch,
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
    disconnect(profileId: string, connectionId: string): void {
      const matchId = profileToMatch.get(profileId)
      const match = matchId ? matches.get(matchId) : null
      const player = match?.players.find((item) => item.profileId === profileId)
      if (!match || !player || player.connectionId !== connectionId || match.state.status === 'finished') return
      if (match.botControlledColors.has(player.color)) return
      match.botControlledColors.add(player.color)
      const events: LudoEngineEvent[] = [{ type: 'bot_takeover_started', color: player.color }]
      if (match.state.activeColor === player.color) commit(match, match.state, events)
      else publishOrchestrationChange(match, events)
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
      if (!match.botControlledColors.has(player.color)) return { ok: true }
      void expectedRevision
      match.pendingReclaims.delete(player.color)
      match.botControlledColors.delete(player.color)
      const events: LudoEngineEvent[] = [{ type: 'human_control_resumed', color: player.color }]
      if (match.state.activeColor === player.color) commit(match, match.state, events)
      else publishOrchestrationChange(match, events)
      return { ok: true }
    },
    // Explicit "Изход" forfeit (виж task-а "Explicit Изход от STARTED
    // match") — canonical за ВСЕКИ playerCount (вече НЕ 2-player-only,
    // ludo_match_leave_unsupported за 4p е премахнат). Temporary disconnect/
    // reconnect/reclaim (botControlledColors/pendingReclaims) остава
    // СЪВСЕМ отделен lifecycle, недокоснат тук.
    leave(matchId: string, profileId: string): { ok: true } | LudoMatchFailure {
      const match = matches.get(matchId)
      if (!match) return { ok: false, code: 'ludo_match_not_found', message: 'Ludo играта не беше намерена.' }
      const leavingPlayer = match.players.find((player) => player.profileId === profileId)
      if (!leavingPlayer) return { ok: false, code: 'ludo_match_not_participant', message: 'Не участваш в тази Ludo игра.' }

      // Пост-финал acknowledgment (напр. end-game OK click) — напълно
      // отделен от explicit-forfeit пътя долу: тук match-ът вече е
      // 'finished' (естествен win ИЛИ по-ранен forfeit), играчът просто
      // потвърждава изход от UI-а. match.players СЕ филтрира тук (за
      // разлика от forfeit клона долу) — веднъж match-ът приключил и всички
      // потвърдили, display roster вече не е нужен на никого.
      if (match.state.status === 'finished') {
        profileToMatch.delete(profileId)
        match.players = match.players.filter((player) => player.profileId !== profileId)
        match.pendingReclaims.delete(leavingPlayer.color)
        match.botControlledColors.delete(leavingPlayer.color)
        if (match.players.length === 0) {
          if (match.finishedCleanupTimer) clearTimeout(match.finishedCleanupTimer)
          matches.delete(matchId)
        }
        return { ok: true }
      }

      // Идемпотентност — вече forfeit-нал (напр. duplicate leave_ludo_match
      // network retry). Активното membership release-ване е безопасно да се
      // повтори; НЕ bump-ваме revision/broadcast-ваме отново за нищо ново.
      if (match.state.leftColors.includes(leavingPlayer.color)) {
        profileToMatch.delete(profileId)
        return { ok: true }
      }

      // Canonical forfeit dispatch — pieces->home, leftColors, last-player-
      // standing win check, turn-order skip: ВСИЧКО централизирано в
      // ludoEngineReducer.ts::handlePlayerForfeited (валидно за 2 и 4
      // playerCount еднакво), НЕ дублирано тук.
      const result = reduceLudoGame(match.state, { type: 'PLAYER_FORFEITED', color: leavingPlayer.color })

      // Release active membership/cross-game commitment ВЕДНАГА (виж task-а
      // §10 "CROSS-GAME MEMBERSHIP") — НЕ филтрираме от match.players
      // (display roster остава пълен за целия оставащ match, виж §3 "не
      // премахвай визуално целия player panel" — "display roster != active
      // membership"), само от profileToMatch (единственият source of truth
      // за reconnect()/requestState()/cross-game commitment guard).
      profileToMatch.delete(profileId)
      match.pendingReclaims.delete(leavingPlayer.color)
      match.botControlledColors.delete(leavingPlayer.color)

      // commit() (не publishOrchestrationChange()) само когато turn/deadline
      // семантиката реално се променя — активен цвят се смени (forfeit-налият
      // беше на ход) ИЛИ match-ът приключи (last-player-standing). Иначе
      // (inactive player напуска) НЕ ресетваме вече течащия countdown на
      // текущия активен играч — публикуваме новия state (pieces->home,
      // leftColors) без да пипаме deadline-а, огледално на disconnect()/
      // reclaim()'s established commit-vs-publishOrchestrationChange избор.
      const affectsActiveTurnOrDeadline =
        result.state.activeColor !== match.state.activeColor || result.state.status === 'finished'
      if (affectsActiveTurnOrDeadline) {
        commit(match, result.state, result.events)
      } else {
        match.state = result.state
        publishOrchestrationChange(match, result.events)
      }

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
