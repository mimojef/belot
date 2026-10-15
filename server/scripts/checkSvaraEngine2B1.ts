/**
 * checkSvaraEngine2B1.ts — Свара, Етап 2Б.1: тесте, раздаване, оценяване и
 * сравняване на ръце (чист сървърен двигател).
 *
 *  A. Карти: 32 уникални, стойности, кодове, чечак, невалидни данни.
 *  B. Случайност: криптографски източник по подразбиране, пермутация,
 *     детерминистичен тестов източник, равномерност (χ²), лош източник.
 *  C. Раздаване: 2–4 играчи, по 3 карти, без дубликати, ред на раздаване,
 *     контролирано тесте, невалидни данни, 10 000 случайни раздавания.
 *  D. Оценяване: таблица с ръчно изчислени ръце за всяко правило.
 *  D2. Две седмици = 23 (вкл. с чечак) — отделни случаи и всички 168 ръце.
 *  E. Всички 4 960 ръце срещу независимо формулиран еталон; инварианти.
 *  F. Сравняване: победители, равенства (2/3/4), антисиметрия, грешки.
 *  G. Изглед за играч: без чужди карти.
 *  H. Изолация: двигателят не зависи от HTTP/WS/DB/UI; Белот/Ludo непроменени.
 *
 * Пускане (от server/): npm run check:svara-engine-2b1
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  compareSvaraHands,
  createCryptoSvaraRandomSource,
  createSeededSvaraRandomSourceForTests,
  createShuffledSvaraDeck,
  createSvaraDeckFromCards,
  createSvaraPlayerDealView,
  dealSvaraHands,
  evaluateSvaraHand,
  isSvaraCard,
  isSvaraChechak,
  parseSvaraCardCode,
  resolveSvaraShowdown,
  shuffleWithSvaraRandom,
  SVARA_ORDERED_DECK,
  SVARA_RANKS,
  SVARA_SUITS,
  svaraCard,
  svaraCardCode,
  SvaraInvalidInputError,
  svaraRankPoints,
  type SvaraCard,
  type SvaraHandKind,
} from '../src/games/svara/engine/index.js'

let passed = 0
let failed = 0

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function check(label: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  ok ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function expectInvalid(fn: () => unknown, label: string): void {
  try {
    fn()
  } catch (error) {
    if (error instanceof SvaraInvalidInputError) return
    throw new Error(`${label}: expected SvaraInvalidInputError, got ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
  }
  throw new Error(`${label}: expected SvaraInvalidInputError, nothing thrown`)
}

const hand = (...codes: string[]) => codes.map(parseSvaraCardCode)
const codesOf = (cards: readonly SvaraCard[]) => cards.map(svaraCardCode)

console.log('\ncheckSvaraEngine2B1')

// ─── A. Карти ───────────────────────────────────────────────────────────────
console.log('\n=== A. карти ===')

check('A1. тестето е 32 уникални карти: 4 бои × (7, 8, 9, 10, J, Q, K, A)', () => {
  assert(SVARA_ORDERED_DECK.length === 32, `size ${SVARA_ORDERED_DECK.length}`)
  assert(new Set(codesOf(SVARA_ORDERED_DECK)).size === 32, 'duplicates')
  for (const suit of SVARA_SUITS) {
    const ranks = SVARA_ORDERED_DECK.filter((c) => c.suit === suit).map((c) => c.rank)
    assert(JSON.stringify(ranks) === JSON.stringify(['7', '8', '9', '10', 'J', 'Q', 'K', 'A']), `${suit}: ${ranks}`)
  }
  assert(SVARA_ORDERED_DECK.every(isSvaraCard) && SVARA_ORDERED_DECK.every(Object.isFrozen), 'valid & frozen')
})

check('A2. стойности: A=11; 10/J/Q/K=10; 9, 8, 7 по номинал', () => {
  const expected: Record<string, number> = { '7': 7, '8': 8, '9': 9, '10': 10, J: 10, Q: 10, K: 10, A: 11 }
  for (const rank of SVARA_RANKS) assert(svaraRankPoints(rank) === expected[rank], rank)
})

check('A3. кодовете са обратими за всички 32 карти; чечакът е само 7♣', () => {
  for (const card of SVARA_ORDERED_DECK) {
    const back = parseSvaraCardCode(svaraCardCode(card))
    assert(back.rank === card.rank && back.suit === card.suit, svaraCardCode(card))
  }
  assert(SVARA_ORDERED_DECK.filter(isSvaraChechak).map(svaraCardCode).join() === '7C', 'only 7C')
})

check('A4. невалидни карти/кодове се отхвърлят', () => {
  for (const code of ['', '6C', '1H', '11S', 'AX', 'a s', 'KHH', '10', 'T S']) expectInvalid(() => parseSvaraCardCode(code), code)
  expectInvalid(() => parseSvaraCardCode(42 as unknown as string), 'number')
  expectInvalid(() => svaraCard('6' as never, 'clubs'), 'rank 6')
  expectInvalid(() => svaraCard('A', 'stars' as never), 'suit stars')
  for (const bad of [null, undefined, 1, 'AS', [], {}, { suit: 'clubs' }, { suit: 'clubs', rank: '7', extra: 1 }, { suit: 'Clubs', rank: '7' }]) {
    assert(!isSvaraCard(bad), `accepted ${JSON.stringify(bad)}`)
  }
})

// ─── B. Случайност ──────────────────────────────────────────────────────────
console.log('\n=== B. случайност ===')

check('B1. разбъркването е пермутация на 32-те карти и не променя входа', () => {
  const before = codesOf(SVARA_ORDERED_DECK).join()
  for (let i = 0; i < 200; i += 1) {
    const deck = createShuffledSvaraDeck()
    assert(deck.length === 32 && new Set(codesOf(deck)).size === 32, 'not a permutation')
  }
  assert(codesOf(SVARA_ORDERED_DECK).join() === before, 'ordered deck mutated')
})

check('B2. по подразбиране се ползва node:crypto randomInt (CSPRNG)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'games', 'svara', 'engine', 'svaraRandom.ts'), 'utf8')
  assert(/import \{ randomInt \} from 'node:crypto'/.test(source) && /return randomInt\(maxExclusive\)/.test(source), 'crypto randomInt')
  const dealSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'games', 'svara', 'engine', 'svaraDeal.ts'), 'utf8')
  assert(dealSource.includes('random: SvaraRandomSource = createCryptoSvaraRandomSource()'), 'crypto default in createShuffledSvaraDeck')
  assert(!/Math\.random/.test(source + dealSource), 'Math.random used')
  const a = codesOf(createShuffledSvaraDeck()).join()
  const b = codesOf(createShuffledSvaraDeck()).join()
  assert(a !== b, 'two crypto shuffles identical (p≈1/32!)')
})

check('B3. равномерност (χ², 64 000 разбърквания): всяка карта на горната позиция и на позиция 31', () => {
  const random = createCryptoSvaraRandomSource()
  const top = new Map<string, number>()
  const bottom = new Map<string, number>()
  const runs = 64_000
  for (let i = 0; i < runs; i += 1) {
    const deck = shuffleWithSvaraRandom(SVARA_ORDERED_DECK, random)
    const t = svaraCardCode(deck[0]!)
    const b = svaraCardCode(deck[31]!)
    top.set(t, (top.get(t) ?? 0) + 1)
    bottom.set(b, (bottom.get(b) ?? 0) + 1)
  }
  const expected = runs / 32
  for (const [name, counts] of [['top', top], ['bottom', bottom]] as const) {
    const chi = [...SVARA_ORDERED_DECK].reduce((sum, card) => sum + ((counts.get(svaraCardCode(card)) ?? 0) - expected) ** 2 / expected, 0)
    // df = 31; p ≈ 1e-6 при χ² ≈ 80 → практически без фалшиви провали.
    assert(chi < 80, `${name}: χ²=${chi.toFixed(1)}`)
  }
})

check('B4. детерминистичен тестов източник: същото семе → същото тесте; различно семе → различно', () => {
  const a = codesOf(createShuffledSvaraDeck(createSeededSvaraRandomSourceForTests(7))).join()
  const b = codesOf(createShuffledSvaraDeck(createSeededSvaraRandomSourceForTests(7))).join()
  const c = codesOf(createShuffledSvaraDeck(createSeededSvaraRandomSourceForTests(8))).join()
  assert(a === b && a !== c, 'seeded determinism')
})

check('B5. неизправен източник на случайност се отхвърля', () => {
  for (const bad of [-1, 99, 0.5, NaN]) {
    expectInvalid(() => shuffleWithSvaraRandom(SVARA_ORDERED_DECK, { nextInt: () => bad }), `nextInt=${bad}`)
  }
})

// ─── C. Раздаване ───────────────────────────────────────────────────────────
console.log('\n=== C. раздаване ===')

for (const count of [2, 3, 4]) {
  check(`C1. ${count} играчи: по 3 карти, без дубликати, остатък ${32 - count * 3}, обединението = тестето`, () => {
    const players = ['p1', 'p2', 'p3', 'p4'].slice(0, count)
    const deck = createShuffledSvaraDeck()
    const deal = dealSvaraHands(players, deck)
    const dealt = players.flatMap((p) => codesOf(deal.hands.get(p)!))
    assert(players.every((p) => deal.hands.get(p)!.length === 3), 'hand size')
    assert(new Set(dealt).size === count * 3, 'duplicate dealt card')
    assert(deal.remainingDeck.length === 32 - count * 3, 'remaining size')
    assert(new Set([...dealt, ...codesOf(deal.remainingDeck)]).size === 32, 'union is not the deck')
    assert(JSON.stringify(deal.playerOrder) === JSON.stringify(players), 'player order')
  })
}

check('C2. ред на раздаване: по една карта, по реда на играчите, отгоре на тестето', () => {
  const deck = createSvaraDeckFromCards(SVARA_ORDERED_DECK)
  const deal = dealSvaraHands(['a', 'b', 'c'], deck)
  const order = codesOf(SVARA_ORDERED_DECK)
  assert(codesOf(deal.hands.get('a')!).join() === [order[0], order[3], order[6]].join(), 'a')
  assert(codesOf(deal.hands.get('b')!).join() === [order[1], order[4], order[7]].join(), 'b')
  assert(codesOf(deal.hands.get('c')!).join() === [order[2], order[5], order[8]].join(), 'c')
  assert(codesOf(deal.remainingDeck)[0] === order[9], 'remaining top')
})

check('C3. контролирано тесте: точно определени ръце (за тестове на правилата)', () => {
  const wanted = ['7C', 'AS', 'KH', 'AH', 'KS', 'KD']
  const rest = codesOf(SVARA_ORDERED_DECK).filter((c) => !wanted.includes(c))
  const deal = dealSvaraHands(['me', 'you'], createSvaraDeckFromCards([...wanted, ...rest].map(parseSvaraCardCode)))
  assert(codesOf(deal.hands.get('me')!).join() === '7C,KH,KS', codesOf(deal.hands.get('me')!).join())
  assert(codesOf(deal.hands.get('you')!).join() === 'AS,AH,KD', codesOf(deal.hands.get('you')!).join())
})

check('C4. невалидни играчи и тестета се отхвърлят; входното тесте не се променя', () => {
  const deck = createShuffledSvaraDeck()
  const snapshot = codesOf(deck).join()
  expectInvalid(() => dealSvaraHands(['solo'], deck), '1 player')
  expectInvalid(() => dealSvaraHands(['a', 'b', 'c', 'd', 'e'], deck), '5 players')
  expectInvalid(() => dealSvaraHands([], deck), '0 players')
  expectInvalid(() => dealSvaraHands(['a', 'a'], deck), 'duplicate ids')
  expectInvalid(() => dealSvaraHands(['a', ' '], deck), 'blank id')
  expectInvalid(() => dealSvaraHands(['a', 7 as unknown as string], deck), 'non-string id')
  expectInvalid(() => dealSvaraHands('ab' as unknown as string[], deck), 'string instead of array')
  expectInvalid(() => dealSvaraHands(['a', 'b'], deck.slice(1)), '31-card deck')
  expectInvalid(() => dealSvaraHands(['a', 'b'], [...deck.slice(1), deck[0]!, deck[0]!]), '33 cards')
  expectInvalid(() => dealSvaraHands(['a', 'b'], [deck[1]!, ...deck.slice(1)]), 'duplicate card')
  expectInvalid(() => dealSvaraHands(['a', 'b'], [{ suit: 'clubs', rank: '6' } as unknown as SvaraCard, ...deck.slice(1)]), 'invalid card')
  expectInvalid(() => createSvaraDeckFromCards(deck.slice(0, 30)), 'short controlled deck')
  assert(codesOf(deck).join() === snapshot, 'input deck mutated')
})

check('C5. 10 000 случайни раздавания (2–4 играчи): нито една карта два пъти, ръце от по 3', () => {
  for (let i = 0; i < 10_000; i += 1) {
    const count = 2 + (i % 3)
    const players = Array.from({ length: count }, (_, k) => `p${k}`)
    const deal = dealSvaraHands(players, createShuffledSvaraDeck())
    const dealt = players.flatMap((p) => codesOf(deal.hands.get(p)!))
    if (dealt.length !== count * 3 || new Set(dealt).size !== dealt.length) throw new Error(`run ${i}: invalid deal`)
  }
})

// ─── D. Оценяване: ръчно изчислени ръце ─────────────────────────────────────
console.log('\n=== D. оценяване (ръчна таблица) ===')

const GOLDEN: Array<[string, number, SvaraHandKind, string]> = [
  ['7S 7H 7D', 34, 'three-sevens', 'три седмици без чечак'],
  ['7C 7H 7D', 34, 'three-sevens', 'три седмици с чечак'],
  ['7C 7S 7H', 34, 'three-sevens', 'чечак + 7♠ + 7♥'],
  ['AS AH AD', 33, 'three-aces', 'три аса'],
  ['7C AS AH', 33, 'three-aces', 'чечак + две аса'],
  ['KS KH KD', 30, 'three-of-a-kind', 'три попа'],
  ['QS QH QD', 30, 'three-of-a-kind', 'три дами'],
  ['JS JH JD', 30, 'three-of-a-kind', 'три валета'],
  ['10S 10H 10D', 30, 'three-of-a-kind', 'три десетки'],
  ['9S 9H 9D', 27, 'three-of-a-kind', 'три деветки'],
  ['8S 8H 8D', 24, 'three-of-a-kind', 'три осмици'],
  ['8C 8H 8D', 24, 'three-of-a-kind', 'три осмици със спатия'],
  ['7C KH KD', 31, 'chechak-three-of-a-kind', 'пример на собственика: 31, не 30'],
  ['7C QS QH', 31, 'chechak-three-of-a-kind', 'чечак + две дами'],
  ['7C JS JD', 31, 'chechak-three-of-a-kind', 'чечак + две валета'],
  ['7C 10H 10S', 31, 'chechak-three-of-a-kind', 'чечак + две десетки'],
  ['7C 9S 9H', 29, 'chechak-three-of-a-kind', 'чечак + две деветки'],
  ['7C 8S 8D', 27, 'chechak-three-of-a-kind', 'чечак + две осмици'],
  ['AS AH KS', 22, 'two-aces', 'две аса (22) > пика 21'],
  ['AS AD 9C', 22, 'two-aces', 'две аса'],
  ['AC AH 10H', 22, 'two-aces', 'две аса (22) > купа 21'],
  ['AS KS QS', 31, 'suit-sum', 'A+K+Q в една боя'],
  ['10S 9S 8S', 27, 'suit-sum', 'сбор в една боя'],
  ['AS KS 9H', 21, 'suit-sum', 'две карти в една боя'],
  ['8S 7S AH', 15, 'suit-sum', '8+7 пика > асо купа'],
  ['AS KH QD', 11, 'suit-sum', 'три бои → най-високата карта'],
  ['9S 8H 7D', 9, 'suit-sum', 'три бои → 9'],
  ['7S 7H 8D', 23, 'two-sevens', 'две седмици = 23'],
  ['7C AS KS', 32, 'suit-sum', 'пример на собственика: чечак към пика = 32'],
  ['7C 9H 8D', 20, 'suit-sum', 'пример на собственика: 11 + 9 = 20'],
  ['7C AC KC', 32, 'suit-sum', 'чечак със спатии'],
  ['7C 7S 8S', 26, 'suit-sum', 'чечак + 7♠ + 8♠ = 11 + 15'],
  ['7C 7S AH', 23, 'two-sevens', 'две седмици (23) > чечак към асото (22)'],
  ['7C AS 7H', 23, 'two-sevens', 'две седмици (23) > чечак + асо (22)'],
  ['7C AD 7D', 29, 'suit-sum', 'чечак + асо каро + 7 каро = 29'],
  ['7C KS QS', 31, 'suit-sum', 'чечак + K+Q в една боя'],
]

for (const [codes, points, kind, note] of GOLDEN) {
  check(`D. ${codes.padEnd(11)} → ${String(points).padStart(2)} ${kind} (${note})`, () => {
    const evaluation = evaluateSvaraHand(hand(...codes.split(' ')))
    assert(evaluation.points === points && evaluation.kind === kind, `got ${evaluation.points} ${evaluation.kind} [${evaluation.candidates.map((c) => `${c.kind}:${c.points}`).join(', ')}]`)
  })
}

check('D-inv. невалидни ръце се отхвърлят', () => {
  expectInvalid(() => evaluateSvaraHand(hand('AS', 'KS')), '2 cards')
  expectInvalid(() => evaluateSvaraHand(hand('AS', 'KS', 'QS', 'JS')), '4 cards')
  expectInvalid(() => evaluateSvaraHand(hand('AS', 'AS', 'KS')), 'duplicate card')
  expectInvalid(() => evaluateSvaraHand([...hand('AS', 'KS'), { suit: 'hearts', rank: '6' } as unknown as SvaraCard]), 'invalid card')
  expectInvalid(() => evaluateSvaraHand(null as unknown as SvaraCard[]), 'null')
  expectInvalid(() => evaluateSvaraHand('AS KS QS' as unknown as SvaraCard[]), 'string')
})

// ─── D2. Две седмици ────────────────────────────────────────────────────────
console.log('\n=== D2. две седмици (23, вкл. с чечак) ===')

const TWO_SEVENS: Array<[string, number, SvaraHandKind, string]> = [
  ['7H 7D KS', 23, 'two-sevens', 'пример на собственика'],
  ['7C 7H KS', 23, 'two-sevens', 'пример на собственика: с чечак'],
  ['7S 7D 10D', 23, 'two-sevens', 'пример на собственика: 23 > каро 17'],
  ['7C 7H 9H', 27, 'suit-sum', 'пример на собственика: чечак + купа 16 = 27 > 23'],
  ['7S 7H 7D', 34, 'three-sevens', 'пример на собственика: три седмици'],
  ['7C 7S 7D', 34, 'three-sevens', 'три седмици с чечак'],
  // всички 6 комбинации от бои с неутрална трета карта
  ['7C 7D 9S', 23, 'two-sevens', '♣♦ (чечак) + 9♠ (чечак+9 = 20 < 23)'],
  ['7C 7S 8H', 23, 'two-sevens', '♣♠ (чечак)'],
  ['7D 7H QS', 23, 'two-sevens', '♦♥'],
  ['7D 7S QC', 23, 'two-sevens', '♦♠'],
  ['7H 7S AC', 23, 'two-sevens', '♥♠ + асо спатия'],
  ['7S 7D AD', 23, 'two-sevens', '23 > каро 18'],
  // чечак + седмица + карта в боята на седмицата → по-високият сбор
  ['7C 7D 8D', 26, 'suit-sum', 'чечак + каро 15 = 26'],
  ['7C 7S AS', 29, 'suit-sum', 'чечак + пика 18 = 29'],
  ['7C 7H KH', 28, 'suit-sum', 'чечак + купа 17 = 28'],
  ['7C 7H AD', 23, 'two-sevens', 'асо в друга боя: чечак + асо = 22 < 23'],
  // взаимодействие с другите правила
  ['7S 7D AS', 23, 'two-sevens', '23 > пика 18; само едно асо'],
  ['7C AS AH', 33, 'three-aces', 'чечак + две аса остава 33 (само една седмица)'],
]

for (const [codes, points, kind, note] of TWO_SEVENS) {
  check(`D2. ${codes.padEnd(10)} → ${String(points).padStart(2)} ${kind} (${note})`, () => {
    const evaluation = evaluateSvaraHand(hand(...codes.split(' ')))
    assert(evaluation.points === points && evaluation.kind === kind, `got ${evaluation.points} ${evaluation.kind} [${evaluation.candidates.map((c) => `${c.kind}:${c.points}`).join(', ')}]`)
  })
}

check('D2-all. всички 168 ръце с точно две седмици: без чечак = 23; с чечак = 23 или по-висок сбор (26–29)', () => {
  let total = 0
  let twoSevensKind = 0
  for (let i = 0; i < 32; i += 1) for (let j = i + 1; j < 32; j += 1) for (let k = j + 1; k < 32; k += 1) {
    const h = [SVARA_ORDERED_DECK[i]!, SVARA_ORDERED_DECK[j]!, SVARA_ORDERED_DECK[k]!]
    const sevens = h.filter((c) => c.rank === '7')
    if (sevens.length !== 2) continue
    total += 1
    const e = evaluateSvaraHand(h)
    const third = h.find((c) => c.rank !== '7')!
    const otherSeven = sevens.find((c) => c.suit !== 'clubs')!
    const hasChechak = sevens.some((c) => c.suit === 'clubs')
    // Очаквано, изчислено директно: с чечак и трета карта в боята на другата
    // седмица → 11 + 7 + стойност; иначе 23.
    const expected = hasChechak && third.suit === otherSeven.suit ? Math.max(23, 11 + 7 + svaraRankPoints(third.rank)) : 23
    if (e.points !== expected) throw new Error(`${codesOf(h)}: ${e.points} ≠ ${expected}`)
    if (e.kind === 'two-sevens') twoSevensKind += 1
  }
  // C(4,2)=6 двойки × 28 трети карти = 168; с чечак и карта в боята на
  // другата седмица: 3 двойки × 7 карти = 21 ръце надхвърлят 23.
  assert(total === 168 && twoSevensKind === 147, `total ${total}, two-sevens ${twoSevensKind}`)
})

// ─── E. Всички ръце срещу независим еталон ──────────────────────────────────
console.log('\n=== E. всички 4 960 ръце ===')

/**
 * Еталон, формулиран различно от двигателя: по мултимножество на ранговете
 * и групиране по бои, директно от текста на правилата.
 */
function referencePoints(cards: SvaraCard[]): number {
  const value = (c: SvaraCard) => ({ '7': 7, '8': 8, '9': 9, '10': 10, J: 10, Q: 10, K: 10, A: 11 })[c.rank]
  const chechakIn = cards.some((c) => c.rank === '7' && c.suit === 'clubs')
  const plain = cards.filter((c) => !(c.rank === '7' && c.suit === 'clubs'))
  const rankCounts = new Map<string, number>()
  for (const c of cards) rankCounts.set(c.rank, (rankCounts.get(c.rank) ?? 0) + 1)
  const options: number[] = []
  // „Тройка“: три еднакви ранга, или чечак + два еднакви ранга.
  const tripleRank = rankCounts.size === 1 ? cards[0]!.rank : (chechakIn && plain.length === 2 && plain[0]!.rank === plain[1]!.rank ? plain[0]!.rank : null)
  if (tripleRank === '7') options.push(34)
  else if (tripleRank === 'A') options.push(33)
  else if (tripleRank !== null) options.push(rankCounts.size === 1 ? 3 * value(cards[0]!) : 11 + 2 * value(plain[0]!))
  if ((rankCounts.get('A') ?? 0) >= 2) options.push(22)
  if ((rankCounts.get('7') ?? 0) >= 2) options.push(23) // две седмици (7♣ също е седмица)
  // Сбор по боя: групи по боя от обикновените карти; чечакът (11) към най-добрата.
  const bySuit: Record<string, number> = { clubs: 0, diamonds: 0, hearts: 0, spades: 0 }
  for (const c of plain) bySuit[c.suit] = (bySuit[c.suit] ?? 0) + value(c)
  options.push(Math.max(...Object.values(bySuit)) + (chechakIn ? 11 : 0))
  return Math.max(...options)
}

const ALL_HANDS: SvaraCard[][] = []
for (let i = 0; i < 32; i += 1) for (let j = i + 1; j < 32; j += 1) for (let k = j + 1; k < 32; k += 1) {
  ALL_HANDS.push([SVARA_ORDERED_DECK[i]!, SVARA_ORDERED_DECK[j]!, SVARA_ORDERED_DECK[k]!])
}

check('E1. 4 960 ръце: двигателят = еталона за всяка ръка', () => {
  assert(ALL_HANDS.length === 4960, `hands ${ALL_HANDS.length}`)
  const mismatches = ALL_HANDS.filter((h) => evaluateSvaraHand(h).points !== referencePoints(h))
  assert(mismatches.length === 0, `${mismatches.length} mismatches, e.g. ${mismatches.slice(0, 3).map((h) => codesOf(h).join(' ')).join(' | ')}`)
})

check('E2. диапазон 8..34; 34 само за три седмици; 33 само за три аса; 32 само с чечак', () => {
  for (const h of ALL_HANDS) {
    const e = evaluateSvaraHand(h)
    assert(e.points >= 8 && e.points <= 34, `${codesOf(h)}: ${e.points}`)
    if (e.points === 34) assert(e.kind === 'three-sevens', `${codesOf(h)}`)
    if (e.points === 33) assert(e.kind === 'three-aces', `${codesOf(h)}`)
    if (e.points === 32) assert(e.usesChechak, `${codesOf(h)}`)
  }
  const sevens = ALL_HANDS.filter((h) => evaluateSvaraHand(h).kind === 'three-sevens').length
  const aces = ALL_HANDS.filter((h) => evaluateSvaraHand(h).kind === 'three-aces').length
  // три седмици: C(4,3)=4; три аса: C(4,3)=4 + 7♣ с C(4,2)=6 двойки аса = 10
  assert(sevens === 4 && aces === 10, `three-sevens ${sevens}, three-aces ${aces}`)
})

check('E3. редът на картите не влияе (всички 6 пермутации)', () => {
  for (const h of ALL_HANDS) {
    const base = evaluateSvaraHand(h)
    for (const perm of [[0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
      const e = evaluateSvaraHand(perm.map((i) => h[i]!))
      if (e.points !== base.points || e.kind !== base.kind) throw new Error(`${codesOf(h)} vs perm ${perm}`)
    }
  }
})

check('E4. размяна на бои не влияе (за ръце без седмици — няма чечак)', () => {
  const swap: Record<string, string> = { clubs: 'hearts', hearts: 'spades', spades: 'diamonds', diamonds: 'clubs' }
  for (const h of ALL_HANDS.filter((x) => x.every((c) => c.rank !== '7'))) {
    const swapped = h.map((c) => svaraCard(c.rank, swap[c.suit] as SvaraCard['suit']))
    if (evaluateSvaraHand(h).points !== evaluateSvaraHand(swapped).points) throw new Error(`${codesOf(h)}`)
  }
})

check('E5. разпределение по вид (отчет; сумата = 4 960)', () => {
  const byKind = new Map<string, number>()
  for (const h of ALL_HANDS) {
    const kind = evaluateSvaraHand(h).kind
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1)
  }
  const total = [...byKind.values()].reduce((a, b) => a + b, 0)
  assert(total === 4960, `total ${total}`)
  assert(byKind.get('two-sevens') === 147 && byKind.get('three-sevens') === 4 && byKind.get('three-aces') === 10, 'kind counts')
  console.log(`      ${[...byKind.entries()].map(([k, n]) => `${k}=${n}`).join(', ')}`)
})

// ─── F. Сравняване ──────────────────────────────────────────────────────────
console.log('\n=== F. сравняване ===')

check('F1. по-високите точки печелят; 34 > 33 > 32 > 31', () => {
  const result = resolveSvaraShowdown([
    { playerId: 'p31', cards: hand('AS', 'KS', 'QS') },
    { playerId: 'p34', cards: hand('7S', '7H', '7D') },
    { playerId: 'p33', cards: hand('AC', 'AH', 'AD') },
  ])
  assert(result.winners.join() === 'p34' && !result.isTie && result.topPoints === 34, JSON.stringify(result.winners))
  assert(compareSvaraHands(hand('AC', 'AH', 'AD'), hand('7C', 'KS', 'QS')) === 1, '33 > 31 (чечак)')
  assert(compareSvaraHands(hand('7C', 'AS', 'KS'), hand('AH', 'KH', 'QH')) === 1, '32 > 31')
})

check('F1b. две седмици (23) бият две аса (22) и чечак + асо (22); 23 срещу 23 е равенство', () => {
  assert(compareSvaraHands(hand('7H', '7D', 'KS'), hand('AS', 'AD', 'QH')) === 1, '23 > 22')
  assert(compareSvaraHands(hand('7S', '7D', '9C'), hand('7C', 'AH', 'KD')) === 1, '23 > 22 (чечак + асо)')
  const tie = resolveSvaraShowdown([
    { playerId: 'plain', cards: hand('7S', '7D', 'KS') },
    { playerId: 'chechak', cards: hand('7C', '7H', 'QD') },
  ])
  assert(tie.isTie && tie.topPoints === 23 && tie.winners.join() === 'plain,chechak', JSON.stringify(tie.winners))
  assert(compareSvaraHands(hand('7C', '7H', '9H'), hand('7S', '7D', 'AD')) === 1, '27 > 23')
})

check('F2. равенство от двама: три попа (30) срещу K♠ Q♠ J♠ (30)', () => {
  const result = resolveSvaraShowdown([
    { playerId: 'kings', cards: hand('KH', 'KD', 'KC') },
    { playerId: 'suited', cards: hand('KS', 'QS', 'JS') },
  ])
  assert(result.isTie && result.winners.join() === 'kings,suited', JSON.stringify(result.winners))
})

check('F3. равенство от трима и четирима — връщат се всички, в реда на подаване', () => {
  const three = resolveSvaraShowdown([
    { playerId: 'a', cards: hand('7C', 'KH', 'KD') },
    { playerId: 'b', cards: hand('AS', 'KS', 'QS') },
    { playerId: 'c', cards: hand('AH', 'QH', 'JH') },
    { playerId: 'd', cards: hand('9D', '8D', '7D') },
  ])
  assert(three.winners.join() === 'a,b,c' && three.topPoints === 31, `${three.winners} ${three.topPoints}`)
  const four = resolveSvaraShowdown([
    { playerId: 'w', cards: hand('AS', 'KH', 'QD') },
    { playerId: 'x', cards: hand('AH', 'KD', 'QC') },
    { playerId: 'y', cards: hand('AD', 'KC', 'QS') },
    { playerId: 'z', cards: hand('AC', 'KS', 'QH') },
  ])
  assert(four.isTie && four.winners.join() === 'w,x,y,z' && four.topPoints === 11, `${four.winners}`)
})

check('F4. compareSvaraHands е антисиметрична и съвпада с точките (5 000 случайни двойки)', () => {
  const random = createSeededSvaraRandomSourceForTests(2026)
  for (let i = 0; i < 5000; i += 1) {
    const deck = createShuffledSvaraDeck(random)
    const a = deck.slice(0, 3)
    const b = deck.slice(3, 6)
    const ab = compareSvaraHands(a, b)
    const ba = compareSvaraHands(b, a)
    const diff = evaluateSvaraHand(a).points - evaluateSvaraHand(b).points
    if (ab !== -ba || ab !== Math.sign(diff)) throw new Error(`${codesOf(a)} vs ${codesOf(b)}`)
  }
})

check('F5. невалидно сравнение се отхвърля', () => {
  expectInvalid(() => resolveSvaraShowdown([{ playerId: 'a', cards: hand('AS', 'KS', 'QS') }]), '1 hand')
  expectInvalid(() => resolveSvaraShowdown([]), '0 hands')
  const five = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ playerId: id, cards: SVARA_ORDERED_DECK.slice(i * 3, i * 3 + 3) }))
  expectInvalid(() => resolveSvaraShowdown(five), '5 hands')
  expectInvalid(() => resolveSvaraShowdown([{ playerId: 'a', cards: hand('AS', 'KS', 'QS') }, { playerId: 'a', cards: hand('AH', 'KH', 'QH') }]), 'duplicate player')
  expectInvalid(() => resolveSvaraShowdown([{ playerId: 'a', cards: hand('AS', 'KS', 'QS') }, { playerId: 'b', cards: hand('AS', 'KH', 'QH') }]), 'card in two hands')
  expectInvalid(() => resolveSvaraShowdown([{ playerId: '', cards: hand('AS', 'KS', 'QS') }, { playerId: 'b', cards: hand('AH', 'KH', 'QH') }]), 'empty player id')
  expectInvalid(() => resolveSvaraShowdown([{ playerId: 'a', cards: hand('AS', 'KS') }, { playerId: 'b', cards: hand('AH', 'KH', 'QH') }]), 'short hand')
})

check('F6. повторяемост: еднакво семе → еднакво раздаване и еднакви победители', () => {
  const run = (seed: number) => {
    const deal = dealSvaraHands(['a', 'b', 'c', 'd'], createShuffledSvaraDeck(createSeededSvaraRandomSourceForTests(seed)))
    const result = resolveSvaraShowdown(deal.playerOrder.map((id) => ({ playerId: id, cards: deal.hands.get(id)! })))
    return JSON.stringify({ hands: deal.playerOrder.map((id) => codesOf(deal.hands.get(id)!)), winners: result.winners, top: result.topPoints })
  }
  for (const seed of [1, 42, 777, 20261015]) assert(run(seed) === run(seed), `seed ${seed}`)
})

// ─── G. Изглед за играч ─────────────────────────────────────────────────────
console.log('\n=== G. изглед за играч ===')

check('G1. играчът вижда само своите карти; за другите — само броя; тестето не излиза', () => {
  const deal = dealSvaraHands(['me', 'p2', 'p3'], createShuffledSvaraDeck())
  const view = createSvaraPlayerDealView(deal, 'me')
  const json = JSON.stringify(view)
  assert(JSON.stringify(view.ownCards) === JSON.stringify(codesOf(deal.hands.get('me')!)), 'own cards')
  assert(view.seats.every((s) => s.cardCount === 3) && view.seats.length === 3, 'seat counts')
  for (const id of ['p2', 'p3']) for (const code of codesOf(deal.hands.get(id)!)) assert(!json.includes(`"${code}"`), `leaked ${code} of ${id}`)
  for (const code of codesOf(deal.remainingDeck)) assert(!json.includes(`"${code}"`), `leaked deck card ${code}`)
  const spectator = createSvaraPlayerDealView(deal, 'spectator')
  assert(spectator.ownCards === null && !/"[0-9JQKA]+[CDHS]"/.test(JSON.stringify(spectator)), 'spectator sees no cards')
})

// ─── H. Изолация ────────────────────────────────────────────────────────────
console.log('\n=== H. изолация ===')

const here = dirname(fileURLToPath(import.meta.url))
const engineDir = join(here, '..', 'src', 'games', 'svara', 'engine')

check('H1. двигателят импортира само собствени модули и node:crypto (без HTTP/WS/DB/UI)', () => {
  for (const file of readdirSync(engineDir).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(join(engineDir, file), 'utf8')
    for (const match of source.matchAll(/from '([^']+)'/g)) {
      const spec = match[1]!
      assert(spec === 'node:crypto' || /^\.\/svara[A-Za-z]+\.js$/.test(spec), `${file} imports ${spec}`)
    }
  }
})

check('H2. клиентът не импортира двигателя; Белот/Ludo/Свара-достъп непроменени спрямо 6859a06', () => {
  const projectRoot = join(here, '..', '..')
  let clientRefs = ''
  try {
    clientRefs = execFileSync('git', ['grep', '-l', 'games/svara/engine', '--', 'src'], { cwd: projectRoot, encoding: 'utf8' }).trim()
  } catch (error) {
    // git grep връща код 1, когато няма съвпадения — това е очакваното.
    if ((error as { status?: number }).status !== 1) throw error
  }
  assert(clientRefs === '', `client imports engine: ${clientRefs}`)
  const changed = execFileSync('git', ['diff', '--name-only', '6859a06', '--', 'src/app/activeRoom', 'src/app/games/ludo', 'server/src/game', 'server/src/games/svara/svaraAccess.ts', 'server/src/games/svara/svaraFeatureFlag.ts', 'server/src/games/svara/handleSvaraHttpRequest.ts'], { cwd: projectRoot, encoding: 'utf8' }).trim()
  assert(changed === '', `changed: ${changed}`)
})

console.log(`\nPassed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
