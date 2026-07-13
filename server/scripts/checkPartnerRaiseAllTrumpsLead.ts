/**
 * checkPartnerRaiseAllTrumpsLead.ts
 *
 * Regression проверки за правилото за разиграване след партньорска
 * „Всичко коз“ комбинация (виж checkPartnerRaiseAllTrumpsBid.ts за bidding
 * частта): деклараторът е обявил собствена боя X, партньорът е вдигнал с
 * по-висока Y, деклараторът е обявил all-trumps докато Y е била водеща.
 *
 * ПРИОРИТЕТ: правилото има предимство ПРЕД chooseAllTrumpsMasterLead,
 * partnerMandatoryRequestedSuit, partnerAllTrumpsColorSignaledSuit и всички
 * други all-trumps lead heuristics, докато планът не е приключил —
 * включително когато ботът държи властно Вале от собствената си боя.
 * Подаването към партньора използва НАЙ-ВИСОКАТА законна карта от боята
 * (ред J>9>A>10>K>Q>8>7 при all-trumps), не най-ниската.
 *
 * Вале без 9:
 * [1]  J+A+Q+7 в own suit, 8♥ у партньора → свободен lead = 8♥, не J♣ (master)
 * [2]  Същото + властно Вале в трета боя → пак 8♥
 * [3]  Partner suit има 8♥+A♥ → играе A♥ (най-висока), не 8♥
 * [4]  Partner suit има 9♥+A♥ → играе 9♥ (9 > A в trump реда)
 * [5]  Partner suit има J♥+9♥ → играе J♥ (J е връх)
 * [6]  След еднократно подаване в partner suit → следващ lead не форсира отново
 *
 * Вале + 9:
 * [7]  J+9+A+Q в own suit: след J и 9 изиграни, A/Q още в ръката → продължава own suit
 * [8]  Own suit напълно изчерпана → следващ lead = най-високата карта от partner suit
 * [9]  След еднократно подаване в partner suit (Случай A) → план приключен
 *
 * Защити:
 * [10] Без активна bidding комбинация → chooseAllTrumpsMasterLead непроменен
 * [11] Follow ситуация → правилото не участва, само законни карти
 * [12] Няма карта от own/partner suit → безопасен fallback (валидна карта, без грешка)
 * [13] Празни bidding.entries (ново раздаване) → комбинацията не се "помни"
 *
 * Partner-signal взаимодействие:
 * [14] Активна комбинация (pending) + mandatory J-сигнал от партньора → новото
 *      правило печели (комбинацията все още неизпълнена)
 * [15] Активна комбинация (pending) + color-сигнал от партньора → новото
 *      правило печели
 * [16] След изпълнение на плана + mandatory J-сигнал → сигналът печели
 *      (нормалният приоритет се възстановява)
 * [17] След изпълнение на плана + color-сигнал → сигналът печели
 */

import { pickServerBotPlayCard } from '../src/game/pickServerBotPlayCard.js'
import { getServerTrickWinner } from '../src/game/getServerTrickWinner.js'
import type {
  ServerAuthoritativeGameState,
  ServerBidEntry,
  ServerCard,
  ServerCompletedTrick,
  ServerPlayerState,
  ServerSuit,
  ServerTrickPlay,
} from '../src/game/serverGameTypes.js'
import type { Seat, Team } from '../src/core/serverTypes.js'

// ─── Брояч ──────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
function check(label: string, fn: () => void): void {
  try {
    fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: получено "${String(actual)}", очаквано "${String(expected)}"`)
  }
}

// ─── Card / seat helpers ──────────────────────────────────────────────────────

function makeCard(suit: ServerSuit, rank: ServerCard['rank'], id?: string): ServerCard {
  return { id: id ?? `${suit}-${rank}`, suit, rank }
}

const SEAT_ORDER: Seat[] = ['bottom', 'right', 'top', 'left']
function seatToTeam(seat: Seat): Team {
  return seat === 'bottom' || seat === 'top' ? 'A' : 'B'
}

const ALL_TRUMPS_WINNING_BID_TEMPLATE = (
  declarerSeat: Seat,
): ServerAuthoritativeGameState['bidding']['winningBid'] => ({
  seat: declarerSeat,
  contract: 'all-trumps',
  trumpSuit: null,
  doubled: false,
  redoubled: false,
})

/**
 * Изгражда РЕАЛИСТИЧНА завършена взятка: точно 4 plays, 4 различни seats,
 * уникални карти, първият play е от leaderSeat, winnerSeat/winningTeam се
 * изчисляват чрез реалния getServerTrickWinner (не се предполагат).
 *
 * `playsBySeat` трябва да съдържа точно по една карта за всеки от четирите
 * seats; leaderSeat determines кой играе първи (реда на play в trick масива
 * следва SEAT_ORDER, завъртян да започне от leaderSeat — реалистичен ред на
 * игра по часовниковата стрелка).
 */
function makeRealisticTrick(
  trickIndex: number,
  leaderSeat: Seat,
  playsBySeat: Record<Seat, ServerCard>,
  winningBid: ServerAuthoritativeGameState['bidding']['winningBid'],
): ServerCompletedTrick {
  const leaderIndex = SEAT_ORDER.indexOf(leaderSeat)
  const orderedSeats = [0, 1, 2, 3].map(i => SEAT_ORDER[(leaderIndex + i) % 4]!)

  const plays: ServerTrickPlay[] = orderedSeats.map(seat => ({
    seat,
    card: playsBySeat[seat],
  }))

  const cardIds = new Set(plays.map(p => p.card.id))
  if (cardIds.size !== 4) {
    throw new Error(`makeRealisticTrick: карти не са уникални (trick ${trickIndex})`)
  }

  const winnerPlay = getServerTrickWinner(plays, winningBid)
  if (!winnerPlay) {
    throw new Error(`makeRealisticTrick: getServerTrickWinner върна null (trick ${trickIndex})`)
  }

  return {
    trickIndex,
    leaderSeat,
    plays,
    winnerSeat: winnerPlay.seat,
    winningTeam: seatToTeam(winnerPlay.seat),
  }
}

function makePlayers(): Record<Seat, ServerPlayerState> {
  const teams: Team[] = ['A', 'B', 'A', 'B']
  return Object.fromEntries(
    SEAT_ORDER.map((s, i) => [s, { seat: s, team: teams[i]!, mode: 'bot' as const, controlledByBot: true }]),
  ) as Record<Seat, ServerPlayerState>
}

function makeBaseState(overrides: {
  botSeat: Seat
  hand: ServerCard[]
  bidEntries: ServerBidEntry[]
  winningBid: ServerAuthoritativeGameState['bidding']['winningBid']
  completedTricks?: ServerCompletedTrick[]
  currentTrickPlays?: ServerTrickPlay[]
  allHands?: Partial<Record<Seat, ServerCard[]>>
}): ServerAuthoritativeGameState {
  const {
    botSeat, hand, bidEntries, winningBid,
    completedTricks = [], currentTrickPlays = [], allHands = {},
  } = overrides

  const emptyScore = { teamA: 0, teamB: 0 }
  const emptyHands: Record<Seat, ServerCard[]> = {
    bottom: [],
    right: [],
    top: [],
    left: [],
    ...allHands,
    [botSeat]: hand,
  }

  return {
    phase: 'playing',
    phaseEnteredAt: 0,
    targetScore: 151,
    players: makePlayers(),
    round: {
      dealerSeat: 'right',
      cutterSeat: 'bottom',
      firstBidderSeat: 'bottom',
      firstDealSeat: 'bottom',
      selectedCutIndex: null,
    },
    deck: [],
    hands: emptyHands,
    bidding: {
      entries: bidEntries,
      currentSeat: null,
      winningBid,
      hasStarted: true,
      hasEnded: true,
      consecutivePasses: 0,
    },
    declarations: [],
    matchDeclarationMissionCounts: {
      announce_tersa: emptyScore,
      announce_50: emptyScore,
      announce_100: emptyScore,
      announce_kare: emptyScore,
      announce_belot: emptyScore,
    },
    currentTrick: {
      leaderSeat: botSeat,
      currentSeat: botSeat,
      plays: currentTrickPlays,
      winnerSeat: null,
      trickIndex: completedTricks.length,
    },
    wonTricks: { A: [], B: [] },
    playing: {
      hasStarted: true,
      currentTurnSeat: botSeat,
      currentTrick: {
        leaderSeat: botSeat,
        currentSeat: botSeat,
        plays: currentTrickPlays,
        winnerSeat: null,
        trickIndex: completedTricks.length,
      },
      completedTricks,
      lastCompletedTrickWinnerSeat: null,
      lastCompletedTrickWinnerTeam: null,
      wonTricksBySeat: { bottom: [], right: [], top: [], left: [] },
      wonTricksByTeam: { A: [], B: [] },
    },
    scoring: null,
    matchEnded: null,
    score: {
      round: {
        tricks: emptyScore,
        declarations: emptyScore,
        belote: emptyScore,
        lastTen: emptyScore,
        capot: emptyScore,
        total: emptyScore,
      },
      match: emptyScore,
      carryOver: emptyScore,
    },
    timer: { activeSeat: null, startedAt: null, durationMs: null, expiresAt: null },
  }
}

// bottom = declarer (бот, обявил own suit + all-trumps), top = партньор (вдигнал)
const BOT: Seat = 'bottom'
const PARTNER: Seat = 'top'
const OPP1: Seat = 'right'
const OPP2: Seat = 'left'

const BOT_ALL_TRUMPS_WIN = ALL_TRUMPS_WINNING_BID_TEMPLATE(BOT)

// Стандартна комбинация: BOT обявява clubs, PARTNER вдига с hearts, BOT обявява all-trumps
const COMBO_ENTRIES: ServerBidEntry[] = [
  { seat: BOT, action: { type: 'suit', suit: 'clubs' } },
  { seat: OPP1, action: { type: 'pass' } },
  { seat: PARTNER, action: { type: 'suit', suit: 'hearts' } },
  { seat: OPP2, action: { type: 'pass' } },
  { seat: BOT, action: { type: 'all-trumps' } },
  { seat: OPP1, action: { type: 'pass' } },
  { seat: PARTNER, action: { type: 'pass' } },
  { seat: OPP2, action: { type: 'pass' } },
]

// ─── Проверки: Вале без 9 ─────────────────────────────────────────────────────

console.log('\ncheckPartnerRaiseAllTrumpsLead\n')

check('[1] Вале без 9 в own suit → partner suit (8♥) побеждава master J♣', () => {
  const botHand: ServerCard[] = [
    makeCard('clubs', 'J'),
    makeCard('clubs', 'A'),
    makeCard('clubs', 'Q'),
    makeCard('clubs', '7'),
    makeCard('hearts', '8'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: COMBO_ENTRIES,
    winningBid: BOT_ALL_TRUMPS_WIN,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'hearts', 'Боя (partner suit, не own suit)')
  assertEqual(result!.rank, '8', 'Ранк (единствената hearts карта)')
})

check('[2] Второ властно Вале в трета боя не побеждава правилото → пак hearts', () => {
  const botHand: ServerCard[] = [
    makeCard('clubs', 'J'),
    makeCard('clubs', 'A'),
    makeCard('clubs', 'Q'),
    makeCard('clubs', '7'),
    makeCard('spades', 'J'),
    makeCard('hearts', '8'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: COMBO_ENTRIES,
    winningBid: BOT_ALL_TRUMPS_WIN,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'hearts', 'Боя (partner suit, не spades master J)')
  assertEqual(result!.rank, '8', 'Ранк')
})

check('[3] Partner suit 8♥+A♥ → играе А♥ (най-висока)', () => {
  const botHand: ServerCard[] = [
    makeCard('clubs', 'J'),
    makeCard('clubs', 'A'),
    makeCard('clubs', 'Q'),
    makeCard('clubs', '7'),
    makeCard('hearts', '8'),
    makeCard('hearts', 'A'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: COMBO_ENTRIES,
    winningBid: BOT_ALL_TRUMPS_WIN,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'hearts', 'Боя')
  assertEqual(result!.rank, 'A', 'Ранк (А е по-висока от 8 в trump реда)')
})

check('[4] Partner suit 9♥+A♥ → играе 9♥ (9 > A в trump реда)', () => {
  const botHand: ServerCard[] = [
    makeCard('clubs', 'J'),
    makeCard('clubs', 'A'),
    makeCard('clubs', 'Q'),
    makeCard('clubs', '7'),
    makeCard('hearts', '9'),
    makeCard('hearts', 'A'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: COMBO_ENTRIES,
    winningBid: BOT_ALL_TRUMPS_WIN,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'hearts', 'Боя')
  assertEqual(result!.rank, '9', 'Ранк (9 е по-висока от A в trump реда J>9>A>10>K>Q>8>7)')
})

check('[5] Partner suit J♥+9♥ → играе J♥ (J е връх)', () => {
  const botHand: ServerCard[] = [
    makeCard('clubs', 'J'),
    makeCard('clubs', 'A'),
    makeCard('clubs', 'Q'),
    makeCard('clubs', '7'),
    makeCard('hearts', 'J'),
    makeCard('hearts', '9'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: COMBO_ENTRIES,
    winningBid: BOT_ALL_TRUMPS_WIN,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'hearts', 'Боя')
  assertEqual(result!.rank, 'J', 'Ранк (J е връх на trump реда)')
})

check('[6] След еднократно подаване в partner suit → не форсира отново', () => {
  // Реалистична взятка: ботът (leader) е повел с 8♥ (partner suit); партньорът
  // хвърля 7♥ (следва боята), противниците хвърлят по-ниски карти извън hearts
  // (нямат hearts). Победител: чрез getServerTrickWinner (all-trumps: най-
  // силната карта, следваща led suit, печели — тук BOT/8♥ е единствената
  // hearts, следователно печели триковата, освен ако друг играч не следва
  // hearts с по-висока — тук партньорът играе 7♥, по-ниска от 8♥, значи BOT печели).
  const completedTricks: ServerCompletedTrick[] = [
    makeRealisticTrick(
      0,
      BOT,
      {
        [BOT]: makeCard('hearts', '8'),
        [OPP1]: makeCard('diamonds', '7'),
        [PARTNER]: makeCard('hearts', '7'),
        [OPP2]: makeCard('diamonds', 'K'),
      },
      BOT_ALL_TRUMPS_WIN,
    ),
  ]

  const botHand: ServerCard[] = [
    makeCard('clubs', 'J'),
    makeCard('clubs', 'A'),
    makeCard('clubs', 'Q'),
    makeCard('clubs', '7'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: COMBO_ENTRIES,
    winningBid: BOT_ALL_TRUMPS_WIN,
    completedTricks,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  // Планът (Случай B) е приключен → пада към нормалната логика →
  // master lead избира J♣ (все още master, никой друг клубс по-висок)
  assertEqual(result!.suit, 'clubs', 'Боя (стара логика — master lead)')
  assertEqual(result!.rank, 'J', 'Ранк (master)')
})

// ─── Проверки: Вале + 9 ────────────────────────────────────────────────────────

check('[7] J+9 изиграни, A/Q все още в own suit → продължава own suit', () => {
  // Две реалистични взятки: ботът (leader) е повел с J♣, после 9♣ — партньорът
  // и противниците следват в clubs с по-ниски карти (или хвърлят друга боя ако
  // нямат clubs). Бот печели и двете (J и 9 са върхът на trump реда).
  const completedTricks: ServerCompletedTrick[] = [
    makeRealisticTrick(
      0,
      BOT,
      {
        [BOT]: makeCard('clubs', 'J'),
        [OPP1]: makeCard('clubs', '8'),
        [PARTNER]: makeCard('clubs', 'K'),
        [OPP2]: makeCard('clubs', '10'),
      },
      BOT_ALL_TRUMPS_WIN,
    ),
    makeRealisticTrick(
      1,
      BOT,
      {
        [BOT]: makeCard('clubs', '9'),
        [OPP1]: makeCard('diamonds', '7'),
        [PARTNER]: makeCard('diamonds', 'K'),
        [OPP2]: makeCard('diamonds', 'Q'),
      },
      BOT_ALL_TRUMPS_WIN,
    ),
  ]

  const remainingHand: ServerCard[] = [
    makeCard('clubs', 'A'),
    makeCard('clubs', 'Q'),
    makeCard('clubs', '7'),
    makeCard('hearts', '8'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: remainingHand,
    bidEntries: COMBO_ENTRIES,
    winningBid: BOT_ALL_TRUMPS_WIN,
    completedTricks,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'clubs', 'Боя (own suit продължава — все още не е изчерпана)')
})

check('[8] Own suit изчерпана → най-високата карта от partner suit', () => {
  const completedTricks: ServerCompletedTrick[] = [
    makeRealisticTrick(
      0,
      BOT,
      {
        [BOT]: makeCard('clubs', 'J'),
        [OPP1]: makeCard('clubs', '8'),
        [PARTNER]: makeCard('clubs', 'K'),
        [OPP2]: makeCard('clubs', '10'),
      },
      BOT_ALL_TRUMPS_WIN,
    ),
    makeRealisticTrick(
      1,
      BOT,
      {
        [BOT]: makeCard('clubs', '9'),
        [OPP1]: makeCard('clubs', 'A'),
        [PARTNER]: makeCard('clubs', 'Q'),
        [OPP2]: makeCard('clubs', '7'),
      },
      BOT_ALL_TRUMPS_WIN,
    ),
  ]

  const botHand: ServerCard[] = [
    makeCard('hearts', '8'),
    makeCard('hearts', 'A'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: COMBO_ENTRIES,
    winningBid: BOT_ALL_TRUMPS_WIN,
    completedTricks,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'hearts', 'Боя (partner suit — own suit изчерпана)')
  assertEqual(result!.rank, 'A', 'Ранк (най-висока: A > 8 в trump реда)')
})

check('[9] След еднократно подаване в partner suit (Случай А) → план приключен', () => {
  // Own suit изчерпана (J, 9 изиграни в предишни взятки), после ботът е
  // подал A♥ в partner suit (трета взятка, leader=BOT). Сега план приключен
  // → следващ свободен lead пада към нормалната логика.
  const completedTricks: ServerCompletedTrick[] = [
    makeRealisticTrick(
      0,
      BOT,
      {
        [BOT]: makeCard('clubs', 'J'),
        [OPP1]: makeCard('clubs', '8'),
        [PARTNER]: makeCard('clubs', 'K'),
        [OPP2]: makeCard('clubs', '10'),
      },
      BOT_ALL_TRUMPS_WIN,
    ),
    makeRealisticTrick(
      1,
      BOT,
      {
        [BOT]: makeCard('clubs', '9'),
        [OPP1]: makeCard('clubs', 'A'),
        [PARTNER]: makeCard('clubs', 'Q'),
        [OPP2]: makeCard('clubs', '7'),
      },
      BOT_ALL_TRUMPS_WIN,
    ),
    makeRealisticTrick(
      2,
      BOT,
      {
        [BOT]: makeCard('hearts', 'A'),
        [OPP1]: makeCard('diamonds', '7'),
        [PARTNER]: makeCard('hearts', '7'),
        [OPP2]: makeCard('diamonds', 'K'),
      },
      BOT_ALL_TRUMPS_WIN,
    ),
  ]

  const botHand: ServerCard[] = [
    makeCard('spades', 'J'),
    makeCard('hearts', '8'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: COMBO_ENTRIES,
    winningBid: BOT_ALL_TRUMPS_WIN,
    completedTricks,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  // План приключен → пада към master lead → J♠ е master (никой друг spades по-висок)
  assertEqual(result!.suit, 'spades', 'Боя (стара логика — master lead J♠)')
  assertEqual(result!.rank, 'J', 'Ранк')
})

// ─── Защити ────────────────────────────────────────────────────────────────────

check('[10] Без активна комбинация → master-lead приоритетът работи непроменен', () => {
  const directEntries: ServerBidEntry[] = [
    { seat: BOT, action: { type: 'all-trumps' } },
    { seat: OPP1, action: { type: 'pass' } },
    { seat: PARTNER, action: { type: 'pass' } },
    { seat: OPP2, action: { type: 'pass' } },
  ]
  const botHand: ServerCard[] = [
    makeCard('clubs', 'J'),
    makeCard('hearts', '7'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: directEntries,
    winningBid: BOT_ALL_TRUMPS_WIN,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'clubs', 'Боя (стара master-lead логика)')
  assertEqual(result!.rank, 'J', 'Ранк')
})

check('[11] Follow ситуация → правилото не участва, само законни карти', () => {
  const botHand: ServerCard[] = [
    makeCard('diamonds', '7'),
    makeCard('clubs', 'J'),
    makeCard('clubs', 'A'),
    makeCard('hearts', '8'),
  ]
  const currentTrickPlays: ServerTrickPlay[] = [
    { seat: OPP1, card: makeCard('diamonds', 'K') },
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: COMBO_ENTRIES,
    winningBid: BOT_ALL_TRUMPS_WIN,
    currentTrickPlays,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'diamonds', 'Боя (задължение за следване, не свободен lead)')
  assertEqual(result!.rank, '7', 'Ранк (единствената законна diamonds карта)')
})

check('[12] Няма карта от own/partner suit → безопасен fallback', () => {
  const botHand: ServerCard[] = [
    makeCard('spades', 'J'),
    makeCard('diamonds', '7'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: COMBO_ENTRIES,
    winningBid: BOT_ALL_TRUMPS_WIN,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне валидна карта (fallback, без грешка)')
})

check('[13] Празни bidding.entries (ново раздаване) → правилото не се активира', () => {
  const emptyEntries: ServerBidEntry[] = []
  const botHand: ServerCard[] = [
    makeCard('clubs', 'J'),
    makeCard('clubs', '9'),
    makeCard('clubs', '7'),
    makeCard('hearts', '8'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: emptyEntries,
    winningBid: BOT_ALL_TRUMPS_WIN,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'clubs', 'Боя (стара master-lead логика, не новото правило)')
  assertEqual(result!.rank, 'J', 'Ранк')
})

// ─── Partner-signal взаимодействие ─────────────────────────────────────────────

// В тези тестове партньорът (top) е дал сигнал в предишна наша взятка. За
// mandatory J-сигнал: партньорът е изчистил J от боя различна от led suit в
// последната взятка, спечелена от нашия отбор (виж
// partnerMandatoryRequestedSuit в pickServerBotPlayCard.ts, all-trumps клон:
// card.rank === 'J' → сигнал). За color-сигнал: партньорът е изчистил
// не-J/не-9 карта от друг цвят (resolveColorSignal логиката).

check('[14] Pending комбинация (Вале без 9) + mandatory J-сигнал → комбинацията печели', () => {
  // Ботът има own suit (clubs, без 9) все още неподадена. Партньорът е дал
  // mandatory J-сигнал (изчистил J♦ в наша спечелена взятка, водена в spades).
  const completedTricks: ServerCompletedTrick[] = [
    makeRealisticTrick(
      0,
      BOT,
      {
        [BOT]: makeCard('spades', 'A'), // led spades, BOT печели (A е силна в trump реда сред spades)
        [OPP1]: makeCard('spades', '7'),
        [PARTNER]: makeCard('diamonds', 'J'), // партньор изчиства J♦ (не следва spades) → mandatory сигнал за diamonds
        [OPP2]: makeCard('spades', '8'),
      },
      BOT_ALL_TRUMPS_WIN,
    ),
  ]

  const botHand: ServerCard[] = [
    makeCard('clubs', 'J'),
    makeCard('clubs', 'A'),
    makeCard('clubs', 'Q'),
    makeCard('clubs', '7'),
    makeCard('hearts', '8'), // partner suit (COMBO_ENTRIES: partner вдигна hearts)
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: COMBO_ENTRIES,
    winningBid: BOT_ALL_TRUMPS_WIN,
    completedTricks,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  // Планът (Случай B, hearts) е още неизпълнен → печели пред mandatory diamonds сигнала
  assertEqual(result!.suit, 'hearts', 'Боя (pending комбинация печели пред mandatory сигнал)')
  assertEqual(result!.rank, '8', 'Ранк (единствената hearts карта)')
})

check('[15] Pending комбинация (Вале без 9) + color-сигнал → комбинацията печели', () => {
  // Партньорът изчиства неутрална карта (не J, не 9) от друг цвят в наша
  // спечелена взятка → color-сигнал (resolveColorSignal), но комбинацията
  // (hearts, partner suit) все още неизпълнена → трябва да победи.
  const completedTricks: ServerCompletedTrick[] = [
    makeRealisticTrick(
      0,
      BOT,
      {
        [BOT]: makeCard('spades', 'A'),
        [OPP1]: makeCard('spades', '7'),
        [PARTNER]: makeCard('diamonds', 'Q'), // изчистена Q♦ (не J, не 9) → color-сигнал
        [OPP2]: makeCard('spades', '8'),
      },
      BOT_ALL_TRUMPS_WIN,
    ),
  ]

  const botHand: ServerCard[] = [
    makeCard('clubs', 'J'),
    makeCard('clubs', 'A'),
    makeCard('clubs', 'Q'),
    makeCard('clubs', '7'),
    makeCard('hearts', '8'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: COMBO_ENTRIES,
    winningBid: BOT_ALL_TRUMPS_WIN,
    completedTricks,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'hearts', 'Боя (pending комбинация печели пред color-сигнал)')
  assertEqual(result!.rank, '8', 'Ранк')
})

check('[16] След изпълнение на плана + mandatory J-сигнал → сигналът печели', () => {
  // Ботът вече е подал веднъж hearts (Случай B изпълнен, взятка 0). После
  // партньорът дава mandatory J-сигнал (J♦) в наша следваща спечелена
  // взятка (взятка 1). Планът е приключен → нормалният сигнален приоритет
  // трябва да поеме и да предпочете diamonds.
  const completedTricks: ServerCompletedTrick[] = [
    makeRealisticTrick(
      0,
      BOT,
      {
        [BOT]: makeCard('hearts', 'A'), // подаване в partner suit (Случай B) — план приключен
        [OPP1]: makeCard('diamonds', '7'),
        [PARTNER]: makeCard('hearts', '7'),
        [OPP2]: makeCard('diamonds', 'K'),
      },
      BOT_ALL_TRUMPS_WIN,
    ),
    makeRealisticTrick(
      1,
      BOT,
      {
        [BOT]: makeCard('spades', 'A'),
        [OPP1]: makeCard('spades', '7'),
        [PARTNER]: makeCard('diamonds', 'J'), // mandatory J-сигнал за diamonds
        [OPP2]: makeCard('spades', '8'),
      },
      BOT_ALL_TRUMPS_WIN,
    ),
  ]

  const botHand: ServerCard[] = [
    makeCard('clubs', 'A'), // own suit — не master (J♣ не е в ръка/изигран от бота)
    makeCard('diamonds', 'Q'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: COMBO_ENTRIES,
    winningBid: BOT_ALL_TRUMPS_WIN,
    completedTricks,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  // Планът е приключен (правилото връща null) → mandatory сигнал поема → diamonds
  assertEqual(result!.suit, 'diamonds', 'Боя (mandatory сигнал печели след изпълнен план)')
})

check('[17] След изпълнение на плана + color-сигнал → сигналът печели', () => {
  const completedTricks: ServerCompletedTrick[] = [
    makeRealisticTrick(
      0,
      BOT,
      {
        [BOT]: makeCard('hearts', 'A'),
        [OPP1]: makeCard('diamonds', '7'),
        [PARTNER]: makeCard('hearts', '7'),
        [OPP2]: makeCard('diamonds', 'K'),
      },
      BOT_ALL_TRUMPS_WIN,
    ),
    makeRealisticTrick(
      1,
      BOT,
      {
        [BOT]: makeCard('spades', 'A'),
        [OPP1]: makeCard('spades', '7'),
        [PARTNER]: makeCard('diamonds', 'Q'), // color-сигнал (не J/9)
        [OPP2]: makeCard('spades', '8'),
      },
      BOT_ALL_TRUMPS_WIN,
    ),
  ]

  const botHand: ServerCard[] = [
    makeCard('clubs', 'A'),
    makeCard('diamonds', 'K'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: COMBO_ENTRIES,
    winningBid: BOT_ALL_TRUMPS_WIN,
    completedTricks,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'diamonds', 'Боя (color-сигнал печели след изпълнен план)')
})

// ─── Резултат ────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
