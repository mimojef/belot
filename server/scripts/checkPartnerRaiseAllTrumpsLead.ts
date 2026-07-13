/**
 * checkPartnerRaiseAllTrumpsLead.ts
 *
 * Regression проверки за правилото за разиграване след партньорска
 * „Всичко коз“ комбинация (виж checkPartnerRaiseAllTrumpsBid.ts за bidding
 * частта): деклараторът е обявил собствена боя X, партньорът е вдигнал с
 * по-висока боя Y, деклараторът е обявил all-trumps докато Y е била водеща.
 *
 * Приоритетът се РАЗКЛОНЯВА по това дали X е имала Вале И 9 при обявата —
 * derive чрез seatHeldOrPlayedCard (9 все още в ръката на бота ИЛИ вече
 * лично изиграна от него, не само "в текущата ръка сега"):
 *
 * СЛУЧАЙ A (X имала Вале + 9) — chooseAllTrumpsOwnSuitNinePlanLead:
 *   1. Най-високата останала карта на бота от X — ако е ЛИЧНО властна
 *      (isCardMaster) → играй я. Проверява се наново на всеки lead.
 *   2. Ако X няма лично властна карта: master в трета боя Z (≠X, ≠Y) чрез
 *      chooseAllTrumpsThirdSuitMasterLead (reuse на conventional
 *      chooseAllTrumpsMasterLead реда между няколко Z).
 *   3. Ако нито X, нито Z имат лично властна карта, и ботът има карта от Y
 *      → подай highestCard(Y). Планът СЕ СЧИТА за изпълнен от този момент.
 *   4. Само ако ботът НЯМА карта от Y (fallback) → най-високата карта от X,
 *      ако е доказано сигурна за отбора (isOwnOrTeamGuaranteedAllTrumpsWinner).
 *
 * СЛУЧАЙ B (X имала Вале, но НЕ 9) — първоначалната конвенция, НЕ отменена:
 *   1. Директно highestCard(Y), преди всякакво X/Z master разглеждане —
 *      дори ако X или Z имат властно Вале.
 *   2. Планът приключва след подаването.
 *   3. Нормалната conventional логика (X, Z, master lead, partner signals)
 *      поема оттук нататък — ако партньорът по-късно върне X, ботът с
 *      Валето вече може да изтегли чуждата 9 и да разработи X нормално.
 *
 * Случай A тестове:
 * [1]  X masters преди всичко: J, после 9 в X, дори с карта в Y
 * [2]  Невластна X + налична Y → не играе X (дори "сигурна за отбора"),
 *      подава Y
 * [3]  Невластна X, БЕЗ Y карта, сигурна за отбора → fallback играе X
 * [4]  Master в трета боя Z, докато има Y карта → играе Z, не подава Y
 * [5]  Поредица от masters в Z → J, после 9 (ако вече master), чак после Y
 * [6]  Няколко трети бои Z1/Z2 → conventional master-lead ред, без hardcode
 * [7]  Master само в Y (нито X, нито Z) → подава Y, план приключва
 * [8]  X лично master, дори с master в Z → X първо, после Z
 * [11-a] Симетрия за различни X/Y/Z комбинации (Случай A)
 *
 * Случай B тестове:
 * [16] J+A+Q+7 в X (без 9) + карта от Y → директно Y, НЕ играе J от X
 * [17] Същото + властно Вале в трета боя Z → пак Y, нито J от X, нито J от Z
 * [18] Избор на карта от Y: 8+A→A, 9+A→9, J+9→J (trump ред)
 * [19] След еднократно подаване в Y → планът приключва, нормална логика поема
 * [11-b] Симетрия за различни X/Y/Z комбинации (Случай B)
 *
 * Конфликтен тест (доказва разликата Случай A срещу Случай B):
 * [20] Две почти еднакви ръце (X: J,9,8,7 срещу X: J,A,Q,7 без 9), еднакви
 *      Y и Z → напълно различно поведение само заради наличието на 9 в X
 *
 * Защити:
 * [9]  Follow ситуация → правилото не участва, само законни карти
 * [10] След приключване на плана → нормални partner signals/master lead
 * [12] Без активна bidding комбинация → chooseAllTrumpsMasterLead непроменен
 * [13] Няма карта нито от X, нито от Y, нито Z master → безопасен fallback
 * [14] Празни bidding.entries (ново раздаване) → комбинацията не се "помни"
 * [15] След еднократно подаване в Y → следващ lead не форсира отново
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

// bottom = declarer (бот, обявил X + all-trumps), top = партньор (вдигнал Y)
const BOT: Seat = 'bottom'
const PARTNER: Seat = 'top'
const OPP1: Seat = 'right'
const OPP2: Seat = 'left'

const BOT_ALL_TRUMPS_WIN = ALL_TRUMPS_WINNING_BID_TEMPLATE(BOT)

// Стандартна комбинация: BOT обявява clubs (X), PARTNER вдига с hearts (Y)
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

// ─── Проверки ────────────────────────────────────────────────────────────────

console.log('\ncheckPartnerRaiseAllTrumpsLead\n')

// [1] X masters преди всичко: J, после 9 в X, дори с карта в Y
check('[1] X master (J) печели пред Y, дори с карта от Y на разположение', () => {
  const botHand: ServerCard[] = [
    makeCard('clubs', 'J'),
    makeCard('clubs', '9'),
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
  assertEqual(result!.suit, 'clubs', 'Боя (X master J печели)')
  assertEqual(result!.rank, 'J', 'Ранк')

  // След J (изигран от бота, печели триковата) → 9♣ е следващата топ карта
  // в X; J е единствената по-висока и вече изиграна → 9 е лично властна →
  // продължава X, не подава Y все още.
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
  ]
  const remainingHand: ServerCard[] = [
    makeCard('clubs', '9'),
    makeCard('clubs', '7'),
    makeCard('hearts', '8'),
  ]
  const stateAfterJack = makeBaseState({
    botSeat: BOT,
    hand: remainingHand,
    bidEntries: COMBO_ENTRIES,
    winningBid: BOT_ALL_TRUMPS_WIN,
    completedTricks,
  })
  const resultAfterJack = pickServerBotPlayCard(stateAfterJack, BOT)
  assert(resultAfterJack !== null, 'Трябва да върне карта (след J)')
  assertEqual(resultAfterJack!.suit, 'clubs', 'Боя (9♣ лично властна — X продължава)')
  assertEqual(resultAfterJack!.rank, '9', 'Ранк')
})

// [2] Невластна X + налична Y → НЕ играе X (дори "сигурна за отбора"), подава Y
check('[2] Невластна X (макар сигурна за отбора) + карта от Y → подава Y, не X', () => {
  // Взятка 0: X=clubs led; и двамата противника доказано void в clubs (не
  // следват) → останалите по-високи клубс карти могат да бъдат само у
  // партньора. X топ картата на бота е Q (K все още неизиграна и не у бота
  // — виж бележката в тест [4] за trump реда; Q не е лично master, но е
  // "сигурна за отбора" защото и двамата противника са void). По старата
  // (грешна) логика това би "продължило X" — новата спецификация изисква Y
  // да изпревари "сигурна за отбора" X, докато ботът държи карта от Y.
  const completedTricks: ServerCompletedTrick[] = [
    makeRealisticTrick(
      0,
      BOT,
      {
        [BOT]: makeCard('clubs', 'J'),
        [OPP1]: makeCard('diamonds', '7'), // не следва → void в clubs
        [PARTNER]: makeCard('clubs', 'A'),
        [OPP2]: makeCard('diamonds', 'K'), // не следва → void в clubs
      },
      BOT_ALL_TRUMPS_WIN,
    ),
    makeRealisticTrick(
      1,
      BOT,
      {
        [BOT]: makeCard('clubs', '9'),
        [OPP1]: makeCard('diamonds', 'Q'), // вече доказан void в clubs
        [PARTNER]: makeCard('clubs', '10'),
        [OPP2]: makeCard('diamonds', '8'), // вече доказан void в clubs
      },
      BOT_ALL_TRUMPS_WIN,
    ),
  ]

  // Ботът държи Q♣ (X — не master: K неизиграна, не у бота, но противниците
  // са void → сигурна за отбора), и 8♥ (Y).
  const botHand: ServerCard[] = [
    makeCard('clubs', 'Q'),
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
  assertEqual(result!.suit, 'hearts', 'Боя (Y изпреварва "сигурна за отбора" X)')
  assertEqual(result!.rank, '8', 'Ранк (единствената Y карта)')
})

// [3] Невластна X, БЕЗ Y карта, сигурна за отбора → fallback играе X
check('[3] Невластна X, няма Y карта, сигурна за отбора → fallback играе X', () => {
  const completedTricks: ServerCompletedTrick[] = [
    makeRealisticTrick(
      0,
      BOT,
      {
        [BOT]: makeCard('clubs', 'J'),
        [OPP1]: makeCard('diamonds', '7'), // void в clubs
        [PARTNER]: makeCard('clubs', 'A'),
        [OPP2]: makeCard('diamonds', 'K'), // void в clubs
      },
      BOT_ALL_TRUMPS_WIN,
    ),
  ]

  // Ботът НЯМА карта от hearts (Y) тук — само X и трета боя без master.
  const botHand: ServerCard[] = [
    makeCard('clubs', '9'),
    makeCard('clubs', '8'),
    makeCard('diamonds', '8'), // трета боя, не master (K вече изиграна от OPP2, но Q/10/A неизвестни... виж долу)
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
  // Няма Y карта → fallback стъпка 4: 9♣ сигурна за отбора (и двамата
  // противника доказано void в clubs) → играе я.
  assertEqual(result!.suit, 'clubs', 'Боя (fallback — X сигурна за отбора, няма Y)')
  assertEqual(result!.rank, '9', 'Ранк')
})

// [4] Master в трета боя Z, докато има Y карта → играе Z, не подава Y
//
// Бележка за trump реда (J>9>A>10>K>Q>8>7): щом J излезе, 9 автоматично е
// master (единствената по-висока карта е J); после A автоматично master
// (по-високи са J,9 — вече изиграни); после 10 (по-високи J,9,A); после K
// (J,9,A,10) — веригата е НЕПРЕКЪСНАТА отгоре надолу. Единственият начин
// топ картата на бота да НЕ е master е тя да е ниско в реда (Q или по-долу)
// докато поне една от по-високите 5 карти (J,9,A,10,K) остава неизиграна и
// извън ръката на бота. Затова тук топ картата в X е Q, с K все още неиграна.
check('[4] Master в Z печели пред подаване в Y (Случай A: X имала Вале+9)', () => {
  // Валето И 9-ката трябва да са ЛИЧНО изиграни от бота (не от партньора),
  // за да потвърдят Случай A (X имала Вале+9) — иначе ownSuitHadNine=false
  // → Случай B се активира директно, без Z/X master проверки. K♣ остава
  // неиграна и никой не е доказано void → топ картата Q♣ НЕ е master.
  const completedTricks: ServerCompletedTrick[] = [
    makeRealisticTrick(
      0,
      BOT,
      {
        [BOT]: makeCard('clubs', 'J'),
        [OPP1]: makeCard('clubs', 'A'), // следва clubs → не void
        [PARTNER]: makeCard('clubs', '10'),
        [OPP2]: makeCard('diamonds', '7'),
      },
      BOT_ALL_TRUMPS_WIN,
    ),
    makeRealisticTrick(
      1,
      BOT,
      {
        [BOT]: makeCard('clubs', '9'), // лично изиграна от бота
        [OPP1]: makeCard('diamonds', 'K'),
        [PARTNER]: makeCard('diamonds', 'Q'),
        [OPP2]: makeCard('clubs', '7'), // следва clubs → не void
      },
      BOT_ALL_TRUMPS_WIN,
    ),
  ]

  // Ботът държи Q♣ (топ в X, останала след J,9,A,10,7 изиграни). По-висока
  // от Q е само K (неизиграна, никой доказано void) → Q не е master.
  const botHand: ServerCard[] = [
    makeCard('clubs', 'Q'),
    makeCard('spades', 'J'), // Z=spades, master (никой друг има по-висока — J е връх)
    makeCard('hearts', '8'), // Y
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
  assertEqual(result!.suit, 'spades', 'Боя (Z master печели пред Y)')
  assertEqual(result!.rank, 'J', 'Ранк')
})

// [5] Поредица от masters в Z → J, после 9 (ако вече master), чак после Y
check('[5] Поредица от masters в Z: J после 9, чак след това Y', () => {
  // X (clubs) топ карта е Q — по-висока K все още неизиграна → не master
  // (виж бележката в тест [4] за непрекъснатата J>9>A>10>K верига).
  const botHand: ServerCard[] = [
    makeCard('clubs', 'Q'), // X, не master (K неизиграна)
    makeCard('spades', 'J'), // Z, master
    makeCard('spades', '9'), // Z, ще стане master след J
    makeCard('hearts', '8'), // Y
  ]
  // Валето И 9-ката трябва да са ЛИЧНО изиграни от бота, за да потвърдят
  // Случай A (иначе Случай B се активира и Z/X master проверките отпадат).
  const completedTricksInit: ServerCompletedTrick[] = [
    makeRealisticTrick(
      0,
      BOT,
      {
        [BOT]: makeCard('clubs', 'J'),
        [OPP1]: makeCard('clubs', 'A'),
        [PARTNER]: makeCard('clubs', '10'),
        [OPP2]: makeCard('diamonds', '7'),
      },
      BOT_ALL_TRUMPS_WIN,
    ),
    makeRealisticTrick(
      1,
      BOT,
      {
        [BOT]: makeCard('clubs', '9'), // лично изиграна от бота
        [OPP1]: makeCard('diamonds', 'K'),
        [PARTNER]: makeCard('diamonds', 'Q'),
        [OPP2]: makeCard('clubs', '7'),
      },
      BOT_ALL_TRUMPS_WIN,
    ),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: COMBO_ENTRIES,
    winningBid: BOT_ALL_TRUMPS_WIN,
    completedTricks: completedTricksInit,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'spades', 'Боя (Z master J печели)')
  assertEqual(result!.rank, 'J', 'Ранк')

  // След J♠ изигран → 9♠ е следваща топ карта в Z=spades, лично властна
  // (J е единствената по-висока, вече изиграна) → продължава Z, не Y.
  const completedTricksAfterJ: ServerCompletedTrick[] = [
    ...completedTricksInit,
    makeRealisticTrick(
      2,
      BOT,
      {
        [BOT]: makeCard('spades', 'J'),
        [OPP1]: makeCard('spades', '8'),
        [PARTNER]: makeCard('spades', 'K'),
        [OPP2]: makeCard('spades', '10'),
      },
      BOT_ALL_TRUMPS_WIN,
    ),
  ]
  const handAfterJ: ServerCard[] = [
    makeCard('clubs', 'Q'), // X все още не master (K неизиграна)
    makeCard('spades', '9'),
    makeCard('hearts', '8'),
  ]
  const stateAfterJ = makeBaseState({
    botSeat: BOT,
    hand: handAfterJ,
    bidEntries: COMBO_ENTRIES,
    winningBid: BOT_ALL_TRUMPS_WIN,
    completedTricks: completedTricksAfterJ,
  })
  const resultAfterJ = pickServerBotPlayCard(stateAfterJ, BOT)
  assert(resultAfterJ !== null, 'Трябва да върне карта (след J♠)')
  assertEqual(resultAfterJ!.suit, 'spades', 'Боя (9♠ лично властна — Z продължава)')
  assertEqual(resultAfterJ!.rank, '9', 'Ранк')
})

// [6] Няколко трети бои Z1/Z2 → conventional master-lead ред, без hardcode
check('[6] Няколко Z (spades, diamonds) → conventional master-lead избор', () => {
  // X (clubs) топ карта е Q — K неизиграна → не master. J и 9 лично
  // изиграни от бота (две взятки), за да потвърдят Случай A.
  // И двете Z имат master карта; chooseAllTrumpsMasterLead избира по дължина
  // на групата, после сила — тук diamonds има 2 карти (по-дълга), spades 1.
  const botHand: ServerCard[] = [
    makeCard('clubs', 'Q'), // X, не master (K неизиграна)
    makeCard('spades', 'J'), // Z1, 1 карта, master
    makeCard('diamonds', 'J'), // Z2, 2 карти, master
    makeCard('diamonds', '7'),
    makeCard('hearts', '8'), // Y
  ]
  const completedTricks: ServerCompletedTrick[] = [
    makeRealisticTrick(
      0,
      BOT,
      {
        [BOT]: makeCard('clubs', 'J'),
        [OPP1]: makeCard('clubs', 'A'),
        [PARTNER]: makeCard('clubs', '10'),
        [OPP2]: makeCard('hearts', '7'),
      },
      BOT_ALL_TRUMPS_WIN,
    ),
    makeRealisticTrick(
      1,
      BOT,
      {
        [BOT]: makeCard('clubs', '9'), // лично изиграна от бота
        [OPP1]: makeCard('hearts', 'K'),
        [PARTNER]: makeCard('hearts', 'Q'),
        [OPP2]: makeCard('clubs', '7'),
      },
      BOT_ALL_TRUMPS_WIN,
    ),
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
  // Не проверяваме кой конкретен Z печели (зависи от conventional master-lead
  // сортировката, не hardcode-ваме) — само че резултатът е Z, не X, не Y.
  assert(result!.suit === 'diamonds' || result!.suit === 'spades', `Трябва да е Z (spades/diamonds), получено ${result!.suit}`)
  assertEqual(result!.rank, 'J', 'Ранк (master)')
})

// [7] Master само в Y (нито X, нито Z) → подава Y, план приключва
check('[7] Master само в Y → играе Y, планът приключва', () => {
  const botHand: ServerCard[] = [
    makeCard('clubs', 'Q'), // X, не master (K неизиграна)
    makeCard('diamonds', '8'), // Z, не master (нищо от diamonds изиграно)
    makeCard('hearts', 'J'), // Y, master (J е връх)
  ]
  const completedTricks: ServerCompletedTrick[] = [
    makeRealisticTrick(
      0,
      BOT,
      {
        [BOT]: makeCard('clubs', 'J'),
        [OPP1]: makeCard('clubs', 'A'),
        [PARTNER]: makeCard('clubs', '9'),
        [OPP2]: makeCard('clubs', '10'),
      },
      BOT_ALL_TRUMPS_WIN,
    ),
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
  assertEqual(result!.suit, 'hearts', 'Боя (Y — единствен master)')
  assertEqual(result!.rank, 'J', 'Ранк')

  // Планът е приключен → следващ свободен lead не форсира Y отново.
  const completedTricksAfterY: ServerCompletedTrick[] = [
    ...completedTricks,
    makeRealisticTrick(
      1,
      BOT,
      {
        [BOT]: makeCard('hearts', 'J'),
        [OPP1]: makeCard('hearts', '8'),
        [PARTNER]: makeCard('hearts', '7'),
        [OPP2]: makeCard('hearts', 'A'),
      },
      BOT_ALL_TRUMPS_WIN,
    ),
  ]
  const handAfterY: ServerCard[] = [
    makeCard('diamonds', '8'),
  ]
  const stateAfterY = makeBaseState({
    botSeat: BOT,
    hand: handAfterY,
    bidEntries: COMBO_ENTRIES,
    winningBid: BOT_ALL_TRUMPS_WIN,
    completedTricks: completedTricksAfterY,
  })
  const resultAfterY = pickServerBotPlayCard(stateAfterY, BOT)
  assert(resultAfterY !== null, 'Трябва да върне карта (след Y)')
  assertEqual(resultAfterY!.suit, 'diamonds', 'Боя (план приключен, единствената налична карта)')
})

// [8] X лично master (Случай A: X имала Вале+9), дори с master в Z → X първо, после Z
check('[8] X master печели пред Z master (Случай A: X имала Вале+9)', () => {
  // Ботът държи J+9 в X (потвърждава Случай A) → X master (J) печели пред Z.
  const botHand: ServerCard[] = [
    makeCard('clubs', 'J'), // X, master (връх)
    makeCard('clubs', '9'), // X, потвърждава Случай A
    makeCard('spades', 'J'), // Z, също master
    makeCard('hearts', '8'), // Y
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: COMBO_ENTRIES,
    winningBid: BOT_ALL_TRUMPS_WIN,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'clubs', 'Боя (X master печели пред Z master)')
  assertEqual(result!.rank, 'J', 'Ранк')

  // След X master J изигран → следваща топ карта в X е 9♣ (лично властна,
  // J единствената по-висока, вече изиграна) → X ПРОДЪЛЖАВА, не Z все още.
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
  ]
  const handAfterJ: ServerCard[] = [
    makeCard('clubs', '9'),
    makeCard('spades', 'J'),
    makeCard('hearts', '8'),
  ]
  const stateAfterJ = makeBaseState({
    botSeat: BOT,
    hand: handAfterJ,
    bidEntries: COMBO_ENTRIES,
    winningBid: BOT_ALL_TRUMPS_WIN,
    completedTricks,
  })
  const resultAfterJ = pickServerBotPlayCard(stateAfterJ, BOT)
  assert(resultAfterJ !== null, 'Трябва да върне карта (след J)')
  assertEqual(resultAfterJ!.suit, 'clubs', 'Боя (9♣ лично властна — X продължава)')
  assertEqual(resultAfterJ!.rank, '9', 'Ранк')

  // Едва след X изчерпана (9 изиграна) → следващ lead преминава към Z master.
  const completedTricksAfterNine: ServerCompletedTrick[] = [
    ...completedTricks,
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
  const handAfterX: ServerCard[] = [
    makeCard('spades', 'J'),
    makeCard('hearts', '8'),
  ]
  const stateAfterX = makeBaseState({
    botSeat: BOT,
    hand: handAfterX,
    bidEntries: COMBO_ENTRIES,
    winningBid: BOT_ALL_TRUMPS_WIN,
    completedTricks: completedTricksAfterNine,
  })
  const resultAfterX = pickServerBotPlayCard(stateAfterX, BOT)
  assert(resultAfterX !== null, 'Трябва да върне карта (след X)')
  assertEqual(resultAfterX!.suit, 'spades', 'Боя (X изчерпана → Z master поема)')
  assertEqual(resultAfterX!.rank, 'J', 'Ранк')
})

// [9] Follow ситуация → правилото не участва, само законни карти
check('[9] Follow ситуация → само законна карта, правилото не участва', () => {
  const botHand: ServerCard[] = [
    makeCard('diamonds', '7'),
    makeCard('clubs', 'J'),
    makeCard('clubs', '9'),
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
  assertEqual(result!.rank, '7', 'Ранк (единствена законна diamonds карта)')
})

// [10] След приключване на плана → нормални partner signals/master lead
check('[10-mandatory] След подаване в Y → mandatory J-сигнал работи нормално', () => {
  const completedTricks: ServerCompletedTrick[] = [
    makeRealisticTrick(
      0,
      BOT,
      {
        [BOT]: makeCard('hearts', 'A'), // подаване в Y (X/Z нямаха master тук)
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
    makeCard('clubs', 'A'), // X, не master (J♣ не е у бота/изиграна)
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
  assertEqual(result!.suit, 'diamonds', 'Боя (mandatory сигнал печели след изпълнен план)')
})

check('[10-color] След подаване в Y → color-сигнал работи нормално', () => {
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

// [11] Симетрия: различни X/Y/Z комбинации, без hardcode
check('[11-a] Симетрия: X=diamonds (Случай A: Вале+9), Y=spades → X master печели', () => {
  const symmetricEntries: ServerBidEntry[] = [
    { seat: BOT, action: { type: 'suit', suit: 'diamonds' } },
    { seat: OPP1, action: { type: 'pass' } },
    { seat: PARTNER, action: { type: 'suit', suit: 'spades' } },
    { seat: OPP2, action: { type: 'pass' } },
    { seat: BOT, action: { type: 'all-trumps' } },
    { seat: OPP1, action: { type: 'pass' } },
    { seat: PARTNER, action: { type: 'pass' } },
    { seat: OPP2, action: { type: 'pass' } },
  ]

  // X=diamonds има Вале+9 → Случай A → X master (J) печели пред Y.
  const botHand: ServerCard[] = [
    makeCard('diamonds', 'J'),
    makeCard('diamonds', '9'),
    makeCard('diamonds', 'Q'),
    makeCard('diamonds', '7'),
    makeCard('spades', '8'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: symmetricEntries,
    winningBid: ALL_TRUMPS_WINNING_BID_TEMPLATE(BOT),
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  // J♦ е лично властна (връх на trump реда) → X печели, дори Y=spades налична
  assertEqual(result!.suit, 'diamonds', 'Боя (X=diamonds master печели, симетрично)')
  assertEqual(result!.rank, 'J', 'Ранк')
})

check('[11-b] Симетрия (Случай A): X=diamonds (без master), Y=spades → подава Y', () => {
  // Bidding suit order: clubs < diamonds < hearts < spades — Y трябва да е
  // ПО-ВИСОКА от X (X=spades няма валидна по-висока боя над себе си, затова
  // X=diamonds, Y=spades тук).
  const symmetricEntries: ServerBidEntry[] = [
    { seat: BOT, action: { type: 'suit', suit: 'diamonds' } },
    { seat: OPP1, action: { type: 'pass' } },
    { seat: PARTNER, action: { type: 'suit', suit: 'spades' } },
    { seat: OPP2, action: { type: 'pass' } },
    { seat: BOT, action: { type: 'all-trumps' } },
    { seat: OPP1, action: { type: 'pass' } },
    { seat: PARTNER, action: { type: 'pass' } },
    { seat: OPP2, action: { type: 'pass' } },
  ]

  // X (diamonds) топ карта е Q — K все още неизиграна и никой не е доказано
  // void → Q не е master (виж бележката в тест [4] за trump реда). J и 9 от
  // X лично изиграни от бота (потвърждава Случай A).
  const completedTricks: ServerCompletedTrick[] = [
    makeRealisticTrick(
      0,
      BOT,
      {
        [BOT]: makeCard('diamonds', 'J'),
        [OPP1]: makeCard('diamonds', 'A'), // следва → не void
        [PARTNER]: makeCard('diamonds', '10'),
        [OPP2]: makeCard('hearts', '7'),
      },
      BOT_ALL_TRUMPS_WIN,
    ),
    makeRealisticTrick(
      1,
      BOT,
      {
        [BOT]: makeCard('diamonds', '9'), // лично изиграна от бота
        [OPP1]: makeCard('hearts', 'K'),
        [PARTNER]: makeCard('hearts', 'Q'),
        [OPP2]: makeCard('diamonds', '7'), // следва → не void
      },
      BOT_ALL_TRUMPS_WIN,
    ),
  ]

  const botHand: ServerCard[] = [
    makeCard('diamonds', 'Q'), // X, не master (K неизиграна)
    makeCard('spades', '8'), // Y
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: symmetricEntries,
    winningBid: ALL_TRUMPS_WINNING_BID_TEMPLATE(BOT),
    completedTricks,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'spades', 'Боя (Y=spades, симетрично работи за произволни X/Y)')
  assertEqual(result!.rank, '8', 'Ранк')
})

// ─── Допълнителни защити ────────────────────────────────────────────────────

check('[12] Без активна bidding комбинация → chooseAllTrumpsMasterLead непроменен', () => {
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

check('[13] Няма карта от X, master в Z, нито Y → безопасен fallback', () => {
  const botHand: ServerCard[] = [
    makeCard('spades', '8'), // Z, не master (J неизиграна, никой void)
    makeCard('diamonds', '7'), // друга боя без връзка
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

check('[14] Празни bidding.entries (ново раздаване) → правилото не се активира', () => {
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

check('[15] След еднократно подаване в Y → следващ lead не форсира отново', () => {
  const completedTricks: ServerCompletedTrick[] = [
    makeRealisticTrick(
      0,
      BOT,
      {
        [BOT]: makeCard('hearts', 'A'), // подаване в Y
        [OPP1]: makeCard('diamonds', '7'),
        [PARTNER]: makeCard('hearts', '7'),
        [OPP2]: makeCard('diamonds', 'K'),
      },
      BOT_ALL_TRUMPS_WIN,
    ),
  ]

  const botHand: ServerCard[] = [
    makeCard('spades', 'J'), // master в трета боя — план приключен, старата логика поема
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
  assertEqual(result!.suit, 'spades', 'Боя (план приключен, master lead работи)')
  assertEqual(result!.rank, 'J', 'Ранк')
})

// ─── Случай B: X имала Вале, но НЕ 9 — първоначалната конвенция ─────────────

check('[16] J+A+Q+7 в X (без 9) + карта от Y → директно Y, НЕ играе J от X', () => {
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
  assertEqual(result!.suit, 'hearts', 'Боя (Y директно, Случай B — без 9 в X)')
  assertEqual(result!.rank, '8', 'Ранк (единствена Y карта)')
})

check('[17] J+A+Q+7 в X (без 9) + властно Вале в Z + карта от Y → пак Y, нито J от X, нито J от Z', () => {
  const botHand: ServerCard[] = [
    makeCard('clubs', 'J'), // X, master, но БЕЗ 9 → Случай B
    makeCard('clubs', 'A'),
    makeCard('clubs', 'Q'),
    makeCard('clubs', '7'),
    makeCard('spades', 'J'), // Z, също master
    makeCard('hearts', '8'), // Y
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: COMBO_ENTRIES,
    winningBid: BOT_ALL_TRUMPS_WIN,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'hearts', 'Боя (Y печели пред J от X И пред J от Z — Случай B)')
  assertEqual(result!.rank, '8', 'Ранк')
})

check('[18-a] Случай B: Y = 8+A → играе А (най-висока)', () => {
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
  assertEqual(result!.rank, 'A', 'Ранк (А > 8 в trump реда)')
})

check('[18-b] Случай B: Y = 9+A → играе 9 (9 > A в trump реда)', () => {
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
  assertEqual(result!.rank, '9', 'Ранк (9 > A в trump реда J>9>A>10>K>Q>8>7)')
})

check('[18-c] Случай B: Y = J+9 → играе J (връх на trump реда)', () => {
  const botHand: ServerCard[] = [
    makeCard('clubs', 'J'), // X master, но без 9 в X → Случай B
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

check('[19] Случай B: след еднократно подаване в Y → планът приключва, нормална логика поема', () => {
  // Ботът вече е повел с 8♥ (Y) в предишна взятка — Случай B изпълнен.
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
    makeCard('clubs', 'J'), // X master, без 9 в X — но планът вече е приключен
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
  // Планът приключен → нормалната master-lead логика поема → J♣ (master)
  assertEqual(result!.suit, 'clubs', 'Боя (план приключен — нормална master-lead логика)')
  assertEqual(result!.rank, 'J', 'Ранк')
})

check('[11-b-case-b] Симетрия (Случай B): X=diamonds (без 9), Y=spades → подава Y', () => {
  // Bidding suit order: clubs < diamonds < hearts < spades — партньорската
  // обява (Y) трябва да е ПО-ВИСОКА от X, затова X=diamonds, Y=spades тук
  // (не X=spades, което няма по-висока боя над себе си).
  const symmetricEntries: ServerBidEntry[] = [
    { seat: BOT, action: { type: 'suit', suit: 'diamonds' } },
    { seat: OPP1, action: { type: 'pass' } },
    { seat: PARTNER, action: { type: 'suit', suit: 'spades' } },
    { seat: OPP2, action: { type: 'pass' } },
    { seat: BOT, action: { type: 'all-trumps' } },
    { seat: OPP1, action: { type: 'pass' } },
    { seat: PARTNER, action: { type: 'pass' } },
    { seat: OPP2, action: { type: 'pass' } },
  ]

  // X=diamonds има Вале, но БЕЗ 9 → Случай B → директно Y=spades, дори J♦ master.
  const botHand: ServerCard[] = [
    makeCard('diamonds', 'J'),
    makeCard('diamonds', 'A'),
    makeCard('diamonds', 'Q'),
    makeCard('diamonds', '7'),
    makeCard('spades', '8'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: symmetricEntries,
    winningBid: ALL_TRUMPS_WINNING_BID_TEMPLATE(BOT),
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'spades', 'Боя (Y=spades директно, Случай B симетрично)')
  assertEqual(result!.rank, '8', 'Ранк')
})

// ─── Конфликтен тест: наличието на 9 в X определя целия план ────────────────

check('[20-a] Конфликтен тест, Ръка 1: X=J,9,8,7 (Случай A) → J от X, после 9 от X', () => {
  const botHand: ServerCard[] = [
    makeCard('clubs', 'J'),
    makeCard('clubs', '9'),
    makeCard('clubs', '8'),
    makeCard('clubs', '7'),
    makeCard('spades', 'J'), // Z
    makeCard('hearts', 'A'), // Y
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: COMBO_ENTRIES,
    winningBid: BOT_ALL_TRUMPS_WIN,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'clubs', 'Боя (Случай A — X master J печели пред Z и Y)')
  assertEqual(result!.rank, 'J', 'Ранк')

  // След J → 9♣ лично властна (J единствената по-висока, изиграна) → X продължава
  const completedTricks: ServerCompletedTrick[] = [
    makeRealisticTrick(
      0,
      BOT,
      {
        [BOT]: makeCard('clubs', 'J'),
        [OPP1]: makeCard('clubs', 'A'),
        [PARTNER]: makeCard('clubs', 'K'),
        [OPP2]: makeCard('clubs', '10'),
      },
      BOT_ALL_TRUMPS_WIN,
    ),
  ]
  const handAfterJ: ServerCard[] = [
    makeCard('clubs', '9'),
    makeCard('clubs', '8'),
    makeCard('clubs', '7'),
    makeCard('spades', 'J'),
    makeCard('hearts', 'A'),
  ]
  const stateAfterJ = makeBaseState({
    botSeat: BOT,
    hand: handAfterJ,
    bidEntries: COMBO_ENTRIES,
    winningBid: BOT_ALL_TRUMPS_WIN,
    completedTricks,
  })
  const resultAfterJ = pickServerBotPlayCard(stateAfterJ, BOT)
  assert(resultAfterJ !== null, 'Трябва да върне карта (след J)')
  assertEqual(resultAfterJ!.suit, 'clubs', 'Боя (9♣ лично властна — X продължава, Случай A)')
  assertEqual(resultAfterJ!.rank, '9', 'Ранк')
})

check('[20-b] Конфликтен тест, Ръка 2: X=J,A,Q,7 без 9 (Случай B) → директно A от Y, не J от X, не J от Z', () => {
  // Почти същата ръка като Ръка 1, но БЕЗ 9 в X (заменена с A,Q вместо 9,8) —
  // единствената разлика е липсата на 9 в X, но поведението е коренно различно.
  const botHand: ServerCard[] = [
    makeCard('clubs', 'J'),
    makeCard('clubs', 'A'),
    makeCard('clubs', 'Q'),
    makeCard('clubs', '7'),
    makeCard('spades', 'J'), // Z, master — но не изпреварва Y в Случай B
    makeCard('hearts', 'A'), // Y
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: COMBO_ENTRIES,
    winningBid: BOT_ALL_TRUMPS_WIN,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  // Случай B: директно Y, нито J от X, нито J от Z
  assertEqual(result!.suit, 'hearts', 'Боя (Случай B — директно Y, липсата на 9 в X определя плана)')
  assertEqual(result!.rank, 'A', 'Ранк (единствена Y карта)')
})

// ─── Резултат ────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
