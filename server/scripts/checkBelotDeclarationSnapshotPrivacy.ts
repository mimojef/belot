/**
 * checkBelotDeclarationSnapshotPrivacy.ts
 *
 * SECURITY regression за Phase 2B — private declaration metadata
 * (cards/cardIds/suit/highRank, Каре points) НЕ изтича към нормалните Belot
 * играчи. Декларациите идват от РЕАЛНИТЕ server reducer-и
 * (startServerPlayingPhase -> bot Каре; submitServerPlayCard -> човешка Терца
 * и Белот), а не от ръчно сглобени записи.
 *
 * Модел (НЕ наивен "няма думата hearts"): за всеки viewer V скритите карти са
 * ВСИЧКИ карти в ръце, освен собствената ръка на V (тя легитимно е в
 * V.ownHand). Сканира се целият payload БЕЗ ownHand — нито card id, нито
 * {suit, rank} обект на скрита карта не бива да присъства. Отделно се
 * проверяват конкретните declaration полета.
 *
 * Покрива:
 *   [D1]  bidding/cutting: declarations [] (нищо за изтичане)
 *   [D2]  bot Каре (startServerPlayingPhase): никой viewer не вижда ранга/картите
 *   [D3]  човешка Терца с 2 карти още в ръката: opponent не вижда неизиграните
 *   [D4]  partner също не вижда чуждата private metadata
 *   [D5]  owner получава СЪЩАТА публична проекция (собствените карти са само
 *         в ownHand) — клиентът не се нуждае от повече
 *   [D6]  след изиграване на една карта на Каре: само тя се появява, points/rank скрити
 *   [D7]  подписът на балончето (seat/type/publicLabel/points/trick/index) е
 *         стабилен през цялата взятка на обявяване — балончето не се повтаря
 *   [D8]  Белот: само изиграната карта, suit видим, trigger contract
 *         (cardIds.includes(изиграната карта)) работи; неизиграната Дама/Поп я няма
 *   [D9]  след изиграване на всички карти: metadata става пълна
 *   [D10] reconnect по време на playing (JSON persist/restore round-trip +
 *         normalizeRestoredAuthoritativeState): hidden metadata НЕ се връща
 *   [D11] scoring: пълна metadata; renderScoringScreen HTML е байт-идентичен
 *         с рендер от суровата пълна metadata (UI без регресия)
 *   [D12] reconnect по време на scoring/match-ended: пълна metadata
 *   [D13] "Долу картите" accepted: декларациите стават пълни, handsAtResolution непокътнат
 *   [D14] spectator projection: идентични декларации + всички Phase 2A гаранции
 *   [D15] authoritative state НЕ е мутиран — redaction е само view проекция
 */

const { createRoomSnapshotMessage, createSpectatorRoomSnapshotMessage } = await import(
  '../src/protocol/createRoomSnapshotMessage.js'
)
const { startServerPlayingPhase } = await import('../src/game/startServerPlayingPhase.js')
const { submitServerPlayCard } = await import('../src/game/submitServerPlayCard.js')
const { submitServerSweepDecision } = await import('../src/game/submitServerSweepDecision.js')
const { detectServerDeclarationsInHand } = await import('../src/game/declarations/index.js')
const { createServerDeclarationRecord } = await import('../src/game/serverDeclarationRecordHelpers.js')
const { normalizeRestoredAuthoritativeState } = await import('../src/game/normalizeRestoredAuthoritativeState.js')
const { renderScoringScreen } = await import('../../src/app/activeRoom/renderScoringPanel.js')

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

console.log('\n═══ checkBelotDeclarationSnapshotPrivacy ═══')

type Seat = 'bottom' | 'right' | 'top' | 'left'
type Suit = 'clubs' | 'diamonds' | 'hearts' | 'spades'
type Rank = '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A'
type Card = { id: string; suit: Suit; rank: Rank }

const SEATS: Seat[] = ['bottom', 'right', 'top', 'left']
const VIEWERS: Array<Seat | 'spectator'> = [...SEATS, 'spectator']
function card(suit: Suit, rank: Rank): Card {
  return { id: `${suit}-${rank}`, suit, rank }
}
function teamBySeat(seat: Seat): 'A' | 'B' {
  return seat === 'bottom' || seat === 'top' ? 'A' : 'B'
}
function emptyRoundScore() {
  return { teamA: 0, teamB: 0 }
}

const HEARTS_TRUMP = { seat: 'bottom', contract: 'suit', trumpSuit: 'hearts', doubled: false, redoubled: false } as const

// Пълна, непокриваща се раздаване (32 карти):
//  bottom (A, owner на Терца spades 7-8-9)
//  right  (B, BOT — Каре валета, обявено автоматично от startServerPlayingPhase)
//  top    (A, partner на bottom — Белот hearts K+Q, коз)
//  left   (B, opponent)
const INITIAL_HANDS: Record<Seat, Card[]> = {
  bottom: [card('spades', '7'), card('spades', '8'), card('spades', '9'), card('clubs', '10'), card('diamonds', '7'), card('diamonds', '8'), card('clubs', '7'), card('clubs', '8')],
  right: [card('clubs', 'J'), card('diamonds', 'J'), card('hearts', 'J'), card('spades', 'J'), card('clubs', 'A'), card('diamonds', 'A'), card('clubs', 'K'), card('diamonds', 'K')],
  top: [card('hearts', 'K'), card('hearts', 'Q'), card('hearts', '7'), card('spades', '10'), card('spades', 'A'), card('clubs', '9'), card('diamonds', '9'), card('diamonds', '10')],
  left: [card('clubs', 'Q'), card('diamonds', 'Q'), card('hearts', '8'), card('hearts', '9'), card('hearts', '10'), card('hearts', 'A'), card('spades', 'Q'), card('spades', 'K')],
}

function baseState(overrides: Record<string, any> = {}): any {
  return {
    phase: 'deal-last-3',
    phaseEnteredAt: Date.now(),
    targetScore: 151,
    players: Object.fromEntries(
      SEATS.map((seat) => [seat, { seat, team: teamBySeat(seat), mode: seat === 'right' ? 'bot' : 'human', controlledByBot: false }]),
    ),
    round: { dealerSeat: 'left', cutterSeat: 'top', firstBidderSeat: 'bottom', firstDealSeat: 'bottom', selectedCutIndex: 7 },
    deck: [],
    hands: structuredClone(INITIAL_HANDS),
    bidding: { entries: [], currentSeat: null, winningBid: { ...HEARTS_TRUMP }, hasStarted: true, hasEnded: true, consecutivePasses: 3 },
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
      round: { tricks: emptyRoundScore(), declarations: emptyRoundScore(), belote: emptyRoundScore(), lastTen: emptyRoundScore(), capot: emptyRoundScore(), total: emptyRoundScore() },
      match: { teamA: 30, teamB: 12 },
      carryOver: emptyRoundScore(),
    },
    timer: { activeSeat: null, startedAt: null, durationMs: null, expiresAt: null },
    ...overrides,
  }
}

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
    identity: { accountId: null, profileId: `profile-${seat}`, username: null, displayName: `P ${seat}`, avatarUrl: null, level: 1, rankTitle: null, skillRating: null, gender: 'male' },
  }
}

function makeRoom(authoritativeState: any): any {
  return {
    id: 'room-declaration-privacy',
    status: 'playing',
    createdAt: 1,
    updatedAt: 1,
    hostPlayerId: null,
    config: { maxPlayers: 4, allowBots: true, isPrivate: true, joinCode: null, stakeAmount: 5000, targetScore: 151, turnTimeMs: 15000, reconnectGraceMs: 60000, isPrivateTableOrigin: true },
    seats: Object.fromEntries(SEATS.map((seat) => [seat, { seat, team: teamBySeat(seat), participant: humanParticipant(seat) }])),
    game: { phase: 'playing', stateVersion: 1, startedAt: 1, updatedAt: 1, activeTimerId: null, timerDeadlineAt: Date.now() + 15000, authoritativeState },
    replayVotes: [],
    leaveVotes: [],
  }
}

function snapshotFor(state: any, viewer: Seat | 'spectator'): any {
  const room = makeRoom(state)
  return viewer === 'spectator' ? createSpectatorRoomSnapshotMessage(room) : createRoomSnapshotMessage(room, viewer)
}

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

/** Скритите за viewer-а карти = всички ръце без неговата собствена. */
function hiddenCardsFor(state: any, viewer: Seat | 'spectator'): Card[] {
  return SEATS.filter((seat) => seat !== viewer).flatMap((seat) => state.hands[seat] as Card[])
}

function assertViewerSeesNoHiddenCard(state: any, viewer: Seat | 'spectator', label: string): void {
  const snapshot = snapshotFor(state, viewer)
  const withoutOwnHand = JSON.parse(JSON.stringify(snapshot))
  if (withoutOwnHand.game) withoutOwnHand.game.ownHand = []
  const json = JSON.stringify(withoutOwnHand)
  const objects = collectCardLikeObjects(withoutOwnHand)
  for (const hidden of hiddenCardsFor(state, viewer)) {
    assert(!json.includes(`"${hidden.id}"`), `${label} [viewer=${viewer}]: hidden card id ${hidden.id} leaked`)
    assert(!objects.some((o) => o.suit === hidden.suit && o.rank === hidden.rank), `${label} [viewer=${viewer}]: hidden card ${hidden.id} leaked as {suit,rank}`)
  }
}

function declarationOf(snapshot: any, seat: Seat, type: string): any {
  return snapshot.game.declarations.find((d: any) => d.seat === seat && d.type === type)
}

function signatureOf(declaration: any, index: number): string {
  // Mirror на getDeclarationSignature (src/app/activeRoom/renderPlayingScreen.ts).
  return [declaration.seat, declaration.type, declaration.publicLabel, String(declaration.points), String(declaration.declaredAtTrickIndex), String(index)].join(':')
}

function candidateKey(hand: Card[], type: string): string {
  const candidate = detectServerDeclarationsInHand(hand, HEARTS_TRUMP).find((c: any) => c.type === type)
  assert(candidate !== undefined, `fixture: no ${type} candidate`)
  return candidate!.key
}

function play(state: any, seat: Seat, cardId: string, declarationKeys: string[] = []): any {
  const next = submitServerPlayCard(state, seat, cardId, declarationKeys)
  assert(next !== state, `fixture: ${seat} could not play ${cardId}`)
  return next
}

// ─── Реален поток ─────────────────────────────────────────────────────────

const afterStart = startServerPlayingPhase(baseState())
const afterBottomTersa = play(afterStart, 'bottom', 'spades-7', [candidateKey(INITIAL_HANDS.bottom, 'sequence')])
const afterRightJack = play(afterBottomTersa, 'right', 'spades-J')
const afterTopAce = play(afterRightJack, 'top', 'spades-A')
const afterTrick0 = play(afterTopAce, 'left', 'spades-Q')
const topHandAtTrick1 = afterTrick0.hands.top as Card[]
const afterTopBelote = play(afterTrick0, 'top', 'hearts-K', [candidateKey(topHandAtTrick1, 'belote')])

await check('[D1] bidding/cutting snapshots carry no declarations', () => {
  for (const phase of ['cutting', 'bidding'] as const) {
    const state = baseState({ phase, bidding: { entries: [], currentSeat: 'bottom', winningBid: null, hasStarted: phase === 'bidding', hasEnded: false, consecutivePasses: 0 } })
    for (const viewer of VIEWERS) {
      assert(snapshotFor(state, viewer).game.declarations.length === 0, `${phase}/${viewer}: declarations must be []`)
      assertViewerSeesNoHiddenCard(state, viewer, phase)
    }
  }
})

await check('[D2] bot Каре (startServerPlayingPhase) reveals neither cards nor rank to anyone', () => {
  const rawKare = afterStart.declarations.find((d: any) => d.seat === 'right' && d.type === 'square')
  assert(rawKare !== undefined && rawKare.points === 200 && rawKare.cardIds.length === 4, 'fixture: bot must auto-declare Каре валета (200)')
  for (const viewer of VIEWERS) {
    const kare = declarationOf(snapshotFor(afterStart, viewer), 'right', 'square')
    assert(kare.publicLabel === 'Каре' && kare.announced === true, `${viewer}: public label visible`)
    assert(kare.cards.length === 0 && kare.cardIds.length === 0, `${viewer}: no Каре card may leak`)
    assert(kare.points === null && kare.highRank === null && kare.suit === null, `${viewer}: points/rank/suit must be hidden`)
    assertViewerSeesNoHiddenCard(afterStart, viewer, 'bot Каре')
  }
})

await check('[D3] human Терца with 2 cards still in hand: opponents see only the played card', () => {
  const raw = afterBottomTersa.declarations.find((d: any) => d.seat === 'bottom' && d.type === 'sequence')
  assert(raw !== undefined && raw.cardIds.length === 3, 'fixture: Терца recorded via submitServerPlayCard')
  for (const viewer of ['right', 'left'] as Seat[]) {
    const tersa = declarationOf(snapshotFor(afterBottomTersa, viewer), 'bottom', 'sequence')
    assert(JSON.stringify(tersa.cardIds) === JSON.stringify(['spades-7']), `${viewer}: cardIds=${JSON.stringify(tersa.cardIds)}`)
    assert(tersa.suit === null && tersa.highRank === null, `${viewer}: suit/highRank hidden`)
    assert(tersa.publicLabel === 'Терца' && tersa.points === 20, `${viewer}: public label/points stay visible`)
    assertViewerSeesNoHiddenCard(afterBottomTersa, viewer, 'Терца opponent')
  }
})

await check('[D4] partner gets no private metadata of the teammate declaration either', () => {
  const tersa = declarationOf(snapshotFor(afterBottomTersa, 'top'), 'bottom', 'sequence')
  assert(JSON.stringify(tersa.cardIds) === JSON.stringify(['spades-7']), `partner cardIds=${JSON.stringify(tersa.cardIds)}`)
  assert(!JSON.stringify(tersa).includes('spades-8') && !JSON.stringify(tersa).includes('spades-9'), 'unplayed teammate cards hidden')
  assertViewerSeesNoHiddenCard(afterBottomTersa, 'top', 'Терца partner')
})

await check('[D5] owner gets the same public projection; own cards remain only in ownHand', () => {
  const ownerSnapshot = snapshotFor(afterBottomTersa, 'bottom')
  const tersa = declarationOf(ownerSnapshot, 'bottom', 'sequence')
  assert(JSON.stringify(tersa) === JSON.stringify(declarationOf(snapshotFor(afterBottomTersa, 'right'), 'bottom', 'sequence')), 'owner and opponent projections are identical')
  const ownIds = ownerSnapshot.game.ownHand.map((c: any) => c.id)
  assert(ownIds.includes('spades-8') && ownIds.includes('spades-9'), 'owner still knows the rest of the sequence via ownHand')
  // Bubble contract за собственика (същия като за всички): label/type/trick/announced.
  assert(tersa.type === 'sequence' && tersa.publicLabel === 'Терца' && tersa.announced && tersa.declaredAtTrickIndex === 0, 'own bubble fields intact')
  assertViewerSeesNoHiddenCard(afterBottomTersa, 'bottom', 'Терца owner')
})

await check('[D6] Каре after one jack is played: only that jack appears, points/rank stay hidden', () => {
  for (const viewer of VIEWERS) {
    const kare = declarationOf(snapshotFor(afterRightJack, viewer), 'right', 'square')
    assert(JSON.stringify(kare.cardIds) === JSON.stringify(['spades-J']), `${viewer}: cardIds=${JSON.stringify(kare.cardIds)}`)
    assert(kare.points === null && kare.highRank === null, `${viewer}: Каре rank must not be inferable`)
    assertViewerSeesNoHiddenCard(afterRightJack, viewer, 'Каре partial')
  }
})

await check('[D7] bubble signature is stable for every viewer through the whole declaring trick', () => {
  for (const viewer of VIEWERS) {
    const signatures = [afterBottomTersa, afterRightJack, afterTopAce].map((state) => {
      const declarations = snapshotFor(state, viewer).game.declarations
      return declarations.map((d: any, index: number) => signatureOf(d, index)).join('|')
    })
    assert(new Set(signatures).size === 1, `${viewer}: signature changed within trick 0: ${JSON.stringify(signatures)}`)
  }
})

await check('[D8] Белот: only the played K, suit visible, trigger contract works, unplayed Q absent', () => {
  for (const viewer of VIEWERS) {
    const snapshot = snapshotFor(afterTopBelote, viewer)
    const belote = declarationOf(snapshot, 'top', 'belote')
    assert(belote !== undefined, `${viewer}: belote recorded`)
    assert(JSON.stringify(belote.cardIds) === JSON.stringify(['hearts-K']), `${viewer}: cardIds=${JSON.stringify(belote.cardIds)}`)
    assert(belote.suit === 'hearts' && belote.publicLabel === 'Белот' && belote.points === 20, `${viewer}: public belote info`)
    assert(belote.declaredAtTrickIndex === 1, 'declared at trick 1')
    // Client trigger (renderPlayingScreen buildPendingDeclarationBubbleForTrigger):
    const trigger = snapshot.game.playing.currentTrickPlays.find((p: any) => p.seat === 'top')
    assert(trigger && belote.cardIds.includes(trigger.card.id), `${viewer}: bubble trigger must match the played card`)
    if (viewer !== 'top') assertViewerSeesNoHiddenCard(afterTopBelote, viewer, 'Белот')
    assert(viewer === 'top' || !JSON.stringify(snapshot).includes('hearts-Q'), `${viewer}: unplayed Q must not appear`)
  }
})

// "Всички карти изиграни" — проекцията зависи само от това кои карти са в ръце.
function withCardsPlayed(state: any, cardIds: string[]): any {
  const next = structuredClone(state)
  for (const seat of SEATS) {
    next.hands[seat] = next.hands[seat].filter((c: Card) => !cardIds.includes(c.id))
  }
  return next
}

await check('[D9] once every card of a declaration is played, its metadata becomes public', () => {
  const state = withCardsPlayed(afterTopBelote, ['spades-8', 'spades-9', 'hearts-Q', 'clubs-J', 'diamonds-J', 'hearts-J'])
  for (const viewer of VIEWERS) {
    const snapshot = snapshotFor(state, viewer)
    const tersa = declarationOf(snapshot, 'bottom', 'sequence')
    assert(tersa.cardIds.length === 3 && tersa.suit === 'spades' && tersa.highRank === '9', `${viewer}: Терца fully public`)
    const kare = declarationOf(snapshot, 'right', 'square')
    assert(kare.cardIds.length === 4 && kare.points === 200 && kare.highRank === 'J', `${viewer}: Каре fully public`)
    const belote = declarationOf(snapshot, 'top', 'belote')
    assert(belote.cardIds.length === 2, `${viewer}: Белот fully public`)
  }
})

await check('[D10] reconnect during playing (persist/restore round-trip) never restores hidden metadata', () => {
  const restored = normalizeRestoredAuthoritativeState(JSON.parse(JSON.stringify(afterTopBelote)))
  for (const viewer of VIEWERS) {
    const live = snapshotFor(afterTopBelote, viewer)
    const reconnect = snapshotFor(restored, viewer)
    assert(JSON.stringify(reconnect.game.declarations) === JSON.stringify(live.game.declarations), `${viewer}: reconnect projection must equal live projection`)
    if (viewer !== 'top') assertViewerSeesNoHiddenCard(restored, viewer, 'reconnect playing')
    const tersa = declarationOf(reconnect, 'bottom', 'sequence')
    assert(JSON.stringify(tersa.cardIds) === JSON.stringify(['spades-7']), `${viewer}: reconnect keeps Терца redacted`)
  }
})

// ─── Scoring ──────────────────────────────────────────────────────────────

const SCORING = {
  winningBid: { ...HEARTS_TRUMP },
  rawHandPoints: { teamA: 98, teamB: 64 },
  rawHandTricksWon: { teamA: 5, teamB: 3 },
  declarationPoints: { teamA: 20, teamB: 200 },
  belotePoints: { teamA: 20, teamB: 0 },
  sumPoints: { teamA: 138, teamB: 264 },
  officialRoundPoints: { teamA: 14, teamB: 26 },
  matchTotals: { teamA: 44, teamB: 38 },
  carryOver: { teamA: 0, teamB: 0 },
  isCapotRound: false,
  isNonCapotRound: true,
  outcomeLabel: 'Изкарана',
  outcomeShortLabel: 'Изк.',
  outcome: 'made',
  counterMultiplier: 1,
}
const scoringState = {
  ...structuredClone(afterTopBelote),
  phase: 'scoring',
  hands: { bottom: [], right: [], top: [], left: [] },
  playing: null,
  scoring: SCORING,
}

function rawFullDeclarations(state: any): any[] {
  // Как изглеждаха декларациите преди Phase 2B — суровата пълна metadata.
  return state.declarations.map((d: any) => ({
    seat: d.seat, team: d.team, type: d.type, publicLabel: d.publicLabel, points: d.points,
    cards: d.cards.map((c: Card) => ({ id: c.id, suit: c.suit, rank: c.rank })), cardIds: d.cardIds,
    suit: d.suit, highRank: d.highRank, declaredAtTrickIndex: d.declaredAtTrickIndex, announced: d.announced, valid: d.valid,
  }))
}

function renderScoringHtml(game: any, localSeat: Seat): string {
  const root: any = { innerHTML: '' }
  renderScoringScreen({ root, game, seats: [], localSeat, winningBid: game.scoring.winningBid, countdownSeconds: 7, animateSumCounters: false, stageScale: 1, scaledStageWidth: 1600, scaledStageHeight: 900 })
  return root.innerHTML
}

await check('[D11] scoring: full metadata, renderScoringScreen HTML identical to rendering raw full metadata', () => {
  const full = rawFullDeclarations(scoringState)
  for (const viewer of SEATS) {
    const snapshot = snapshotFor(scoringState, viewer)
    assert(JSON.stringify(snapshot.game.declarations) === JSON.stringify(full), `${viewer}: scoring declarations must be complete`)
    const html = renderScoringHtml(snapshot.game, viewer)
    const baselineHtml = renderScoringHtml({ ...snapshot.game, declarations: full }, viewer)
    assert(html === baselineHtml, `${viewer}: scoring panel HTML must be byte-identical`)
    // Токените на панела (renderDeclarationToken) идват от cards/suit/highRank —
    // точно metadata-та, която по време на игра е скрита: Терца ♠ "7 8 9",
    // Каре "J J J J", Белот ♥.
    assert(html.includes('&spades;') && html.includes('>7 8 9<'), `${viewer}: Терца token rendered`)
    assert(html.includes('>J J J J<'), `${viewer}: Каре token rendered`)
    assert(html.includes('&hearts;'), `${viewer}: Белот token rendered`)
  }
})

await check('[D12] reconnect during scoring / match-ended: full metadata', () => {
  const restoredScoring = normalizeRestoredAuthoritativeState(JSON.parse(JSON.stringify(scoringState)))
  const ended = { ...structuredClone(scoringState), phase: 'match-ended', matchEnded: { winnerTeam: 'B', targetScore: 151, finalScore: { teamA: 44, teamB: 160 }, endedAt: 5 } }
  for (const state of [restoredScoring, ended]) {
    for (const viewer of VIEWERS) {
      assert(JSON.stringify(snapshotFor(state, viewer).game.declarations) === JSON.stringify(rawFullDeclarations(state)), `${state.phase}/${viewer}: full metadata`)
    }
  }
})

// ─── "Долу картите" ───────────────────────────────────────────────────────

await check('[D13] accepted sweep: declarations become public, handsAtResolution intact', () => {
  const sweepHands: Record<Seat, Card[]> = {
    bottom: [card('clubs', 'J'), card('clubs', '9'), card('clubs', 'A')],
    right: [card('diamonds', '7'), card('diamonds', '8'), card('diamonds', 'Q')],
    top: [card('hearts', '7'), card('hearts', '8'), card('hearts', 'Q')],
    left: [card('spades', '7'), card('spades', '8'), card('spades', 'Q')],
  }
  // Декларация с карти, които са още в ръката на right (diamonds 7-8 + изигран 9).
  const rightDeclaration = createServerDeclarationRecord({
    candidate: {
      key: 'synthetic-tersa',
      type: 'sequence',
      publicLabel: 'Терца',
      points: 20,
      cardIds: ['diamonds-7', 'diamonds-8', 'diamonds-9'],
      privateMetadata: { cards: [card('diamonds', '7'), card('diamonds', '8'), card('diamonds', '9')], suit: 'diamonds', highRank: '9' },
    } as any,
    seat: 'right',
    declaredAtTrickIndex: 0,
  })
  const filler = Array.from({ length: 5 }, (_, i) => ({
    trickIndex: i,
    leaderSeat: 'bottom',
    winnerSeat: 'bottom',
    winningTeam: 'A',
    plays: SEATS.map((seat) => ({ seat, card: { id: `spades-9-filler-${i}-${seat}`, suit: 'spades', rank: '9' } })),
  }))
  const offerState = baseState({
    phase: 'playing',
    hands: sweepHands,
    bidding: { entries: [], currentSeat: null, winningBid: { seat: 'bottom', contract: 'suit', trumpSuit: 'clubs', doubled: false, redoubled: false }, hasStarted: true, hasEnded: true, consecutivePasses: 3 },
    declarations: [rightDeclaration],
    playing: {
      hasStarted: true,
      currentTurnSeat: null,
      currentTrick: { leaderSeat: 'bottom', currentSeat: null, plays: [], winnerSeat: null, trickIndex: 5 },
      completedTricks: filler,
      lastCompletedTrickWinnerSeat: 'bottom',
      lastCompletedTrickWinnerTeam: 'A',
      wonTricksBySeat: { bottom: [], right: [], top: [], left: [] },
      wonTricksByTeam: { A: [], B: [] },
      sweepOffer: { seat: 'bottom', offeredAtTrickIndex: 5, expiresAt: Date.now() + 15000 },
      declinedSweepSeats: [],
      sweepResolution: null,
    },
  })
  for (const viewer of VIEWERS.filter((v) => v !== 'right')) {
    const tersa = declarationOf(snapshotFor(offerState, viewer), 'right', 'sequence')
    assert(JSON.stringify(tersa.cardIds) === JSON.stringify(['diamonds-9']), `${viewer}: pre-accept Терца redacted`)
    assertViewerSeesNoHiddenCard(offerState, viewer, 'sweep offer')
  }
  const resolved = submitServerSweepDecision(offerState, 'bottom', 'accept')
  assert(resolved !== offerState, 'fixture: sweep accepted')
  for (const viewer of VIEWERS) {
    const snapshot = snapshotFor(resolved, viewer)
    const tersa = declarationOf(snapshot, 'right', 'sequence')
    assert(tersa.cardIds.length === 3 && tersa.suit === 'diamonds', `${viewer}: declaration public after accept`)
    const reveal = snapshot.game.playing.sweepResolution
    for (const seat of SEATS) {
      assert(
        JSON.stringify(reveal.handsAtResolution[seat].map((c: any) => c.id).sort()) === JSON.stringify(sweepHands[seat].map((c) => c.id).sort()),
        `${viewer}: handsAtResolution.${seat} intact`,
      )
    }
  }
})

await check('[D14] spectator: identical declarations, Phase 2A guarantees intact', () => {
  for (const state of [afterStart, afterBottomTersa, afterRightJack, afterTopBelote, scoringState]) {
    const spectator = snapshotFor(state, 'spectator')
    const opponent = snapshotFor(state, 'left')
    assert(JSON.stringify(spectator.game.declarations) === JSON.stringify(opponent.game.declarations), 'spectator == player declaration projection')
    assert(spectator.type === 'belot_spectator_snapshot' && spectator.yourSeat === null && spectator.reconnectToken === null, 'spectator identity')
    assert(spectator.game.ownHand.length === 0, 'ownHand []')
    if (spectator.game.playing) {
      assert(spectator.game.playing.validCardIds === null && spectator.game.playing.sweepOffer === null, 'no legal moves / sweep offer')
    }
    if (state !== scoringState) assertViewerSeesNoHiddenCard(state, 'spectator', 'spectator')
  }
})

await check('[D15] authoritative state is never mutated by the projection', () => {
  const states = [afterStart, afterBottomTersa, afterRightJack, afterTopBelote, scoringState]
  const before = states.map((s) => JSON.stringify(s))
  for (const state of states) {
    for (const viewer of VIEWERS) snapshotFor(state, viewer)
  }
  states.forEach((state, i) => assert(JSON.stringify(state) === before[i], `state #${i} mutated`))
  const rawTersa = afterTopBelote.declarations.find((d: any) => d.seat === 'bottom' && d.type === 'sequence')
  assert(rawTersa.cardIds.length === 3 && rawTersa.cards.length === 3 && rawTersa.highRank === '9', 'authoritative declaration keeps full private metadata')
  const rawKare = afterTopBelote.declarations.find((d: any) => d.type === 'square')
  assert(rawKare.points === 200, 'authoritative Каре keeps its points for scoring')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
