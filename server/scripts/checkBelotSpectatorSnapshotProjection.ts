/**
 * checkBelotSpectatorSnapshotProjection.ts
 *
 * SECURITY regression за Belot Spectator Mode Phase 2A — spectator-safe
 * projection (createSpectatorRoomSnapshotMessage). Pure unit test (реален
 * ServerRoom fixture + реални server reducers, без HTTP/WS/spawn).
 *
 * Модел: НЕ проверява наивно "думата hearts не съществува в JSON" — проверява
 * конкретната идентичност на всяка НЕИЗИГРАНА карта (authoritativeState.hands
 * + deck): нито нейният card id, нито {suit, rank} обект с нейната
 * идентичност не бива да се появява където и да е в spectator payload-а.
 *
 * Покрива:
 *   [P1]  type/viewerRole/yourSeat/reconnectToken — никога room_snapshot/seat/token
 *   [P2]  ownHand=[], handCounts присъстват и са коректни
 *   [P3]  изиграните карти (current trick + latest completed trick) са публични
 *   [P4]  validCardIds=null дори за seat-а на ход; sweepOffer=null
 *   [P5]  нито една неизиграна карта (id или suit+rank) в payload-а
 *   [P6]  declaration redaction: Терца в ръка -> без cards/cardIds/suit/highRank
 *   [P7]  declaration redaction: Каре в ръка -> points=null (рангът не изтича)
 *   [P8]  Белот с една изиграна карта -> само изиграната карта, suit видим,
 *         неизиграната Дама/Поп я няма
 *   [P9]  изцяло изиграна декларация -> пълна metadata
 *   [P10] bidding: canSubmitBid=false, validActions=null (а играчът на ход ги има)
 *   [P11] cutting: canSubmitCut=false (а cutter-ът го има); deck картите не изтичат
 *   [P12] matchEnded.awardedPrizeAmount=null; antiBadLuck/deck ключове липсват
 *   [P13] "Долу картите" ПРЕДИ accept: няма sweepOffer, няма handsAtResolution,
 *         timerDeadlineAt=null (eligibility side-channel), ръцете не изтичат
 *   [P14] "Долу картите" СЛЕД accept: handsAtResolution е публичен и пълен
 *   [P15] player snapshot пази собствените си private данни (ownHand/token),
 *         а декларациите са СЪЩАТА canonical публична проекция като при
 *         spectator (Phase 2B)
 */

const { createRoomSnapshotMessage, createSpectatorRoomSnapshotMessage } = await import(
  '../src/protocol/createRoomSnapshotMessage.js'
)
const { submitServerSweepDecision } = await import('../src/game/submitServerSweepDecision.js')

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

console.log('\n═══ checkBelotSpectatorSnapshotProjection ═══')

type Seat = 'bottom' | 'right' | 'top' | 'left'
type Suit = 'clubs' | 'diamonds' | 'hearts' | 'spades'
type Rank = '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A'
type Card = { id: string; suit: Suit; rank: Rank }

const SEATS: Seat[] = ['bottom', 'right', 'top', 'left']
const ALL_SUITS: Suit[] = ['clubs', 'diamonds', 'hearts', 'spades']
const ALL_RANKS: Rank[] = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A']

// Реалният server формат на card id (createServerDeck.ts) — `${suit}-${rank}`.
function card(suit: Suit, rank: Rank): Card {
  return { id: `${suit}-${rank}`, suit, rank }
}
function teamBySeat(seat: Seat): 'A' | 'B' {
  return seat === 'bottom' || seat === 'top' ? 'A' : 'B'
}
function emptyRoundScore() {
  return { teamA: 0, teamB: 0 }
}

function declaration(params: {
  seat: Seat
  type: 'sequence' | 'square' | 'belote'
  publicLabel: string
  points: number
  cards: Card[]
  suit: Suit | null
  highRank: Rank | null
  declaredAtTrickIndex?: number
}): any {
  return {
    key: `${params.type}-${params.cards.map((c) => c.id).join('|')}`,
    seat: params.seat,
    team: teamBySeat(params.seat),
    type: params.type,
    publicLabel: params.publicLabel,
    points: params.points,
    cards: params.cards,
    cardIds: params.cards.map((c) => c.id),
    suit: params.suit,
    highRank: params.highRank,
    declaredAtTrickIndex: params.declaredAtTrickIndex ?? 0,
    announced: true,
    valid: true,
  }
}

function baseState(overrides: Record<string, any>): any {
  const state: any = {
    phase: 'playing',
    phaseEnteredAt: Date.now(),
    targetScore: 151,
    players: Object.fromEntries(
      SEATS.map((seat) => [seat, { seat, team: teamBySeat(seat), mode: 'human', controlledByBot: false }]),
    ),
    round: { dealerSeat: 'bottom', cutterSeat: 'left', firstBidderSeat: 'right', firstDealSeat: 'right', selectedCutIndex: 12 },
    deck: [],
    hands: { bottom: [], right: [], top: [], left: [] },
    bidding: {
      entries: [],
      currentSeat: null,
      winningBid: { seat: 'bottom', contract: 'suit', trumpSuit: 'clubs', doubled: false, redoubled: false },
      hasStarted: true,
      hasEnded: true,
      consecutivePasses: 0,
    },
    declarations: [],
    matchDeclarationMissionCounts: {
      announce_tersa: emptyRoundScore(),
      announce_50: emptyRoundScore(),
      announce_100: emptyRoundScore(),
      announce_kare: emptyRoundScore(),
      announce_belot: emptyRoundScore(),
    },
    matchDeclarationMissionCountsBySeat: {},
    currentTrick: { leaderSeat: null, currentSeat: null, plays: [], winnerSeat: null, trickIndex: 0 },
    wonTricks: { A: [], B: [] },
    playing: null,
    scoring: null,
    matchEnded: null,
    score: {
      round: {
        tricks: emptyRoundScore(),
        declarations: emptyRoundScore(),
        belote: emptyRoundScore(),
        lastTen: emptyRoundScore(),
        capot: emptyRoundScore(),
        total: emptyRoundScore(),
      },
      match: { teamA: 42, teamB: 17 },
      carryOver: emptyRoundScore(),
    },
    timer: { activeSeat: null, startedAt: null, durationMs: null, expiresAt: null },
    // Server-only тайна — никога не бива да стигне до клиент.
    antiBadLuck: { secretMarker: 'ANTI_BAD_LUCK_SECRET_MARKER' },
  }
  return { ...state, ...overrides }
}

function humanParticipant(seat: Seat): any {
  return {
    kind: 'human',
    playerId: `player-${seat}`,
    connectionId: `conn-${seat}`,
    isConnected: true,
    joinedAt: 1,
    lastSeenAt: 1,
    reconnectToken: `RECONNECT_TOKEN_SECRET_${seat}`,
    permanentlyLeftAt: null,
    identity: {
      accountId: null,
      profileId: `profile-${seat}`,
      username: null,
      displayName: `Player ${seat}`,
      avatarUrl: null,
      level: 3,
      rankTitle: null,
      skillRating: null,
      gender: 'male',
    },
  }
}

function makeRoom(authoritativeState: any, extra: { awardedPrizePerSeat?: any; timerDeadlineAt?: number | null } = {}): any {
  return {
    id: 'room-spectator-fixture',
    status: 'playing',
    createdAt: 1,
    updatedAt: 1,
    hostPlayerId: 'player-bottom',
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
    },
    seats: Object.fromEntries(SEATS.map((seat) => [seat, { seat, team: teamBySeat(seat), participant: humanParticipant(seat) }])),
    game: {
      phase: 'playing',
      stateVersion: 7,
      startedAt: 1,
      updatedAt: 1,
      activeTimerId: null,
      timerDeadlineAt: extra.timerDeadlineAt === undefined ? Date.now() + 15000 : extra.timerDeadlineAt,
      authoritativeState,
    },
    replayVotes: [],
    leaveVotes: [],
    awardedPrizePerSeat: extra.awardedPrizePerSeat,
  }
}

// Събира всеки {suit, rank} обект от payload-а (рекурсивно) — за проверка, че
// нито една неизиграна карта не е сериализирана като обект, дори под друго id.
function collectCardLikeObjects(value: unknown, out: Array<{ suit: unknown; rank: unknown }> = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectCardLikeObjects(item, out)
  } else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if ('suit' in record && 'rank' in record) out.push({ suit: record.suit, rank: record.rank })
    for (const nested of Object.values(record)) collectCardLikeObjects(nested, out)
  }
  return out
}

function assertNoHiddenCardLeak(payload: unknown, hiddenCards: Card[], label: string): void {
  const json = JSON.stringify(payload)
  const cardLikeObjects = collectCardLikeObjects(JSON.parse(json))
  for (const hidden of hiddenCards) {
    assert(!json.includes(`"${hidden.id}"`), `${label}: hidden card id ${hidden.id} leaked in spectator payload`)
    assert(
      !cardLikeObjects.some((obj) => obj.suit === hidden.suit && obj.rank === hidden.rank),
      `${label}: hidden card ${hidden.id} leaked as a {suit,rank} object`,
    )
  }
}

// ─── Mid-play fixture ─────────────────────────────────────────────────────
// Козът е clubs. Trick 0 е изигран (completed), trick 1 тече (2 карти на масата).
const completedTrick0 = [
  { seat: 'right' as Seat, card: card('spades', '7') },
  { seat: 'top' as Seat, card: card('spades', '8') },
  { seat: 'left' as Seat, card: card('spades', '9') },
  { seat: 'bottom' as Seat, card: card('spades', '10') },
]
// left-ова Терца (diamonds 7-8-9) — изцяло изиграна в предишни взятки
// (симулирано: картите са в completedTricks, не в ръка).
const completedTrick1 = [
  { seat: 'bottom' as Seat, card: card('diamonds', 'A') },
  { seat: 'right' as Seat, card: card('diamonds', '7') },
  { seat: 'top' as Seat, card: card('diamonds', '10') },
  { seat: 'left' as Seat, card: card('diamonds', '8') },
]
const completedTrick2 = [
  { seat: 'bottom' as Seat, card: card('diamonds', 'K') },
  { seat: 'right' as Seat, card: card('spades', 'A') },
  { seat: 'top' as Seat, card: card('diamonds', 'J') },
  { seat: 'left' as Seat, card: card('diamonds', '9') },
]
// top играе clubs K (Белот, Дамата clubs Q остава в ръката му).
const currentTrickPlays = [
  { seat: 'right' as Seat, card: card('clubs', '7') },
  { seat: 'top' as Seat, card: card('clubs', 'K') },
]

const midPlayHands: Record<Seat, Card[]> = {
  // bottom: Терца hearts 7-8-9 в ръка
  bottom: [card('hearts', '7'), card('hearts', '8'), card('hearts', '9'), card('hearts', '10'), card('clubs', 'A')],
  // right: три от четирите валета (Каре) — diamonds J вече е изигран в trick 2
  right: [card('clubs', '9'), card('hearts', 'A'), card('spades', 'J'), card('hearts', 'J'), card('clubs', 'J')],
  top: [card('clubs', 'Q'), card('hearts', 'Q'), card('hearts', 'K'), card('spades', 'Q')],
  left: [card('clubs', '8'), card('clubs', '10'), card('spades', 'K'), card('diamonds', 'Q')],
}

// Каре: четирите валета — diamonds J вече е изигран (trick 2), трите други в
// ръката на right -> частично скрито => points трябва да е null.
const midPlayDeclarations = [
  declaration({
    seat: 'bottom',
    type: 'sequence',
    publicLabel: 'Терца',
    points: 20,
    cards: [card('hearts', '7'), card('hearts', '8'), card('hearts', '9')],
    suit: 'hearts',
    highRank: '9',
  }),
  declaration({
    seat: 'right',
    type: 'square',
    publicLabel: 'Каре',
    points: 200,
    cards: [card('clubs', 'J'), card('diamonds', 'J'), card('hearts', 'J'), card('spades', 'J')],
    suit: null,
    highRank: 'J',
  }),
  declaration({
    seat: 'top',
    type: 'belote',
    publicLabel: 'Белот',
    points: 20,
    cards: [card('clubs', 'Q'), card('clubs', 'K')],
    suit: 'clubs',
    highRank: null,
    declaredAtTrickIndex: 3,
  }),
  declaration({
    seat: 'left',
    type: 'sequence',
    publicLabel: 'Терца',
    points: 20,
    cards: [card('diamonds', '7'), card('diamonds', '8'), card('diamonds', '9')],
    suit: 'diamonds',
    highRank: '9',
  }),
]

function completed(trickIndex: number, plays: Array<{ seat: Seat; card: Card }>, winnerSeat: Seat): any {
  return { trickIndex, leaderSeat: plays[0]!.seat, plays, winnerSeat, winningTeam: teamBySeat(winnerSeat) }
}

const midPlayState = baseState({
  hands: midPlayHands,
  declarations: midPlayDeclarations,
  playing: {
    hasStarted: true,
    currentTurnSeat: 'left',
    currentTrick: { leaderSeat: 'right', currentSeat: 'left', plays: currentTrickPlays, winnerSeat: null, trickIndex: 3 },
    completedTricks: [
      completed(0, completedTrick0, 'bottom'),
      completed(1, completedTrick1, 'bottom'),
      completed(2, completedTrick2, 'right'),
    ],
    lastCompletedTrickWinnerSeat: 'right',
    lastCompletedTrickWinnerTeam: 'B',
    wonTricksBySeat: { bottom: [], right: [], top: [], left: [] },
    wonTricksByTeam: { A: [], B: [] },
    sweepOffer: null,
    declinedSweepSeats: [],
    sweepResolution: null,
  },
})

const midPlayRoom = makeRoom(midPlayState, { awardedPrizePerSeat: { bottom: 900, top: 900 } })
const midPlayHiddenCards = SEATS.flatMap((seat) => midPlayHands[seat])
const spectatorMidPlay = createSpectatorRoomSnapshotMessage(midPlayRoom)

await check('[P1] spectator payload is belot_spectator_snapshot with no seat/token', () => {
  assert(spectatorMidPlay.type === 'belot_spectator_snapshot', `type=${spectatorMidPlay.type}`)
  assert((spectatorMidPlay as any).type !== 'room_snapshot', 'must never be room_snapshot')
  assert(spectatorMidPlay.viewerRole === 'spectator', 'viewerRole must be spectator')
  assert(spectatorMidPlay.yourSeat === null, 'yourSeat must be null')
  assert(spectatorMidPlay.reconnectToken === null, 'reconnectToken must be null')
  const json = JSON.stringify(spectatorMidPlay)
  assert(!json.includes('RECONNECT_TOKEN_SECRET'), 'no participant reconnect token may leak')
})

await check('[P2] ownHand is empty, handCounts are present and correct', () => {
  const game = spectatorMidPlay.game!
  assert(Array.isArray(game.ownHand) && game.ownHand.length === 0, 'ownHand must be []')
  for (const seat of SEATS) {
    assert(game.handCounts[seat] === midPlayHands[seat].length, `handCounts.${seat}=${game.handCounts[seat]}`)
  }
})

await check('[P3] played cards (current trick + latest completed trick) are public', () => {
  const playing = spectatorMidPlay.game!.playing!
  assert(
    JSON.stringify(playing.currentTrickPlays.map((p: any) => p.card.id)) === JSON.stringify(currentTrickPlays.map((p) => p.card.id)),
    'currentTrickPlays must be fully visible',
  )
  assert(playing.latestCompletedTrick !== null, 'latestCompletedTrick must be present')
  assert(
    JSON.stringify(playing.latestCompletedTrick!.plays.map((p: any) => p.card.id)) === JSON.stringify(completedTrick2.map((p) => p.card.id)),
    'latestCompletedTrick plays must be fully visible',
  )
  assert(playing.completedTricksCount === 3, 'completedTricksCount must be public')
})

await check('[P4] validCardIds=null even for the seat on turn; sweepOffer=null', () => {
  const playing = spectatorMidPlay.game!.playing!
  assert(playing.currentTurnSeat === 'left', 'public turn seat stays visible')
  assert(playing.validCardIds === null, 'validCardIds must be null for spectator')
  assert(playing.sweepOffer === null, 'sweepOffer must be null for spectator')
  // sanity: the player on turn DOES get legal moves (proves the field is real)
  const leftPlayer = createRoomSnapshotMessage(midPlayRoom, 'left')
  assert(Array.isArray(leftPlayer.game!.playing!.validCardIds), 'sanity: seat on turn must get validCardIds')
})

await check('[P5] no unplayed card identity (id or suit+rank) anywhere in the payload', () => {
  assertNoHiddenCardLeak(spectatorMidPlay, midPlayHiddenCards, 'mid-play')
})

await check('[P5b] detector sanity: the raw authoritative declarations DO leak — the detector flags them', () => {
  // Суровите ServerDeclaration записи (privateMetadata) = това, което
  // снапшотите изпращаха преди Phase 2B. Ако детекторът не ги хване, [P5]
  // не доказва нищо.
  let detected = false
  try {
    assertNoHiddenCardLeak({ declarations: midPlayState.declarations }, midPlayHiddenCards, 'raw')
  } catch {
    detected = true
  }
  assert(detected, 'the leak detector must flag raw declaration metadata; otherwise [P5] proves nothing')
})

await check('[P6] Терца held in hand -> no cards/cardIds/suit/highRank', () => {
  const tersa = spectatorMidPlay.game!.declarations.find((d: any) => d.seat === 'bottom')!
  assert(tersa.publicLabel === 'Терца' && tersa.type === 'sequence', 'public label/type stay visible')
  assert(tersa.announced === true, 'announced stays visible')
  assert(tersa.cards.length === 0 && tersa.cardIds.length === 0, 'unplayed sequence cards must be redacted')
  assert(tersa.suit === null && tersa.highRank === null, 'suit/highRank must be redacted')
  assert(tersa.points === 20, 'sequence points are implied by the public label and stay visible')
})

await check('[P7] partially hidden Каре -> points=null (rank cannot be inferred), only played card kept', () => {
  const kare = spectatorMidPlay.game!.declarations.find((d: any) => d.seat === 'right')!
  assert(kare.publicLabel === 'Каре', 'public label stays visible')
  assert(kare.points === null, `Каре points must be null while cards are unplayed, got ${kare.points}`)
  assert(kare.highRank === null, 'Каре highRank must be redacted')
  assert(JSON.stringify(kare.cardIds) === JSON.stringify(['diamonds-J']), `only the played jack may stay, got ${JSON.stringify(kare.cardIds)}`)
})

await check('[P8] Белот with one played card -> only the played K, suit visible, unplayed Q absent', () => {
  const belote = spectatorMidPlay.game!.declarations.find((d: any) => d.seat === 'top')!
  assert(JSON.stringify(belote.cardIds) === JSON.stringify(['clubs-K']), `cardIds=${JSON.stringify(belote.cardIds)}`)
  assert(belote.cards.length === 1 && belote.cards[0]!.id === 'clubs-K', 'cards must contain only the played K')
  assert(belote.suit === 'clubs', 'belote suit is visible from the played card')
  assert(!JSON.stringify(belote).includes('clubs-Q'), 'the unplayed Q must not appear')
  // Client bubble trigger contract: declaration.cardIds.includes(trigger.cardId)
  assert(belote.cardIds.includes(currentTrickPlays[1]!.card.id), 'bubble trigger card must remain present')
})

await check('[P9] fully played declaration keeps full metadata', () => {
  const leftTersa = spectatorMidPlay.game!.declarations.find((d: any) => d.seat === 'left')!
  assert(leftTersa.cardIds.length === 3, 'all three played cards visible')
  assert(leftTersa.suit === 'diamonds' && leftTersa.highRank === '9', 'suit/highRank revealed once fully played')
  assert(leftTersa.points === 20, 'points visible')
})

await check('[P10] bidding: canSubmitBid=false and validActions=null for spectator', () => {
  const biddingState = baseState({
    phase: 'bidding',
    hands: midPlayHands,
    bidding: {
      entries: [{ seat: 'right', action: { type: 'pass' } }],
      currentSeat: 'top',
      winningBid: null,
      hasStarted: true,
      hasEnded: false,
      consecutivePasses: 1,
    },
  })
  const room = makeRoom(biddingState)
  const spectator = createSpectatorRoomSnapshotMessage(room)
  assert(spectator.game!.bidding !== null, 'bidding snapshot must be present (public entries)')
  assert(spectator.game!.bidding!.canSubmitBid === false, 'canSubmitBid must be false')
  assert(spectator.game!.bidding!.validActions === null, 'validActions must be null')
  assert(spectator.game!.bidding!.currentBidderSeat === 'top', 'current bidder stays public')
  assert(spectator.game!.bidding!.entries.length === 1, 'public entries stay visible')
  const topPlayer = createRoomSnapshotMessage(room, 'top')
  assert(topPlayer.game!.bidding!.validActions !== null, 'sanity: bidder must get validActions')
  assertNoHiddenCardLeak(spectator, midPlayHiddenCards, 'bidding')
})

await check('[P11] cutting: canSubmitCut=false; undealt deck cards never leak', () => {
  const fullDeck = ALL_SUITS.flatMap((suit) => ALL_RANKS.map((rank) => card(suit, rank)))
  const cuttingState = baseState({
    phase: 'cutting',
    deck: fullDeck,
    round: { dealerSeat: 'bottom', cutterSeat: 'left', firstBidderSeat: 'right', firstDealSeat: 'right', selectedCutIndex: null },
    bidding: { entries: [], currentSeat: null, winningBid: null, hasStarted: false, hasEnded: false, consecutivePasses: 0 },
  })
  const room = makeRoom(cuttingState)
  const spectator = createSpectatorRoomSnapshotMessage(room)
  assert(spectator.game!.cutting !== null, 'cutting snapshot must be present')
  assert(spectator.game!.cutting!.canSubmitCut === false, 'canSubmitCut must be false')
  assert(spectator.game!.cutting!.deckCount === 32, 'deckCount stays public')
  assert(createRoomSnapshotMessage(room, 'left').game!.cutting!.canSubmitCut === true, 'sanity: cutter can cut')
  assertNoHiddenCardLeak(spectator, fullDeck, 'cutting deck')
})

await check('[P12] private prize is null; antiBadLuck/deck never serialized', () => {
  const endedState = baseState({
    phase: 'match-ended',
    hands: { bottom: [], right: [], top: [], left: [] },
    matchEnded: { winnerTeam: 'A', targetScore: 151, finalScore: { teamA: 160, teamB: 90 }, endedAt: 5 },
  })
  const room = makeRoom(endedState, { awardedPrizePerSeat: { bottom: 900, top: 900 } })
  const spectator = createSpectatorRoomSnapshotMessage(room)
  assert(spectator.game!.matchEnded !== null, 'public match result present')
  assert(spectator.game!.matchEnded!.winnerTeam === 'A', 'winner team public')
  assert(spectator.game!.matchEnded!.awardedPrizeAmount === null, 'awardedPrizeAmount must be null')
  assert(createRoomSnapshotMessage(room, 'bottom').game!.matchEnded!.awardedPrizeAmount === 900, 'sanity: winner sees prize')
  for (const payload of [spectator, spectatorMidPlay]) {
    const json = JSON.stringify(payload)
    assert(!json.includes('ANTI_BAD_LUCK_SECRET_MARKER') && !json.includes('antiBadLuck'), 'antiBadLuck must never serialize')
    assert(!json.includes('"deck"'), 'deck must never serialize')
  }
})

// ─── "Долу картите" ────────────────────────────────────────────────────────
const sweepHands: Record<Seat, Card[]> = {
  bottom: [card('clubs', 'J'), card('clubs', '9'), card('clubs', 'A')],
  right: [card('diamonds', '7'), card('diamonds', '8'), card('diamonds', 'Q')],
  top: [card('hearts', '7'), card('hearts', '8'), card('hearts', 'Q')],
  left: [card('spades', '7'), card('spades', '8'), card('spades', 'Q')],
}
// Filler взятки (mirror на checkSweepDownTheCards.ts fillerTrick) — clubs 7 с
// уникален suffix; clubs 7 не е в нито една ръка, затова не се бърка с [P5]
// suit+rank проверката.
const sweepFillerTricks = Array.from({ length: 5 }, (_, i) =>
  completed(
    i,
    SEATS.map((seat) => ({ seat, card: { id: `clubs-7-filler-${i}-${seat}`, suit: 'clubs' as Suit, rank: '7' as Rank } })),
    'bottom',
  ),
)
const sweepOfferState = baseState({
  hands: sweepHands,
  playing: {
    hasStarted: true,
    currentTurnSeat: null,
    currentTrick: { leaderSeat: 'bottom', currentSeat: null, plays: [], winnerSeat: null, trickIndex: 5 },
    completedTricks: sweepFillerTricks,
    lastCompletedTrickWinnerSeat: 'bottom',
    lastCompletedTrickWinnerTeam: 'A',
    wonTricksBySeat: { bottom: [], right: [], top: [], left: [] },
    wonTricksByTeam: { A: [], B: [] },
    sweepOffer: { seat: 'bottom', offeredAtTrickIndex: 5, expiresAt: Date.now() + 15000 },
    declinedSweepSeats: [],
    sweepResolution: null,
  },
})
const sweepHiddenCards = SEATS.flatMap((seat) => sweepHands[seat])

await check('[P13] before acceptance: no sweepOffer, no handsAtResolution, no deadline side-channel, no hand leak', () => {
  const room = makeRoom(sweepOfferState, { timerDeadlineAt: Date.now() + 15000 })
  const spectator = createSpectatorRoomSnapshotMessage(room)
  const playing = spectator.game!.playing!
  assert(playing.sweepOffer === null, 'sweepOffer must be hidden before acceptance')
  assert(playing.sweepResolution === null, 'no sweepResolution before acceptance')
  assert(!JSON.stringify(spectator).includes('handsAtResolution'), 'handsAtResolution must not exist before acceptance')
  assert(spectator.game!.timerDeadlineAt === null, 'timerDeadlineAt must be hidden while a private sweep offer is pending')
  assertNoHiddenCardLeak(spectator, sweepHiddenCards, 'sweep offer pending')
  // sanity: offered player sees the offer, normal player snapshot keeps its deadline (Phase 2A changes nothing there)
  const offered = createRoomSnapshotMessage(room, 'bottom')
  assert(offered.game!.playing!.sweepOffer !== null, 'sanity: offered seat sees sweepOffer')
  assert(offered.game!.timerDeadlineAt !== null, 'player snapshot deadline must stay unchanged')
})

await check('[P14] after acceptance: handsAtResolution is public and complete for spectator', () => {
  const resolvedState = submitServerSweepDecision(sweepOfferState, 'bottom', 'accept')
  assert(resolvedState !== sweepOfferState, 'fixture: accept must succeed')
  const spectator = createSpectatorRoomSnapshotMessage(makeRoom(resolvedState))
  const resolution = spectator.game!.playing!.sweepResolution
  assert(resolution !== null, 'sweepResolution must be present after acceptance')
  for (const seat of SEATS) {
    assert(
      JSON.stringify(resolution!.handsAtResolution[seat].map((c: any) => c.id).sort()) ===
        JSON.stringify(sweepHands[seat].map((c) => c.id).sort()),
      `handsAtResolution.${seat} must be the full public reveal`,
    )
  }
  assert(resolution!.winnerSeat === 'bottom', 'winnerSeat public')
  assert(spectator.game!.playing!.sweepOffer === null, 'sweepOffer stays null')
})

await check('[P15] player snapshot keeps its own private data; declarations use the SAME public projection as spectator (Phase 2B)', () => {
  const player = createRoomSnapshotMessage(midPlayRoom, 'bottom')
  assert(player.type === 'room_snapshot', 'player snapshot type unchanged')
  assert(player.reconnectToken === 'RECONNECT_TOKEN_SECRET_bottom', 'player keeps own reconnect token')
  assert(player.game!.ownHand.length === midPlayHands.bottom.length, 'player keeps own hand')
  assert(
    JSON.stringify(player.game!.declarations) === JSON.stringify(spectatorMidPlay.game!.declarations),
    'player and spectator must receive the identical canonical declaration projection',
  )
  const kare = player.game!.declarations.find((d: any) => d.seat === 'right')!
  assert(kare.points === null && JSON.stringify(kare.cardIds) === JSON.stringify(['diamonds-J']), 'opponent Каре stays redacted for players too')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
