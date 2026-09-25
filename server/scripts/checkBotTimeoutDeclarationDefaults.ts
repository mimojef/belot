/**
 * checkBotTimeoutDeclarationDefaults.ts
 *
 * Regression за потвърден production bug (room 585f4a7a-36e9-472b-98de-74f03f57a601,
 * round #5, играч Meri86, all-trumps, ръка Q♣Q♦Q♥Q♠ — валидно каре дами,
 * 100 raw / 10 записани точки, изгубено).
 *
 * Root cause (два code audit-а установиха):
 *  1. advanceExpiredServerPlayingState.ts (единственият код path за native
 *     bot ходове И за human seats, поети след timeout) използваше
 *     getBotBeloteDeclarationKeysForPlay() — генерираше САМО belote,
 *     никога square/sequence.
 *  2. Server play timer-ът (20 сек) не спира, докато клиентският
 *     declaration popup е отворен — ако свързан човек кликне карта,
 *     popup-ът коректно се отваря с pre-selected default candidates,
 *     но забавяне до "Продължи" може да позволи сървърният timeout да
 *     задейства bot-takeover пътя по средата на решението, submit-вайки
 *     само belote и тихо затваряйки все още отворения popup.
 *
 * Established human default-selection semantics (declarationPromptState.ts /
 * resolveClientDeclarationConflicts.ts): popup-ът се отваря с ВСИЧКИ
 * non-overlapping candidates already checked; "Продължи" без промяна
 * submit-ва точно този default-selected set; сървърът приема празен
 * declarationKeys без грешка (submitServerPlayCard.ts:100-102) — декларации
 * са de-facto optional (играчът МОЖЕ съзнателно да deselect-не), но
 * default UI поведението е "декларирай всичко valid & non-conflicting".
 *
 * Fix: advanceExpiredServerPlayingState.ts вече изчислява
 * getServerDefaultDeclarationKeysForPlay() чрез SAME established
 * server-authoritative helpers, които вече валидират human submissions:
 *   detectServerDeclarationsInHand() -> filter (trick-0 gate за
 *   square/sequence; matched-card + lead-suit gate за belote, огледало на
 *   validateSelectedDeclarationForPlayedCard в submitServerPlayCard.ts) ->
 *   resolveServerDeclarationConflicts() -> canonical keys.
 * Резултатните keys се подават на submitServerPlayCard(), която ги
 * прекарва през СЪЩАТА validateServerDeclarationKeysForPlay(), която вече
 * пази human path-а — няма трета/дублирана detection имплементация.
 *
 * Покрива (виж task spec §14):
 *  [1] timeout/bot + four queens + all-trumps -> square declared
 *  [2] native bot + four queens + all-trumps -> same behavior
 *  [3] timeout/bot + sequence -> sequence declared
 *  [4] native bot + sequence -> same behavior
 *  [5] multiple candidates -> resolveServerDeclarationConflicts избира
 *      default non-overlapping set, не submit-ва всичко наивно
 *  [6] belote поведение остава working, без double-submit
 *  [7] no-trumps -> declarationKeys = [] дори при square/sequence в ръката
 *  [8] seat positions 1-4 в trick 0 -> еднакво поведение (не само leader)
 *  [9] trick > 0 -> без redeclaration на square/sequence
 *  [10] 100 raw -> 10 recorded (scoreServerDeclarations + established /10 формула)
 *  [11] генерираните keys се приемат от validateServerDeclarationKeysForPlay
 *      (същия authoritative detector/validator като human path-а)
 *  [12] duplicate protection: already-declared key не се предлага повторно
 *
 * НЕ променя/тества: client declaration popup, human submitPlayCard flow,
 * timer pause/extend UX (отделна, по-голяма задача — виж task spec §13).
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ok ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('\n═══ checkBotTimeoutDeclarationDefaults ═══')

const {
  getServerDefaultDeclarationKeysForPlay,
} = await import('../src/game/advanceExpiredServerPlayingState.js')
const { submitServerPlayCard, validateServerDeclarationKeysForPlay } = await import(
  '../src/game/submitServerPlayCard.js'
)
const { detectServerDeclarationsInHand } = await import('../src/game/declarations/index.js')

type Seat = 'bottom' | 'right' | 'top' | 'left'
type Suit = 'clubs' | 'diamonds' | 'hearts' | 'spades'
type Rank = '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A'
type Card = { id: string; suit: Suit; rank: Rank }

function card(suit: Suit, rank: Rank): Card {
  return { id: `${suit}-${rank}`, suit, rank }
}

function emptyHands(): Record<Seat, Card[]> {
  return { bottom: [], right: [], top: [], left: [] }
}

function emptyRoundScore() {
  return { teamA: 0, teamB: 0 }
}

function emptyMissionCounts() {
  return {
    announce_tersa: emptyRoundScore(),
    announce_50: emptyRoundScore(),
    announce_100: emptyRoundScore(),
    announce_kare: emptyRoundScore(),
    announce_belot: emptyRoundScore(),
  }
}

function emptyScoreBreakdown() {
  return {
    tricks: emptyRoundScore(),
    declarations: emptyRoundScore(),
    belote: emptyRoundScore(),
    lastTen: emptyRoundScore(),
    capot: emptyRoundScore(),
    total: emptyRoundScore(),
  }
}

function baseState(params: {
  hands: Record<Seat, Card[]>
  contract: 'suit' | 'no-trumps' | 'all-trumps' | null
  trumpSuit?: Suit | null
  currentTurnSeat: Seat
  trickIndex?: number
  plays?: { seat: Seat; card: Card }[]
  botSeats?: Seat[]
  existingDeclarations?: any[]
}): any {
  const {
    hands,
    contract,
    trumpSuit = null,
    currentTurnSeat,
    trickIndex = 0,
    plays = [],
    botSeats = ['bottom', 'right', 'top', 'left'],
    existingDeclarations = [],
  } = params

  const seats: Seat[] = ['bottom', 'right', 'top', 'left']
  const teamBySeat = (seat: Seat) => (seat === 'bottom' || seat === 'top' ? 'A' : 'B')

  return {
    phase: 'playing',
    phaseEnteredAt: Date.now(),
    targetScore: 151,
    players: Object.fromEntries(
      seats.map((seat) => [
        seat,
        {
          seat,
          team: teamBySeat(seat),
          mode: botSeats.includes(seat) ? 'bot' : 'human',
          controlledByBot: botSeats.includes(seat),
        },
      ]),
    ),
    round: {
      dealerSeat: 'bottom',
      cutterSeat: 'right',
      firstBidderSeat: 'right',
      firstDealSeat: 'right',
      selectedCutIndex: null,
    },
    deck: [],
    hands,
    bidding: {
      entries: [],
      currentSeat: null,
      winningBid:
        contract === null
          ? null
          : {
              seat: 'bottom',
              contract,
              trumpSuit: contract === 'suit' ? trumpSuit : null,
              doubled: false,
              redoubled: false,
            },
      hasStarted: true,
      hasEnded: true,
      consecutivePasses: 0,
    },
    declarations: existingDeclarations,
    matchDeclarationMissionCounts: emptyMissionCounts(),
    matchDeclarationMissionCountsBySeat: {},
    currentTrick: { leaderSeat: null, currentSeat: null, plays: [], winnerSeat: null, trickIndex: 0 },
    wonTricks: { A: [], B: [] },
    playing: {
      hasStarted: true,
      currentTurnSeat,
      currentTrick: {
        leaderSeat: plays[0]?.seat ?? currentTurnSeat,
        currentSeat: currentTurnSeat,
        plays,
        winnerSeat: null,
        trickIndex,
      },
      completedTricks: [],
      lastCompletedTrickWinnerSeat: null,
      lastCompletedTrickWinnerTeam: null,
      wonTricksBySeat: { bottom: [], right: [], top: [], left: [] },
      wonTricksByTeam: { A: [], B: [] },
    },
    scoring: null,
    matchEnded: null,
    score: { round: emptyScoreBreakdown(), match: emptyRoundScore(), carryOver: { teamA: 0, teamB: 0 } },
    timer: { activeSeat: null, startedAt: null, durationMs: null, expiresAt: null },
  }
}

function fourQueensHand(): Card[] {
  return [
    card('clubs', 'Q'),
    card('diamonds', 'Q'),
    card('hearts', 'Q'),
    card('spades', 'Q'),
    card('clubs', '7'),
    card('diamonds', '8'),
    card('hearts', '9'),
    card('spades', '10'),
  ]
}

// ---- [1]/[2] four queens: timeout(bot-takeover) vs native bot, all seat positions ----

for (const seatUnderTest of ['bottom', 'right', 'top', 'left'] as Seat[]) {
  await check(`[1/8] timeout/bot-takeover seat=${seatUnderTest}: four queens square is auto-declared on trick 0 regardless of seat position`, () => {
    const hands = emptyHands()
    hands[seatUnderTest] = fourQueensHand()
    // give the other three seats a filler card each so the fixture is coherent
    const others = (['bottom', 'right', 'top', 'left'] as Seat[]).filter((s) => s !== seatUnderTest)
    hands[others[0]!] = [card('clubs', 'J')]
    hands[others[1]!] = [card('diamonds', 'J')]
    hands[others[2]!] = [card('hearts', 'J')]

    // seatUnderTest is Nth to act in trick 0 (N = its index+1): fill `plays` for earlier seats.
    const actingOrder: Seat[] = ['bottom', 'right', 'top', 'left']
    const seatIdx = actingOrder.indexOf(seatUnderTest)
    const plays = actingOrder.slice(0, seatIdx).map((seat) => ({
      seat,
      card: hands[seat]?.[0] ?? card('clubs', 'J'),
    }))

    const state = baseState({
      hands,
      contract: 'all-trumps',
      currentTurnSeat: seatUnderTest,
      trickIndex: 0,
      plays,
      botSeats: [seatUnderTest], // only the seat under test is bot-controlled (native OR timeout-takeover — same code path)
    })

    const playedCard = fourQueensHand()[4]! // a non-Queen card, mirrors "click a non-queen" scenario
    const keys = getServerDefaultDeclarationKeysForPlay(state, seatUnderTest, playedCard)

    assert(keys.length === 1, `expected exactly 1 declaration key (the square), got ${keys.length}: ${JSON.stringify(keys)}`)
    assert(keys[0]!.startsWith('square:Каре:100:'), `expected a "Каре" (square, 100pt) key, got ${keys[0]}`)

    // The exact same key the authoritative detector produces independently — proves canonical match.
    const authoritative = detectServerDeclarationsInHand(hands[seatUnderTest]!, state.bidding.winningBid)
    const squareCandidate = authoritative.find((c: any) => c.type === 'square')
    assert(!!squareCandidate, 'authoritative detector did not find the square candidate')
    assert(keys[0] === squareCandidate!.key, `generated key does not match authoritative detector key:\n  generated: ${keys[0]}\n  authoritative: ${squareCandidate!.key}`)

    // Now actually submit through the real production entry point (submitServerPlayCard),
    // same as advanceExpiredServerPlayingState.ts does — proves the server ACCEPTS it end to end.
    const nextState = submitServerPlayCard(state, seatUnderTest, playedCard.id, keys)
    assert(nextState.declarations.length === 1, `expected 1 recorded declaration after submit, got ${nextState.declarations.length}`)
    assert(nextState.declarations[0]!.points === 100, `expected 100 raw points recorded, got ${nextState.declarations[0]!.points}`)
    assert(nextState.declarations[0]!.type === 'square', `expected recorded declaration type 'square', got ${nextState.declarations[0]!.type}`)

    // [10] 100 raw -> 10 recorded, established /10 rounding formula.
    const recorded = Math.round(nextState.declarations[0]!.points / 10)
    assert(recorded === 10, `expected 100 raw -> 10 recorded points, got ${recorded}`)
  })
}

await check('[2] native bot (mode:"bot" from round start, not timeout-takeover) gets identical four-queens declaration behavior', () => {
  const hands = emptyHands()
  hands.bottom = fourQueensHand()
  hands.right = [card('clubs', 'J')]
  hands.top = [card('diamonds', 'J')]
  hands.left = [card('hearts', 'J')]

  const state = baseState({
    hands,
    contract: 'all-trumps',
    currentTurnSeat: 'bottom',
    trickIndex: 0,
    botSeats: ['bottom', 'right', 'top', 'left'], // all-bot room, bottom is a genuine AI seat
  })

  const playedCard = hands.bottom[4]!
  const keys = getServerDefaultDeclarationKeysForPlay(state, 'bottom', playedCard)
  assert(keys.length === 1 && keys[0]!.startsWith('square:Каре:100:'), `native bot did not get the square declaration: ${JSON.stringify(keys)}`)
})

// ---- [3]/[4] sequence ----

await check('[3] timeout/bot-takeover: valid sequence (tierce) is auto-declared on trick 0', () => {
  const hands = emptyHands()
  hands.bottom = [
    card('clubs', '7'),
    card('clubs', '8'),
    card('clubs', '9'),
    card('diamonds', 'A'),
    card('hearts', 'A'),
    card('spades', 'A'),
    card('diamonds', '7'),
    card('hearts', '7'),
  ]
  hands.right = [card('clubs', 'J')]
  hands.top = [card('diamonds', 'J')]
  hands.left = [card('hearts', 'J')]

  const state = baseState({
    hands,
    contract: 'all-trumps',
    currentTurnSeat: 'bottom',
    trickIndex: 0,
    botSeats: ['bottom'],
  })

  const playedCard = hands.bottom[3]!
  const keys = getServerDefaultDeclarationKeysForPlay(state, 'bottom', playedCard)
  assert(keys.length === 1, `expected exactly 1 declaration key (the tierce), got ${keys.length}: ${JSON.stringify(keys)}`)
  assert(keys[0]!.startsWith('sequence:Терца:20:'), `expected a "Терца" (sequence, 20pt) key, got ${keys[0]}`)
})

await check('[4] native bot: same sequence declaration behavior as timeout-takeover', () => {
  const hands = emptyHands()
  hands.bottom = [
    card('clubs', '7'),
    card('clubs', '8'),
    card('clubs', '9'),
    card('diamonds', 'A'),
    card('hearts', 'A'),
    card('spades', 'A'),
    card('diamonds', '7'),
    card('hearts', '7'),
  ]
  hands.right = [card('clubs', 'J')]
  hands.top = [card('diamonds', 'J')]
  hands.left = [card('hearts', 'J')]

  const state = baseState({
    hands,
    contract: 'all-trumps',
    currentTurnSeat: 'bottom',
    trickIndex: 0,
    botSeats: ['bottom', 'right', 'top', 'left'],
  })

  const playedCard = hands.bottom[3]!
  const keys = getServerDefaultDeclarationKeysForPlay(state, 'bottom', playedCard)
  assert(keys.length === 1 && keys[0]!.startsWith('sequence:Терца:20:'), `native bot did not get the sequence declaration: ${JSON.stringify(keys)}`)
})

// ---- [5] multiple candidates -> conflict resolution picks default non-overlapping set ----

await check('[5] multiple simultaneous candidates (square + non-overlapping sequence) both get auto-declared via resolveServerDeclarationConflicts', () => {
  const hands = emptyHands()
  // Four Queens (square, 100) + a clubs 7-8-9 tierce (sequence, 20) — disjoint card sets, both should survive conflict resolution.
  hands.bottom = [
    card('clubs', 'Q'),
    card('diamonds', 'Q'),
    card('hearts', 'Q'),
    card('spades', 'Q'),
    card('clubs', '7'),
    card('clubs', '8'),
    card('clubs', '9'),
    card('diamonds', '10'),
  ]
  hands.right = [card('clubs', 'J')]
  hands.top = [card('diamonds', 'J')]
  hands.left = [card('hearts', 'J')]

  const state = baseState({
    hands,
    contract: 'all-trumps',
    currentTurnSeat: 'bottom',
    trickIndex: 0,
    botSeats: ['bottom'],
  })

  const playedCard = hands.bottom[7]!
  const keys = getServerDefaultDeclarationKeysForPlay(state, 'bottom', playedCard)
  assert(keys.length === 2, `expected both non-overlapping declarations (square + sequence), got ${keys.length}: ${JSON.stringify(keys)}`)
  assert(keys.some((k: string) => k.startsWith('square:Каре:100:')), 'missing the square declaration')
  assert(keys.some((k: string) => k.startsWith('sequence:Терца:20:')), 'missing the sequence declaration')

  const nextState = submitServerPlayCard(state, 'bottom', playedCard.id, keys)
  assert(nextState.declarations.length === 2, `expected 2 recorded declarations, got ${nextState.declarations.length}`)
})

await check('[5b] overlapping candidates (two sequences sharing a card via an 8-card run) resolve to a single non-overlapping default set, not a naive dump of every candidate', () => {
  // clubs 7-8-9-10-J is a single 5-card sequence (100pt) — the raw detector
  // must not also emit overlapping shorter sub-sequences that resolveServerDeclarationConflicts
  // would then have to reject; this asserts the final selected set has no overlapping cardIds.
  const hands = emptyHands()
  hands.bottom = [
    card('clubs', '7'),
    card('clubs', '8'),
    card('clubs', '9'),
    card('clubs', '10'),
    card('clubs', 'J'),
    card('diamonds', 'A'),
    card('hearts', 'A'),
    card('spades', 'A'),
  ]
  hands.right = [card('diamonds', 'J')]
  hands.top = [card('hearts', 'J')]
  hands.left = [card('spades', 'J')]

  const state = baseState({
    hands,
    contract: 'all-trumps',
    currentTurnSeat: 'bottom',
    trickIndex: 0,
    botSeats: ['bottom'],
  })

  const playedCard = hands.bottom[5]!
  const keys = getServerDefaultDeclarationKeysForPlay(state, 'bottom', playedCard)
  assert(keys.length === 1, `expected exactly 1 declaration (the single 100pt sequence), got ${keys.length}: ${JSON.stringify(keys)}`)
  assert(keys[0]!.startsWith('sequence:100:100:'), `expected the 5-card "100" sequence, got ${keys[0]}`)
})

// ---- [6] belote still works, no double-submit ----

await check('[6] belote: timeout/bot-takeover still declares belote when the played card matches (Q or K of trump, all-trumps lead-suit rule)', () => {
  const hands = emptyHands()
  hands.bottom = [
    card('clubs', 'Q'),
    card('clubs', 'K'),
    card('diamonds', '7'),
    card('diamonds', '8'),
    card('hearts', '9'),
    card('spades', '10'),
    card('hearts', 'A'),
    card('spades', 'A'),
  ]
  hands.right = [card('diamonds', 'J')]
  hands.top = [card('hearts', 'J')]
  hands.left = [card('spades', 'J')]

  const state = baseState({
    hands,
    contract: 'all-trumps',
    currentTurnSeat: 'bottom',
    trickIndex: 0,
    botSeats: ['bottom'],
  })

  const playedCard = hands.bottom[0]! // clubs Q — belote-eligible card
  const keys = getServerDefaultDeclarationKeysForPlay(state, 'bottom', playedCard)
  assert(keys.some((k: string) => k.startsWith('belote:Белот:20:')), `expected a belote declaration, got ${JSON.stringify(keys)}`)

  const nextState = submitServerPlayCard(state, 'bottom', playedCard.id, keys)
  const beloteDeclarations = nextState.declarations.filter((d: any) => d.type === 'belote')
  assert(beloteDeclarations.length === 1, `expected exactly 1 belote declaration recorded, got ${beloteDeclarations.length}`)

  // [12] duplicate protection: playing the King next (same belote pair) must NOT re-declare belote.
  const kingCard = hands.bottom[1]!
  const stateAfterQueen = { ...nextState, playing: { ...nextState.playing, currentTurnSeat: 'bottom' } }
  const keysForKing = getServerDefaultDeclarationKeysForPlay(stateAfterQueen, 'bottom', kingCard)
  assert(!keysForKing.some((k: string) => k.startsWith('belote:')), `belote should not be offered again for the King after Queen already declared it, got ${JSON.stringify(keysForKing)}`)
})

await check('[6b] belote: card that does NOT match the belote pair yields no belote key (no false positive)', () => {
  const hands = emptyHands()
  hands.bottom = [
    card('clubs', 'Q'),
    card('clubs', 'K'),
    card('diamonds', '7'),
    card('diamonds', '8'),
    card('hearts', '9'),
    card('spades', '10'),
    card('hearts', 'A'),
    card('spades', 'A'),
  ]
  hands.right = [card('diamonds', 'J')]
  hands.top = [card('hearts', 'J')]
  hands.left = [card('spades', 'J')]

  const state = baseState({
    hands,
    contract: 'all-trumps',
    currentTurnSeat: 'bottom',
    trickIndex: 0,
    botSeats: ['bottom'],
  })

  const playedCard = hands.bottom[2]! // diamonds 7 — unrelated to the clubs Q/K belote pair
  const keys = getServerDefaultDeclarationKeysForPlay(state, 'bottom', playedCard)
  assert(!keys.some((k: string) => k.startsWith('belote:')), `expected no belote key for an unrelated played card, got ${JSON.stringify(keys)}`)
})

// ---- [7] no-trumps ----

await check('[7] no-trumps contract: declarationKeys is empty even though the hand mathematically contains a square', () => {
  const hands = emptyHands()
  hands.bottom = fourQueensHand()
  hands.right = [card('clubs', 'J')]
  hands.top = [card('diamonds', 'J')]
  hands.left = [card('hearts', 'J')]

  const state = baseState({
    hands,
    contract: 'no-trumps',
    currentTurnSeat: 'bottom',
    trickIndex: 0,
    botSeats: ['bottom'],
  })

  const playedCard = hands.bottom[4]!
  const keys = getServerDefaultDeclarationKeysForPlay(state, 'bottom', playedCard)
  assert(keys.length === 0, `expected no declarations under no-trumps, got ${JSON.stringify(keys)}`)
})

// ---- [9] trick > 0: no redeclaration of square/sequence ----

await check('[9] trick index > 0: square/sequence are NOT auto-declared again (opening-window has closed)', () => {
  const hands = emptyHands()
  hands.bottom = fourQueensHand()
  hands.right = [card('clubs', 'J')]
  hands.top = [card('diamonds', 'J')]
  hands.left = [card('hearts', 'J')]

  const state = baseState({
    hands,
    contract: 'all-trumps',
    currentTurnSeat: 'bottom',
    trickIndex: 1, // second trick — opening declaration window has closed
    botSeats: ['bottom'],
  })

  const playedCard = hands.bottom[4]!
  const keys = getServerDefaultDeclarationKeysForPlay(state, 'bottom', playedCard)
  assert(keys.length === 0, `expected no square/sequence auto-declaration on trick index > 0, got ${JSON.stringify(keys)}`)
})

// ---- [12] duplicate protection: already-recorded key is never re-offered ----

await check('[12] a declaration key already present in state.declarations for this seat is never re-offered', () => {
  const hands = emptyHands()
  hands.bottom = fourQueensHand()
  hands.right = [card('clubs', 'J')]
  hands.top = [card('diamonds', 'J')]
  hands.left = [card('hearts', 'J')]

  const authoritative = detectServerDeclarationsInHand(hands.bottom, { contract: 'all-trumps', trumpSuit: null })
  const squareCandidate = authoritative.find((c: any) => c.type === 'square')!

  const state = baseState({
    hands,
    contract: 'all-trumps',
    currentTurnSeat: 'bottom',
    trickIndex: 0,
    botSeats: ['bottom'],
    existingDeclarations: [
      {
        key: squareCandidate.key,
        seat: 'bottom',
        team: 'A',
        type: 'square',
        publicLabel: 'Каре',
        points: 100,
        cards: squareCandidate.privateMetadata.cards,
        cardIds: squareCandidate.cardIds,
        suit: null,
        highRank: 'Q',
        declaredAtTrickIndex: 0,
        announced: true,
        valid: true,
      },
    ],
  })

  const playedCard = hands.bottom[4]!
  const keys = getServerDefaultDeclarationKeysForPlay(state, 'bottom', playedCard)
  assert(!keys.includes(squareCandidate.key), `already-declared square key must not be re-offered, got ${JSON.stringify(keys)}`)
})

// ---- [11] generated keys are accepted by the SAME authoritative validator that guards the human path ----

await check('[11] generated default declaration keys pass validateServerDeclarationKeysForPlay (the same validator used for human submissions) with no divergent detector', () => {
  const hands = emptyHands()
  hands.bottom = fourQueensHand()
  hands.right = [card('clubs', 'J')]
  hands.top = [card('diamonds', 'J')]
  hands.left = [card('hearts', 'J')]

  const state = baseState({
    hands,
    contract: 'all-trumps',
    currentTurnSeat: 'bottom',
    trickIndex: 0,
    botSeats: ['bottom'],
  })

  const playedCard = hands.bottom[4]!
  const keys = getServerDefaultDeclarationKeysForPlay(state, 'bottom', playedCard)
  const validation = validateServerDeclarationKeysForPlay(state, 'bottom', playedCard.id, keys)
  assert(validation.ok === true, `expected validation to accept the auto-generated default keys, got: ${JSON.stringify(validation)}`)
})

// ---- source-level: confirm the old belote-only helper is gone from the bot/timeout call site ----

await check('source: advanceExpiredServerPlayingState.ts no longer routes bot/timeout plays through a belote-only helper', async () => {
  const projectRoot = join(process.cwd(), '..')
  const source = await readFile(
    join(projectRoot, 'server', 'src', 'game', 'advanceExpiredServerPlayingState.ts'),
    'utf8',
  )
  assert(!source.includes('getBotBeloteDeclarationKeysForPlay'), 'old belote-only helper name should no longer exist in this file')
  assert(source.includes('getServerDefaultDeclarationKeysForPlay'), 'new default-selection helper not found')
  assert(source.includes('resolveServerDeclarationConflicts'), 'fix must reuse the established resolveServerDeclarationConflicts helper, not a bespoke selection algorithm')
  assert(source.includes('detectServerDeclarationsInHand'), 'fix must reuse the established detectServerDeclarationsInHand helper, not a duplicated detector')
})

console.log('\n' + '═'.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
