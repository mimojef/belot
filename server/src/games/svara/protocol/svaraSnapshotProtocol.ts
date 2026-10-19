// Свара — защитени индивидуални snapshot-и за клиента (Етап 2Б.3.2).
//
// Чист сървърен builder: от authoritative `SvaraMatchState` и доверен
// идентификатор на зрителя строи съобщение САМО от изрично изброени публични
// полета. Суровото състояние никога не се копира към клиента.
//
// Модел: индивидуалните snapshot-и на Белот (`protocol/createRoomSnapshotMessage.ts`)
// — изричен `type`, собствената ръка само за зрителя, публичен брой карти за
// останалите. Без WebSocket handler на този етап.
//
// Политика за карти:
//   • Собствените карти — само чрез `createSvaraMatchPlayerView` (т.е. само след
//     сървърно регистрирано „поглеждане“ в текущото раздаване).
//   • Чуждите карти — никога. Спецификацията не разрешава изрично разкриване
//     на картите при сравняване, затова `shownHands` и `points` от историята
//     НЕ се изпращат (SVARA_SNAPSHOT_SHOWDOWN_REVEAL = 'withheld'), докато
//     собственикът не реши друго.
//   • Дали ДРУГ играч е погледнал картите си също не се изпраща (решение на
//     собственика); тъмен залог е публично обявено действие и остава в
//     публичния журнал на действията.
//
// Без тестета, RNG, дневник, processedCommands, fingerprint, вътрешни
// списъци на наддаването (pending/acted/raiseLocked) и пълни ръце.

import { buildSvaraPotLayers } from '../engine/svaraPots.js'
import type { SvaraBettingAction, SvaraBettingOptions, SvaraBlindStatus } from '../engine/svaraBetting.js'
import type { SvaraCardCode } from '../engine/svaraCards.js'
import {
  createSvaraMatchPlayerView,
  describeSvaraMatchOptions,
  describeSvaraLifecycle,
  type SvaraEntryPercent,
  type SvaraMatchState,
  type SvaraPotOutcome,
  type SvaraRoundRecord,
  type SvaraSeatStatus,
  type SvaraStartMode,
} from '../engine/svaraMatch.js'

export const SVARA_SNAPSHOT_MESSAGE_TYPE = 'svara_match_snapshot'
/** Public lobby projection, separate from the individual game snapshot. */
export type SvaraPublicTable = {
  matchId: string
  phase: SvaraMatchState['phase']
  capacity: 2 | 3 | 4
  creatorId: string
  startMode: SvaraStartMode
  entryFee: number
  entryPercent: SvaraEntryPercent
  startingChips: number
  entryChips: number
  players: Array<{ playerId: string; status: SvaraSeatStatus; displayName?: string | null; avatarUrl?: string | null }>
}

/** Explicit public whitelist; never copies cards or internal state. */
export function createSvaraPublicTable(matchId: string, state: SvaraMatchState): SvaraPublicTable {
  return {
    matchId, phase: state.phase, capacity: state.config.capacity,
    creatorId: state.config.creatorId, startMode: state.config.startMode,
    entryFee: state.config.entryFee, entryPercent: state.config.entryPercent,
    startingChips: state.startingChips, entryChips: state.entryChips,
    players: state.seats.map((playerId) => ({ playerId, status: state.status[playerId]! })),
  }
}

export const SVARA_SNAPSHOT_PROTOCOL_VERSION = 1
/** Колко от последните приключили раздавания се включват (снимката не расте с мача). */
export const SVARA_SNAPSHOT_HISTORY_LIMIT = 10
/** Картите при сравняване не се разкриват, докато правилата не го разрешат изрично. */
export const SVARA_SNAPSHOT_SHOWDOWN_REVEAL = 'withheld' as const

// ── Типове на съобщението ───────────────────────────────────────────────────

export type SvaraSnapshotSeat = {
  seatIndex: number
  playerId: string
  status: SvaraSeatStatus
  stack: number
  isDealer: boolean
  isToAct: boolean
  /** Участва в текущото раздаване с наддаване (обикновено или за Свара). */
  inRound: boolean
  folded: boolean
  allIn: boolean
  /** Брой карти в ръката (без самите карти). */
  cardCount: number
  /** Вноска в текущото раздаване (Вход + доброволни залози; в Свара — само новите залози). */
  roundContribution: number
}

export type SvaraSnapshotAction = {
  playerId: string
  kind: SvaraBettingAction['kind'] | 'forced-fold'
  total: number
  added: number
  allIn: boolean
  blind: boolean
}

export type SvaraSnapshotPotLayer = {
  index: number
  amount: number
  kind: 'uncalled' | 'contested'
  eligible: string[]
}

export type SvaraSnapshotBettingRound = {
  kind: 'ordinary' | 'svara'
  roundId: string
  dealerId: string
  /** Заключената банка, за която се играе (само за 'svara'). */
  potId: string | null
  participants: string[]
  currentBet: number
  blind: { status: SvaraBlindStatus; lastBlindTotal: number }
  /** Пренесени чипове в основната банка на това раздаване (§6.11). */
  carriedIn: number
  potTotal: number
  /** Текущи (предварителни) слоеве по вноските — окончателни при приключване. */
  provisionalPots: SvaraSnapshotPotLayer[]
  isFourthHeadsUp: boolean
  noBetAllowed: boolean
  actions: SvaraSnapshotAction[]
  /** 2Б.3.7.4Б: тече ли сървърната фаза на представяне на раздаването (Вход + карти). */
  dealing: boolean
}

/** 2Б.3.7.6А §7 — една стъпка от последователното изплащане на показаното сравняване. */
export type SvaraSnapshotPayoutStep = {
  stepId: string
  potId: string
  isMain: boolean
  amount: number
  winners: string[]
  share: number | null
  removed: number
  sequence: number
}

export type SvaraSnapshotRound =
  | SvaraSnapshotBettingRound
  | { kind: 'svara-joining'; roundId: string; potId: string; fee: number; joiners: string[]; closed: boolean;
      decisions: Array<{ playerId: string; status: 'undecided' | 'joined' | 'declined' }> }
  | { kind: 'allin-svara'; roundId: string; potIds: string[]; iteration: number }
  /**
   * 2Б.3.7.1: изборът „Покажи“/„Скрий“ — `winnerId`/`decision` са публични за
   * всички на масата (кой е победил не е скрито, само картите); `cards`/
   * `points` остават null, докато `decision` не стане 'revealed'.
   */
  | { kind: 'reveal-choice'; roundId: string; winnerId: string; decision: 'pending' | 'revealed'; cards: SvaraCardCode[] | null; handPoints: number | null }
  /**
   * 2Б.3.7.6А — истинско showdown (2+ сравняващи играчи, без избор, за
   * разлика от 'reveal-choice'). Собственикът изрично реши: картите и
   * точките на ВСИЧКИ сравняващи се показват едновременно, публично, за
   * всички на масата (виж §4 на заданието) — различно поле-име от
   * историческите 'shownHands'/'points' (изрично withheld там, виж
   * SVARA_SNAPSHOT_SHOWDOWN_REVEAL), защото тук е НОВО, целево разрешено
   * разкриване само за точно този, вече приключил, показ.
   */
  | {
      kind: 'showdown-display'
      roundId: string
      dealerId: string | null
      comparedPlayers: string[]
      cards: Record<string, SvaraCardCode[]>
      comparisonPoints: Record<string, number>
      payout: SvaraSnapshotPayoutStep[]
      /** true, ако поне една банка от това сравняване остава заключена ("Свара!", §8). */
      svaraTie: boolean
      displayPhase: 'showdown' | 'payout'
    }

export type SvaraSnapshotLockedPot = {
  potId: string
  kind: 'ordinary' | 'allin'
  amount: number
  eligible: string[]
  isMain: boolean
  continuation: number
}

export type SvaraSnapshotPotOutcome =
  | { kind: 'uncalled-return'; playerId: string }
  | { kind: 'awarded'; winner: string; byShowdown: boolean }
  | { kind: 'locked'; lockedPotId: string; tiedPlayers: string[]; lockKind: 'ordinary' | 'allin' }
  | { kind: 'carried'; carryId: string }
  | { kind: 'split'; tiedPlayers: string[]; share: number; removed: number }

export type SvaraSnapshotHistoryRecord = {
  roundId: string
  kind: SvaraRoundRecord['kind']
  dealerId: string | null
  participants: string[]
  folded: string[]
  contributions: Array<{ playerId: string; amount: number }>
  anyVoluntaryBet: boolean
  pots: Array<{ potId: string; source: 'round' | 'locked'; amount: number; eligible: string[]; outcome: SvaraSnapshotPotOutcome }>
}

export type SvaraMatchSnapshotMessage = {
  type: typeof SVARA_SNAPSHOT_MESSAGE_TYPE
  protocolVersion: typeof SVARA_SNAPSHOT_PROTOCOL_VERSION
  matchId: string
  /** Брой приложени команди — монотонен; за подреждане на snapshot-ите. */
  revision: number
  phase: SvaraMatchState['phase']
  table: {
    capacity: 2 | 3 | 4
    startMode: SvaraStartMode
    creatorId: string
    entryFee: number
    entryPercent: SvaraEntryPercent
    startingChips: number
    entryChips: number
  }
  seats: SvaraSnapshotSeat[]
  dealerId: string | null
  toActId: string | null
  you: {
    playerId: string
    seatIndex: number
    status: SvaraSeatStatus
    /** Погледнал ли е зрителят картите си в текущото раздаване. */
    looked: boolean
    returnPending: boolean
    svaraDecision: 'joined' | 'declined' | 'undecided' | null
    /** Собствените карти — само след „поглеждане“; иначе null. */
    cards: SvaraCardCode[] | null
    /** Позволените действия в наддаването (само за зрителя, само на негов ход). */
    betting: SvaraBettingOptions | null
    /** 2Б.3.7.1: само за самия победител, докато изборът чака решение. */
    revealChoice: { canDecide: boolean } | null
  }
  round: SvaraSnapshotRound | null
  lockedPots: SvaraSnapshotLockedPot[]
  carriedTotal: number
  removedChips: number
  totalChips: number
  history: { totalRounds: number; showdownReveal: typeof SVARA_SNAPSHOT_SHOWDOWN_REVEAL; recent: SvaraSnapshotHistoryRecord[] }
  result: { finished: boolean; closed: boolean; winnerId: string | null;
    aborted: boolean; reason: 'prolonged-absence' | 'all-absent' | null; message: string | null }
}

export class SvaraSnapshotAccessError extends Error {
  constructor(readonly code: 'not-a-participant' | 'invalid-viewer' | 'not-a-snapshot', message: string) {
    super(message)
    this.name = 'SvaraSnapshotAccessError'
  }
}

// ── Builder ─────────────────────────────────────────────────────────────────

/** Snapshot-и, построени от този модул — само те могат да се сериализират към клиент. */
const builtSnapshots = new WeakSet<object>()

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key])
    Object.freeze(value)
  }
  return value
}

function copyOutcome(outcome: SvaraPotOutcome): SvaraSnapshotPotOutcome {
  switch (outcome.kind) {
    case 'uncalled-return': return { kind: 'uncalled-return', playerId: outcome.playerId }
    case 'awarded': return { kind: 'awarded', winner: outcome.winner, byShowdown: outcome.byShowdown }
    case 'locked': return { kind: 'locked', lockedPotId: outcome.lockedPotId, tiedPlayers: [...outcome.tiedPlayers], lockKind: outcome.lockKind }
    case 'carried': return { kind: 'carried', carryId: outcome.carryId }
    case 'split': return { kind: 'split', tiedPlayers: [...outcome.tiedPlayers], share: outcome.share, removed: outcome.removed }
  }
}

/** Публична част от запис в историята — без показани карти и точки. */
function publicHistoryRecord(record: SvaraRoundRecord, seats: readonly string[]): SvaraSnapshotHistoryRecord {
  return {
    roundId: record.roundId,
    kind: record.kind,
    dealerId: record.dealerId,
    participants: [...record.participants],
    folded: [...record.folded],
    contributions: seats.filter((id) => (record.contributions[id] ?? 0) > 0).map((playerId) => ({ playerId, amount: record.contributions[playerId]! })),
    anyVoluntaryBet: record.anyVoluntaryBet,
    pots: record.pots.map((pot) => ({ potId: pot.potId, source: pot.source, amount: pot.amount, eligible: [...pot.eligible], outcome: copyOutcome(pot.outcome) })),
  }
}

function publicRound(state: SvaraMatchState): SvaraSnapshotRound | null {
  const round = state.round
  if (!round) return null
  if (round.kind === 'svara-joining') {
    const pot = state.lockedPots.find((entry) => entry.potId === round.potId)
    const waiting = new Set(round.closed ? [] : describeSvaraLifecycle(state).joining?.undecided ?? [])
    // Project existing decisions only in this individual snapshot's ordinary
    // joining context. No new stored state or inference of declined players.
    const decisions = pot?.kind !== 'ordinary' ? [] : state.seats.flatMap((playerId):
      Array<{ playerId: string; status: 'undecided' | 'joined' | 'declined' }> => {
      if (state.status[playerId] === 'exited') return []
      if (round.joiners.includes(playerId) && pot.eligible.includes(playerId)) return [{ playerId, status: 'joined' }]
      if (round.declined?.includes(playerId)) return [{ playerId, status: 'declined' }]
      return waiting.has(playerId) ? [{ playerId, status: 'undecided' }] : []
    })
    return { kind: 'svara-joining', roundId: round.roundId, potId: round.potId, fee: round.fee,
      joiners: [...round.joiners], closed: round.closed ?? false, decisions }
  }
  if (round.kind === 'allin-svara') return { kind: 'allin-svara', roundId: round.roundId, potIds: [...round.potIds], iteration: round.iteration }
  if (round.kind === 'reveal-choice') {
    const revealed = round.decision === 'revealed'
    return { kind: 'reveal-choice', roundId: round.roundId, winnerId: round.winnerId, decision: round.decision,
      cards: revealed ? [...round.cards] : null, handPoints: revealed ? round.points : null }
  }
  if (round.kind === 'showdown-display') {
    return {
      kind: 'showdown-display',
      roundId: round.roundId,
      dealerId: round.dealerId,
      comparedPlayers: [...round.comparedPlayers],
      cards: Object.fromEntries(round.comparedPlayers.map((id) => [id, [...round.cards[id]!]])),
      comparisonPoints: { ...round.points },
      payout: round.payoutSteps.map((step) => ({
        stepId: step.stepId, potId: step.potId, isMain: step.isMain, amount: step.amount,
        winners: [...step.winners], share: step.share, removed: step.removed, sequence: step.order,
      })),
      svaraTie: round.svaraTie,
      displayPhase: round.phase,
    }
  }
  const betting = round.betting
  const carriedIn = round.kind === 'ordinary' ? round.deadMoney : 0
  const contributed = round.participants.reduce((sum, id) => sum + (round.contributions[id] ?? 0), 0)
  const layers = buildSvaraPotLayers({ participants: round.participants, contributions: round.contributions, folded: betting.folded })
  return {
    kind: round.kind,
    roundId: round.roundId,
    dealerId: round.dealerId,
    potId: round.kind === 'svara' ? round.potId : null,
    participants: [...round.participants],
    currentBet: betting.currentBet,
    blind: { status: betting.blind.status, lastBlindTotal: betting.blind.lastBlindTotal },
    carriedIn,
    potTotal: contributed + carriedIn,
    provisionalPots: layers.map((layer) => ({ index: layer.index, amount: layer.amount, kind: layer.kind, eligible: [...layer.eligible] })),
    isFourthHeadsUp: round.kind === 'ordinary' ? round.isFourthHeadsUp : false,
    noBetAllowed: betting.allowNoBet,
    actions: betting.log.map((entry) => ({ playerId: entry.playerId, kind: entry.kind, total: entry.total, added: entry.added, allIn: entry.allIn, blind: entry.blind })),
    // 2Б.3.7.4Б: сървърна фаза на представяне на раздаването — виж timing
    // съобщението (дедлайн kind:'dealing') за абсолютния край; докато е true,
    // toActId/isToAct/betting опциите са null за всички (никакъв активен ход).
    dealing: !!round.dealing,
  }
}

/**
 * Строи индивидуалния snapshot. `viewerId` трябва да идва от доверен сървърен
 * контекст (автентикирана сесия). Резултатът е нов, дълбоко замразен обект —
 * без споделени изменяеми части между зрители или със състоянието.
 */
export function createSvaraMatchSnapshotMessage(matchId: string, state: SvaraMatchState, viewerId: string): SvaraMatchSnapshotMessage {
  if (typeof viewerId !== 'string' || viewerId.trim() === '') throw new SvaraSnapshotAccessError('invalid-viewer', 'viewerId required')
  const seatIndex = state.seats.indexOf(viewerId)
  if (seatIndex < 0) throw new SvaraSnapshotAccessError('not-a-participant', `${viewerId} is not a participant of ${matchId}`)
  // Единственият източник на собствените карти и на опциите — безопасните функции на двигателя.
  const view = createSvaraMatchPlayerView(state, viewerId)
  const options = describeSvaraMatchOptions(state, viewerId)
  const round = state.round
  const betting = round && (round.kind === 'ordinary' || round.kind === 'svara') ? round : null
  const withCards = new Map(view.seatsWithCards.map((seat) => [seat.playerId, seat.cardCount]))
  const message: SvaraMatchSnapshotMessage = {
    type: SVARA_SNAPSHOT_MESSAGE_TYPE,
    protocolVersion: SVARA_SNAPSHOT_PROTOCOL_VERSION,
    matchId,
    revision: Object.keys(state.processedCommands).length,
    phase: state.phase,
    table: {
      capacity: state.config.capacity,
      startMode: state.config.startMode,
      creatorId: state.config.creatorId,
      entryFee: state.config.entryFee,
      entryPercent: state.config.entryPercent,
      startingChips: state.startingChips,
      entryChips: state.entryChips,
    },
    seats: state.seats.map((playerId, index) => ({
      seatIndex: index,
      playerId,
      status: state.status[playerId]!,
      stack: state.stacks[playerId] ?? 0,
      isDealer: view.dealerId === playerId,
      isToAct: view.toAct === playerId,
      inRound: betting ? betting.participants.includes(playerId) : false,
      folded: betting ? betting.betting.folded.includes(playerId) : false,
      allIn: betting ? betting.betting.allIn.includes(playerId) : false,
      cardCount: withCards.get(playerId) ?? 0,
      roundContribution: betting ? betting.contributions[playerId] ?? 0 : 0,
    })),
    dealerId: view.dealerId,
    toActId: view.toAct,
    you: {
      playerId: viewerId,
      seatIndex,
      status: state.status[viewerId]!,
      looked: view.ownLooked,
      returnPending: state.pendingReturns?.includes(viewerId) ?? false,
      svaraDecision: round?.kind !== 'svara-joining' ? null : round.joiners.includes(viewerId) ? 'joined'
        : round.declined?.includes(viewerId) ? 'declined'
        : !round.closed && state.status[viewerId] === 'active' && state.stacks[viewerId]! >= round.fee &&
          !state.lockedPots.find((p) => p.potId === round.potId)?.eligible.includes(viewerId) ? 'undecided' : null,
      cards: view.ownCards ? [...view.ownCards] : null,
      betting: options
        ? {
            canAct: options.canAct,
            fold: options.fold,
            noBet: options.noBet,
            call: options.call,
            bet: options.bet ? { min: options.bet.min, max: options.bet.max } : null,
            blindBet: options.blindBet ? { min: options.blindBet.min, max: options.blindBet.max } : null,
            allIn: options.allIn,
            lookRequired: options.lookRequired,
          }
        : null,
      revealChoice: round?.kind === 'reveal-choice' && round.winnerId === viewerId ? { canDecide: round.decision === 'pending' } : null,
    },
    round: publicRound(state),
    lockedPots: state.lockedPots.map((pot) => ({ potId: pot.potId, kind: pot.kind, amount: pot.amount, eligible: [...pot.eligible], isMain: pot.isMain, continuation: pot.continuation })),
    carriedTotal: view.carriedTotal,
    removedChips: state.removedChips,
    totalChips: state.totalChips,
    history: {
      totalRounds: state.history.length,
      showdownReveal: SVARA_SNAPSHOT_SHOWDOWN_REVEAL,
      recent: state.history.slice(-SVARA_SNAPSHOT_HISTORY_LIMIT).map((record) => publicHistoryRecord(record, state.seats)),
    },
    result: { finished: state.phase === 'finished', closed: state.phase === 'closed', winnerId: state.winnerId,
      aborted: state.finishReason === 'all-absent', reason: state.finishReason ?? null,
      message: state.finishReason === 'prolonged-absence' ? 'Победа поради продължително отсъствие на противниците'
        : state.finishReason === 'all-absent' ? 'Мачът е прекратен, защото всички играчи отсъстват' : null },
  }
  deepFreeze(message)
  builtSnapshots.add(message)
  return message
}

/** Ключове, които никога не трябва да се появят в клиентско съобщение. */
export const SVARA_SNAPSHOT_FORBIDDEN_KEYS: readonly string[] = Object.freeze([
  'hands', 'shownHands', 'points', 'ledger', 'processedCommands', 'fingerprint', 'deck', 'random', 'createDeck',
  'pending', 'acted', 'raiseLocked', 'firstActor', 'order', 'voluntary', 'deadMoneyFrom', 'stacks', 'config',
])

function findForbiddenKey(value: unknown, path: string): string | null {
  if (!value || typeof value !== 'object') return null
  for (const key of Object.keys(value)) {
    if (SVARA_SNAPSHOT_FORBIDDEN_KEYS.includes(key)) return `${path}.${key}`
    const nested = findForbiddenKey((value as Record<string, unknown>)[key], `${path}.${key}`)
    if (nested) return nested
  }
  return null
}

/**
 * Единственият позволен път към клиента: приема само snapshot, построен от
 * `createSvaraMatchSnapshotMessage`, и повторно проверява за вътрешни ключове.
 * Суров engine state (или ръчно сглобен обект) се отказва.
 */
export function serializeSvaraSnapshotForClient(message: unknown): string {
  if (!message || typeof message !== 'object' || !builtSnapshots.has(message)) {
    throw new SvaraSnapshotAccessError('not-a-snapshot', 'only snapshots built by createSvaraMatchSnapshotMessage can be sent to clients')
  }
  const leaked = findForbiddenKey(message, 'snapshot')
  if (leaked) throw new SvaraSnapshotAccessError('not-a-snapshot', `snapshot contains internal key ${leaked}`)
  return JSON.stringify(message)
}
