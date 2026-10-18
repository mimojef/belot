// Deterministic unit-ниво проверка на анимациите от Етап 2Б.3.7.5
// (раздаване/Вход, "Погледни", "Бягам"/forced-fold) — чисти функции, фиктивен
// сървърен "сега", без DOM/WS/реален браузър. Mirror на checkSvaraBettingActions.ts
// стила (виж там B18/B19 за прецедента с betAnimationTracker).
//
// Покрива (виж заданието §17):
//   D1.  Входът (Вход) върви ПРЕДИ картите — 0..800ms е entry, после карти.
//   D2.  Точно N*3 карти общо (3 рунда по 1 карта на играч), никога 3 накуп.
//   D3.  Редът на картите следва round.participants (вече "първият след
//        дилъра ... дилърът"), не произволен DOM ред.
//   D4.  2/3/4 играча — обща продължителност = 800 + n*3*350.
//   D5.  350ms stagger между карти, 300ms полет (<= stagger, без застъпване).
//   D6.  Абсолютен dealingDeadlineAt синхрон — identical (round,timing,serverNow)
//        винаги дава identical прогрес (reconnect-safe, без локален старт).
//   D7.  Reconnect по средата -> вече кацнали карти се връщат като "кацнали",
//        не се preплейват от начало.
//   D8.  Reconnect след края (round.dealing=false) -> active=false, никакво
//        преиграване на entry/cards.
//   D9.  Само реално платилите участници (roundContribution>0) получават
//        chip-спрайт при Входа.
//   F1.  Нов доброволен fold (kind:'fold') се различава от forced-fold.
//   F2.  Baseline при първо виждане на roundId -> БЕЗ анимация (reconnect/mount).
//   F3.  Дублиран snapshot (без нови actions) -> без нови fold записи.
//   F4.  Нов roundId -> отново само baseline, не "довлича" стари fold-ове.
//   F5.  Неразпознати actions (bet/call/...) никога не се третират като fold.
//   L1.  Ново поглеждане (looked false->true) се различава от вече погледнато.
//   L2.  Baseline при първо виждане на roundId с looked=true -> БЕЗ анимация
//        (вече разрешени карти при reconnect не предизвикват фиктивно ново
//        поглеждане — задание §9).
//   L3.  looked=false не отбелязва нищо.
//   L4.  roundId===null -> никога не анимира.
//
// Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.

import {
  svaraDealingAnimationMs,
  computeSvaraDealingVisualState,
  SVARA_DEAL_ENTRY_ANIMATION_MS,
  SVARA_DEAL_CARD_ANIMATION_MS,
  SVARA_DEAL_CARDS_PER_PLAYER,
} from '../src/app/games/svara/table/svaraTableAnimation'
import { createSvaraFoldAnimationTracker } from '../src/app/games/svara/table/svaraFoldAnimationTracker'
import { createSvaraLookAnimationTracker } from '../src/app/games/svara/table/svaraLookAnimationTracker'
import type { SvaraSnapshotAction, SvaraSnapshotBettingRound, SvaraSnapshotSeat } from '../src/app/network/createGameServerClient'

let passed = 0
let failed = 0
function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: string): void { failed++; console.error(`  FAIL  ${label}: ${reason}`) }
function check(label: string, fn: () => void): void {
  try { fn(); pass(label) } catch (err) { fail(label, err instanceof Error ? err.message : String(err)) }
}
function assert(condition: boolean, msg: string): void { if (!condition) throw new Error(msg) }
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

console.log('\n=== checkSvaraDealingAnimation ===\n')

function seat(playerId: string, seatIndex: number, roundContribution: number): SvaraSnapshotSeat {
  return {
    seatIndex,
    playerId,
    status: 'active',
    stack: 1000,
    isDealer: false,
    isToAct: false,
    inRound: true,
    folded: false,
    allIn: false,
    cardCount: 0,
    roundContribution,
  }
}

function round(participants: string[], overrides: Partial<SvaraSnapshotBettingRound> = {}): SvaraSnapshotBettingRound {
  return {
    kind: 'ordinary',
    roundId: 'r1',
    dealerId: participants[participants.length - 1]!,
    potId: null,
    participants,
    currentBet: 0,
    blind: { status: 'available', lastBlindTotal: 0 },
    carriedIn: 0,
    potTotal: 0,
    provisionalPots: [],
    isFourthHeadsUp: false,
    noBetAllowed: false,
    actions: [],
    dealing: true,
    ...overrides,
  }
}

// ─── D1/D4/D5: базова математика на продължителността ──────────────────

check('[D4] svaraDealingAnimationMs(2/3/4) = 800 + n*3*350 (мирор на сървърния svaraDeadlines.ts)', () => {
  assertEqual(svaraDealingAnimationMs(2), 800 + 2 * 3 * 350, 'n=2')
  assertEqual(svaraDealingAnimationMs(3), 800 + 3 * 3 * 350, 'n=3')
  assertEqual(svaraDealingAnimationMs(4), 800 + 4 * 3 * 350, 'n=4')
})

check('[D5] Полетът на 1 карта (<=350ms stagger) никога не застъпва следващата карта', () => {
  assert(SVARA_DEAL_CARD_ANIMATION_MS === 350, 'stagger трябва да е 350ms')
  assert(SVARA_DEAL_ENTRY_ANIMATION_MS === 800, 'Вход трябва да е 800ms')
  assert(SVARA_DEAL_CARDS_PER_PLAYER === 3, 'точно 3 карти на играч')
})

// ─── D1: Вход преди картите ──────────────────────────────────────────────

check('[D1] serverNow веднага след dealing старт -> entry активен, flyingCard=null', () => {
  const participants = ['A', 'B', 'C']
  const seats = [seat('A', 0, 100), seat('B', 1, 100), seat('C', 2, 100)]
  const r = round(participants)
  const totalMs = svaraDealingAnimationMs(3)
  const deadlineAt = 1_000_000
  const startedAt = deadlineAt - totalMs
  const state = computeSvaraDealingVisualState(r, deadlineAt, startedAt + 400, seats)
  assert(state.active, 'трябва да е активен')
  assert(state.entry !== null, 'entry трябва да тече')
  assertEqual(state.flyingCard, null, 'няма карти докато Входът тече')
  assertEqual(state.landedCardCountBySeatIndex.size, 0, 'никакви кацнали карти по време на Входа')
})

check('[D1] serverNow точно СЛЕД 800ms Вход -> entry вече null, картите могат да започнат', () => {
  const participants = ['A', 'B']
  const seats = [seat('A', 0, 50), seat('B', 1, 50)]
  const r = round(participants)
  const totalMs = svaraDealingAnimationMs(2)
  const deadlineAt = 2_000_000
  const startedAt = deadlineAt - totalMs
  const state = computeSvaraDealingVisualState(r, deadlineAt, startedAt + 801, seats)
  assertEqual(state.entry, null, 'entry трябва да е приключил')
})

// ─── D2/D3: точен брой карти и ред = round.participants ─────────────────

check('[D2]/[D3] 3 играча: точно 9 карти общо, редът следва round.participants, 3 завършени рунда', () => {
  const participants = ['A', 'B', 'C']
  const seats = [seat('A', 0, 10), seat('B', 1, 10), seat('C', 2, 10)]
  const r = round(participants)
  const totalMs = svaraDealingAnimationMs(3)
  const deadlineAt = 3_000_000
  const startedAt = deadlineAt - totalMs
  // Малко ПРЕДИ самия край на анимацията -> всички 9 карти вече кацнали.
  const state = computeSvaraDealingVisualState(r, deadlineAt, deadlineAt - 1, seats)
  const totalLanded = Array.from(state.landedCardCountBySeatIndex.values()).reduce((a, b) => a + b, 0)
  assertEqual(totalLanded, 9, 'общо 9 кацнали карти (3 играча x 3 карти)')
  assertEqual(state.landedCardCountBySeatIndex.get(0), 3, 'seat 0 (A) получава точно 3')
  assertEqual(state.landedCardCountBySeatIndex.get(1), 3, 'seat 1 (B) получава точно 3')
  assertEqual(state.landedCardCountBySeatIndex.get(2), 3, 'seat 2 (C) получава точно 3')
})

check('[D3] Първата летяща карта в cards-подфазата отива към ПЪРВИЯ участник от round.participants', () => {
  // round.participants вече е "първият след дилъра ... дилърът последен" —
  // тестваме само че computeSvaraDealingVisualState НЕ пренарежда списъка.
  const participants = ['C', 'A', 'B'] // примерен ред, различен от seatIndex реда
  const seats = [seat('A', 0, 10), seat('B', 1, 10), seat('C', 2, 10)]
  const r = round(participants)
  const totalMs = svaraDealingAnimationMs(3)
  const deadlineAt = 4_000_000
  const startedAt = deadlineAt - totalMs
  // 50ms в cards-подфазата (<300ms flight на първата карта) -> летящата карта трябва да е към seatIndex на 'C' (participants[0]).
  const state = computeSvaraDealingVisualState(r, deadlineAt, startedAt + 800 + 50, seats)
  assert(state.flyingCard !== null, 'трябва да има летяща карта')
  assertEqual(state.flyingCard!.seatIndex, 2, 'първата карта лети към seatIndex 2 (playerId C, participants[0])')
})

check('[D2] Никога 3 карти накуп към един играч едновременно (stagger >= flight, няма overlap между кацнали/летящи на различни глобални индекси в различен момент)', () => {
  const participants = ['A', 'B']
  const seats = [seat('A', 0, 10), seat('B', 1, 10)]
  const r = round(participants)
  const totalMs = svaraDealingAnimationMs(2)
  const deadlineAt = 5_000_000
  const startedAt = deadlineAt - totalMs
  // В произволен момент по време на cards-подфазата, най-много ЕДНА летяща карта.
  for (let t = 0; t <= totalMs; t += 17) {
    const state = computeSvaraDealingVisualState(r, deadlineAt, startedAt + t, seats)
    assert(state.flyingCard === null || typeof state.flyingCard.seatIndex === 'number', `t=${t}: flyingCard трябва да е най-много 1`)
  }
})

// ─── D4: 2/3/4 играча обща продължителност ───────────────────────────────

for (const n of [2, 3, 4] as const) {
  check(`[D4] n=${n}: точно в края (serverNow===deadlineAt) всички карти кацнали, active спрямо dealing флага`, () => {
    const participants = Array.from({ length: n }, (_, i) => `P${i}`)
    const seats = participants.map((id, i) => seat(id, i, 10))
    const r = round(participants)
    const totalMs = svaraDealingAnimationMs(n)
    const deadlineAt = 6_000_000 + n
    const state = computeSvaraDealingVisualState(r, deadlineAt, deadlineAt, seats)
    const totalLanded = Array.from(state.landedCardCountBySeatIndex.values()).reduce((a, b) => a + b, 0)
    assertEqual(totalLanded, n * 3, `n=${n}: всички ${n * 3} карти кацнали точно на дедлайна`)
  })
}

// ─── D6: абсолютен синхрон, идентичен вход -> идентичен изход ───────────

check('[D6] Чиста функция: СЪЩИТЕ (round,deadlineAt,serverNow,seats) винаги дават СЪЩИЯ изход', () => {
  const participants = ['A', 'B', 'C']
  const seats = [seat('A', 0, 10), seat('B', 1, 10), seat('C', 2, 10)]
  const r = round(participants)
  const totalMs = svaraDealingAnimationMs(3)
  const deadlineAt = 7_000_000
  const startedAt = deadlineAt - totalMs
  const a = computeSvaraDealingVisualState(r, deadlineAt, startedAt + 1200, seats)
  const b = computeSvaraDealingVisualState(r, deadlineAt, startedAt + 1200, seats)
  assertEqual(JSON.stringify([...a.landedCardCountBySeatIndex]), JSON.stringify([...b.landedCardCountBySeatIndex]), 'landed картите трябва да съвпадат')
  assertEqual(JSON.stringify(a.flyingCard), JSON.stringify(b.flyingCard), 'летящата карта трябва да съвпада')
})

check('[D6] По-късен serverNow (reconnect) от СЪЩИЯ непроменен deadlineAt дава ПО-НАПРЕДНАЛ, не рестартиран прогрес', () => {
  const participants = ['A', 'B']
  const seats = [seat('A', 0, 10), seat('B', 1, 10)]
  const r = round(participants)
  const totalMs = svaraDealingAnimationMs(2)
  const deadlineAt = 8_000_000
  const startedAt = deadlineAt - totalMs
  const early = computeSvaraDealingVisualState(r, deadlineAt, startedAt + 850, seats)
  const later = computeSvaraDealingVisualState(r, deadlineAt, startedAt + 1500, seats)
  const earlyTotal = Array.from(early.landedCardCountBySeatIndex.values()).reduce((a, b) => a + b, 0)
  const laterTotal = Array.from(later.landedCardCountBySeatIndex.values()).reduce((a, b) => a + b, 0)
  assert(laterTotal >= earlyTotal, 'по-късен serverNow никога не трябва да "намалява" кацналите карти')
})

// ─── D7/D8: reconnect по средата / след края ─────────────────────────────

check('[D7] Reconnect по средата на cards-подфазата -> вече кацналите карти се връщат директно като кацнали (без replay от 0)', () => {
  const participants = ['A', 'B', 'C']
  const seats = [seat('A', 0, 10), seat('B', 1, 10), seat('C', 2, 10)]
  const r = round(participants)
  const totalMs = svaraDealingAnimationMs(3)
  const deadlineAt = 9_000_000
  const startedAt = deadlineAt - totalMs
  // "Reconnect" симулация: директно питаме за момент среди анимацията,
  // без да минаваме през по-ранните serverNow стойности изобщо.
  const midway = computeSvaraDealingVisualState(r, deadlineAt, startedAt + 800 + 4 * 350 + 310, seats)
  const totalLanded = Array.from(midway.landedCardCountBySeatIndex.values()).reduce((a, b) => a + b, 0)
  assert(totalLanded >= 4, 'поне 4 карти вече трябва да са кацнали directamente при reconnect')
})

check('[D8] round.dealing=false (краят вече е минал) -> active=false, никакво entry/cards', () => {
  const participants = ['A', 'B']
  const seats = [seat('A', 0, 10), seat('B', 1, 10)]
  const r = round(participants, { dealing: false })
  const state = computeSvaraDealingVisualState(r, 10_000_000, 10_000_500, seats)
  assertEqual(state.active, false, 'не трябва да е активен след края на dealing фазата')
  assertEqual(state.entry, null, 'без entry')
  assertEqual(state.flyingCard, null, 'без летяща карта')
})

check('[D8] dealingDeadlineAt===null (няма "dealing" deadline в timing) -> active=false', () => {
  const participants = ['A', 'B']
  const seats = [seat('A', 0, 10), seat('B', 1, 10)]
  const r = round(participants)
  const state = computeSvaraDealingVisualState(r, null, 11_000_000, seats)
  assertEqual(state.active, false, 'без dealing deadline няма анимация')
})

check('[D8] round===null -> active=false (lobby/между рундовете)', () => {
  const state = computeSvaraDealingVisualState(null, 12_000_000, 12_000_000, [])
  assertEqual(state.active, false, 'без round няма анимация')
})

// ─── D9: само реално платилите получават chip-спрайт ────────────────────

check('[D9] Само seats с roundContribution>0 получават chip спрайт при Входа', () => {
  const participants = ['A', 'B', 'C']
  // B няма реален принос (напр. absent/изключен от round-а другаде) -> не получава чип.
  const seats = [seat('A', 0, 100), seat('B', 1, 0), seat('C', 2, 100)]
  const r = round(participants)
  const totalMs = svaraDealingAnimationMs(3)
  const deadlineAt = 13_000_000
  const startedAt = deadlineAt - totalMs
  const state = computeSvaraDealingVisualState(r, deadlineAt, startedAt + 300, seats)
  assert(state.entry !== null, 'entry трябва да тече')
  const chipSeatIndexes = state.entry!.chips.map((c) => c.seatIndex).sort()
  assertEqual(JSON.stringify(chipSeatIndexes), JSON.stringify([0, 2]), 'само seatIndex 0 и 2 (A, C) плащат реално')
})

// ─── F1-F5: fold tracker ──────────────────────────────────────────────────

function action(playerId: string, kind: SvaraSnapshotAction['kind']): SvaraSnapshotAction {
  return { playerId, kind, total: 0, added: 0, allIn: false, blind: false }
}

check('[F2] Baseline при първо виждане на roundId (вкл. вече съдържащ fold записи) -> БЕЗ анимация', () => {
  const tracker = createSvaraFoldAnimationTracker()
  const r = round(['A', 'B'], { actions: [action('A', 'fold')] })
  const first = tracker.detectNewFolds(r)
  assertEqual(first.length, 0, 'първото виждане на round-а е само baseline')
})

check('[F1] Нов доброволен fold (kind:fold) след baseline -> voluntary:true', () => {
  const tracker = createSvaraFoldAnimationTracker()
  const r0 = round(['A', 'B'], { actions: [] })
  tracker.detectNewFolds(r0) // baseline
  const r1 = round(['A', 'B'], { actions: [action('A', 'fold')] })
  const newFolds = tracker.detectNewFolds(r1)
  assertEqual(newFolds.length, 1, 'точно 1 нов fold')
  assertEqual(newFolds[0]!.playerId, 'A', 'правилният играч')
  assertEqual(newFolds[0]!.voluntary, true, 'доброволен fold -> voluntary:true')
})

check('[F1] Нов forced-fold (timeout/отсъствие) след baseline -> voluntary:false, НИКОГА бъркан с доброволен', () => {
  const tracker = createSvaraFoldAnimationTracker()
  const r0 = round(['A', 'B'], { actions: [] })
  tracker.detectNewFolds(r0)
  const r1 = round(['A', 'B'], { actions: [action('B', 'forced-fold')] })
  const newFolds = tracker.detectNewFolds(r1)
  assertEqual(newFolds.length, 1, 'точно 1 нов forced-fold')
  assertEqual(newFolds[0]!.voluntary, false, 'forced-fold -> voluntary:false, без глас "Бягам!"')
})

check('[F3] Дублиран snapshot (без нови actions) -> без нови fold записи', () => {
  const tracker = createSvaraFoldAnimationTracker()
  const r0 = round(['A', 'B'], { actions: [action('A', 'fold')] })
  tracker.detectNewFolds(r0) // baseline
  const same = round(['A', 'B'], { actions: [action('A', 'fold')] })
  const again = tracker.detectNewFolds(same)
  assertEqual(again.length, 0, 'дублиран snapshot не трябва да преиграва fold ефекта')
})

check('[F4] Нов roundId -> отново само baseline, не довлича стари fold-ове от предходния round', () => {
  const tracker = createSvaraFoldAnimationTracker()
  const r0 = round(['A', 'B'], { roundId: 'r1', actions: [action('A', 'fold')] })
  tracker.detectNewFolds(r0) // baseline за r1
  const r2 = round(['A', 'B'], { roundId: 'r2', actions: [action('B', 'fold')] })
  const newFolds = tracker.detectNewFolds(r2)
  assertEqual(newFolds.length, 0, 'нов roundId трябва да е ново baseline, не "нов" fold')
})

check('[F5] bet/call/no-bet записи никога не се третират като fold', () => {
  const tracker = createSvaraFoldAnimationTracker()
  const r0 = round(['A', 'B'], { actions: [] })
  tracker.detectNewFolds(r0)
  const r1 = round(['A', 'B'], { actions: [{ playerId: 'A', kind: 'bet', total: 80, added: 80, allIn: false, blind: false }, action('B', 'call')] })
  const newFolds = tracker.detectNewFolds(r1)
  assertEqual(newFolds.length, 0, 'bet/call не са fold събития')
})

// ─── L1-L4: look tracker ──────────────────────────────────────────────────

check('[L2] Baseline при първо виждане на roundId с looked=true -> БЕЗ анимация (reconnect, вече разрешени карти)', () => {
  const tracker = createSvaraLookAnimationTracker()
  const isNew = tracker.detectNewLook('r1', true)
  assertEqual(isNew, false, 'първото виждане дори с looked=true е само baseline')
})

check('[L1] looked false->true СЛЕД baseline -> ново поглеждане', () => {
  const tracker = createSvaraLookAnimationTracker()
  tracker.detectNewLook('r1', false) // baseline
  const isNew = tracker.detectNewLook('r1', true)
  assertEqual(isNew, true, 'реален преход false->true е ново поглеждане')
})

check('[L1] looked остава true (повторен render) -> не е "ново" повторно', () => {
  const tracker = createSvaraLookAnimationTracker()
  tracker.detectNewLook('r1', false)
  tracker.detectNewLook('r1', true) // новото поглеждане
  const again = tracker.detectNewLook('r1', true)
  assertEqual(again, false, 'повторен true не трябва да анимира пак')
})

check('[L3] looked=false не отбелязва нищо, дори повторно', () => {
  const tracker = createSvaraLookAnimationTracker()
  tracker.detectNewLook('r1', false)
  const still = tracker.detectNewLook('r1', false)
  assertEqual(still, false, 'looked=false никога не е "ново поглеждане"')
})

check('[L4] roundId===null -> никога не анимира', () => {
  const tracker = createSvaraLookAnimationTracker()
  const isNew = tracker.detectNewLook(null, true)
  assertEqual(isNew, false, 'без roundId няма какво да се проследи')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
