// Deterministic unit-ниво проверка на визуалния layout/countdown на
// реалната Свара маса (Етап 2Б.3.7.3) — чисти функции, без DOM/WS/сървър.
// Mirror на checkSvaraClientLobby.ts стила.
//
// Покрива (виж заданието §17):
//   L1-L3. Правилни позиции за 2/3/4 играчи, с точните слотове от §4
//          (3 играчи: НЯМА ляво място; 4 играчи: и четирите).
//   L4.    Последователност по действителния сървърен seatIndex (не по
//          име/ред на присъединяване).
//   L5.    Всеки клиент вижда себе си долу — за ВСЕКИ локален играч
//          поотделно, не само за seat 0.
//   L6.    Детерминизъм/стабилност: същият вход винаги дава същия изход
//          (reconnect/rerender не разбърква местата случайно).
//   T7-T9. Пръстен: computeSvaraRingState — fraction/remaining коректни,
//          последните 5s (или целия срок, ако е по-кратък) = danger.
//   T9.    Deadline НЕ се "рестартира" при повторно извикване със същия
//          serverNow — чиста функция на входа, без скрито локално състояние.
//
// Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.

import { assignSvaraVisualSlots, getSvaraVisualSlot } from '../src/app/games/svara/table/svaraSeatLayout'
import { computeSvaraRingState, svaraRingDashOffset, SVARA_DEADLINE_TOTAL_MS } from '../src/app/games/svara/table/svaraCountdown'

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

console.log('\n=== checkSvaraTableLayout ===\n')

type MiniSeat = { seatIndex: number }

// ─── L1: 2 играчи ───────────────────────────────────────────────────────

check('[L1] 2 играчи, локален seat 0: себе си долу, другият горе, няма ляво/дясно', () => {
  const seats: MiniSeat[] = [{ seatIndex: 0 }, { seatIndex: 1 }]
  const result = assignSvaraVisualSlots(seats, 0, 2)
  assertEqual(result.find((r) => r.seat.seatIndex === 0)!.slot, 'bottom', 'seat 0 (себе си) трябва да е долу')
  assertEqual(result.find((r) => r.seat.seatIndex === 1)!.slot, 'top', 'seat 1 трябва да е горе')
})

check('[L1] 2 играчи, локален seat 1: себе си пак долу (релативно), другият горе', () => {
  const seats: MiniSeat[] = [{ seatIndex: 0 }, { seatIndex: 1 }]
  const result = assignSvaraVisualSlots(seats, 1, 2)
  assertEqual(result.find((r) => r.seat.seatIndex === 1)!.slot, 'bottom', 'локалният играч (seat 1) трябва да е долу')
  assertEqual(result.find((r) => r.seat.seatIndex === 0)!.slot, 'top', 'seat 0 трябва да е горе за ТОЗИ играч')
})

// ─── L2: 3 играчи — задължително НЯМА ляво място (виж заданието §4) ────

check('[L2] 3 играчи: себе си долу, следващият вдясно, третият горе — НИКОГА ляво', () => {
  const seats: MiniSeat[] = [{ seatIndex: 0 }, { seatIndex: 1 }, { seatIndex: 2 }]
  for (const localSeatIndex of [0, 1, 2]) {
    const result = assignSvaraVisualSlots(seats, localSeatIndex, 3)
    const slots = result.map((r) => r.slot).sort()
    assert(!slots.includes('left'), `localSeatIndex=${localSeatIndex}: 3-играчова маса не трябва да използва 'left' изобщо`)
    assertEqual(slots.join(','), 'bottom,right,top', `localSeatIndex=${localSeatIndex}: трябва да използва точно bottom+right+top`)
    assertEqual(result.find((r) => r.seat.seatIndex === localSeatIndex)!.slot, 'bottom', `localSeatIndex=${localSeatIndex}: локалният играч трябва да е долу`)
  }
})

// ─── L3: 4 играчи — всичките 4 слота ───────────────────────────────────

check('[L3] 4 играчи: всички слотове (bottom/right/top/left) заети, себе си винаги долу', () => {
  const seats: MiniSeat[] = [{ seatIndex: 0 }, { seatIndex: 1 }, { seatIndex: 2 }, { seatIndex: 3 }]
  for (const localSeatIndex of [0, 1, 2, 3]) {
    const result = assignSvaraVisualSlots(seats, localSeatIndex, 4)
    const slots = result.map((r) => r.slot).sort()
    assertEqual(slots.join(','), 'bottom,left,right,top', `localSeatIndex=${localSeatIndex}: и четирите слота трябва да са заети`)
    assertEqual(result.find((r) => r.seat.seatIndex === localSeatIndex)!.slot, 'bottom', `localSeatIndex=${localSeatIndex}: локалният играч трябва да е долу`)
    // Няма два играча на един и същи слот.
    assertEqual(new Set(result.map((r) => r.slot)).size, 4, `localSeatIndex=${localSeatIndex}: всеки слот — точно един играч`)
  }
})

// ─── L4: по действителния seatIndex, не по реда в масива ───────────────

check('[L4] Подрежда по действителния server seatIndex, не по реда на елементите във входния масив', () => {
  // Умишлено размесен входен ред (seatIndex 2, 0, 3, 1) — резултатът не
  // трябва да зависи от това в какъв ред сървърът е изредил местата.
  const seatsShuffled: MiniSeat[] = [{ seatIndex: 2 }, { seatIndex: 0 }, { seatIndex: 3 }, { seatIndex: 1 }]
  const seatsOrdered: MiniSeat[] = [{ seatIndex: 0 }, { seatIndex: 1 }, { seatIndex: 2 }, { seatIndex: 3 }]
  const a = assignSvaraVisualSlots(seatsShuffled, 0, 4).map((r) => ({ seatIndex: r.seat.seatIndex, slot: r.slot })).sort((x, y) => x.seatIndex - y.seatIndex)
  const b = assignSvaraVisualSlots(seatsOrdered, 0, 4).map((r) => ({ seatIndex: r.seat.seatIndex, slot: r.slot })).sort((x, y) => x.seatIndex - y.seatIndex)
  assertEqual(JSON.stringify(a), JSON.stringify(b), 'резултатът трябва да е еднакъв независимо от входния ред на елементите')
})

check('[L4] Турн-редът се запазва визуално по часовниковата стрелка (bottom->right->top->left цикъл)', () => {
  // 4 играчи, localSeatIndex=0: следващият по ред (seatIndex 1, "следва" на
  // ход непосредствено след мен) трябва да застане ВДЯСНО — съгласувано с
  // установения Белот SEAT_ORDER конвенция (bottom,right,top,left).
  const seats: MiniSeat[] = [{ seatIndex: 0 }, { seatIndex: 1 }, { seatIndex: 2 }, { seatIndex: 3 }]
  const result = assignSvaraVisualSlots(seats, 0, 4)
  assertEqual(result.find((r) => r.seat.seatIndex === 1)!.slot, 'right', 'следващият играч по ред трябва да е вдясно')
  assertEqual(result.find((r) => r.seat.seatIndex === 2)!.slot, 'top', 'играчът "срещу" мен трябва да е горе')
  assertEqual(result.find((r) => r.seat.seatIndex === 3)!.slot, 'left', 'предишният играч (следващ след мен в кръга) трябва да е вляво')
})

// ─── L5: себе си винаги долу, за произволен localSeatIndex/capacity ────

check('[L5] За произволна комбинация capacity+localSeatIndex, локалният играч Е ВИНАГИ долу', () => {
  for (const capacity of [2, 3, 4] as const) {
    for (let localSeatIndex = 0; localSeatIndex < capacity; localSeatIndex += 1) {
      const slot = getSvaraVisualSlot(localSeatIndex, localSeatIndex, capacity)
      assertEqual(slot, 'bottom', `capacity=${capacity}, localSeatIndex=${localSeatIndex}`)
    }
  }
})

// ─── L6: детерминизъм — reconnect/rerender не разбърква местата ───────

check('[L6] Многократни извиквания със СЪЩИЯ вход винаги дават СЪЩИЯ изход (без скрито случайно състояние)', () => {
  const seats: MiniSeat[] = [{ seatIndex: 0 }, { seatIndex: 1 }, { seatIndex: 2 }]
  const first = JSON.stringify(assignSvaraVisualSlots(seats, 1, 3))
  for (let i = 0; i < 20; i += 1) {
    assertEqual(JSON.stringify(assignSvaraVisualSlots(seats, 1, 3)), first, `извикване #${i}`)
  }
})

// ─── T7-T9: countdown пръстен ───────────────────────────────────────────

check('[T7] computeSvaraRingState: пълен пръстен в самото начало на срока', () => {
  const state = computeSvaraRingState(/* deadlineAt */ 20000, /* totalMs */ 15000, /* serverNow */ 5000)
  assertEqual(state.fraction, 1, 'fraction трябва да е 1.0 (пълен) точно в началото')
  assertEqual(state.remainingMs, 15000, 'remainingMs трябва да = totalMs в началото')
  assertEqual(state.isDanger, false, 'не трябва да е danger в началото на 15s срок')
})

check('[T7] computeSvaraRingState: наполовина изтекъл срок -> fraction 0.5', () => {
  const state = computeSvaraRingState(20000, 15000, 20000 - 7500)
  assert(Math.abs(state.fraction - 0.5) < 0.001, `fraction трябва да е ~0.5, got ${state.fraction}`)
})

check('[T7] computeSvaraRingState: изтекъл срок -> fraction 0, remainingMs 0, НЕ отрицателно', () => {
  const state = computeSvaraRingState(10000, 15000, 25000)
  assertEqual(state.fraction, 0, 'fraction не трябва да е отрицателен след изтичане')
  assertEqual(state.remainingMs, 0, 'remainingMs не трябва да е отрицателен')
})

check('[T8] Последните 5 секунди (или по-малко) от 15s ход са "danger"', () => {
  const notYetDanger = computeSvaraRingState(20000, 15000, 20000 - 5001)
  const justDanger = computeSvaraRingState(20000, 15000, 20000 - 5000)
  const deepDanger = computeSvaraRingState(20000, 15000, 20000 - 1000)
  assertEqual(notYetDanger.isDanger, false, '5001ms remaining все още не трябва да е danger')
  assertEqual(justDanger.isDanger, true, 'точно 5000ms remaining трябва да е danger')
  assertEqual(deepDanger.isDanger, true, '1000ms remaining трябва да е danger')
})

check('[T8] Срок по-кратък от 5s (напр. 3s публичен показ) е danger през ЦЯЛАТА си продължителност', () => {
  const state = computeSvaraRingState(10000, SVARA_DEADLINE_TOTAL_MS['reveal-display'], 10000 - 2999)
  assertEqual(state.isDanger, true, '3-секунден срок трябва да е danger от самото начало')
})

check('[T9] Чиста функция — ПОВТОРНО извикване със СЪЩИЯ (deadlineAt,totalMs,serverNow) никога не "напредва" само защото е извикана пак (без скрит таймер)', () => {
  const a = computeSvaraRingState(20000, 15000, 12000)
  const b = computeSvaraRingState(20000, 15000, 12000)
  const c = computeSvaraRingState(20000, 15000, 12000)
  assertEqual(JSON.stringify(a), JSON.stringify(b), 'два последователни извиквания със същия serverNow трябва да дадат ИДЕНТИЧЕН резултат')
  assertEqual(JSON.stringify(b), JSON.stringify(c), 'трети извикване — пак идентично (доказва липса на локален мутируем "старт" timestamp)')
})

check('[T9] Reconnect симулация: нов serverNow (по-късен) от СЪЩИЯ непроменен deadlineAt дава ПО-МАЛКО remaining, не рестартирано пълно', () => {
  const beforeDisconnect = computeSvaraRingState(20000, 15000, 10000)
  const afterReconnect = computeSvaraRingState(20000, 15000, 16000) // 6s по-късно, СЪЩИЯТ deadlineAt
  assert(afterReconnect.remainingMs < beforeDisconnect.remainingMs, 'след reconnect remaining трябва да продължи да намалява от authoritative deadline-а, не да се рестартира')
  assertEqual(afterReconnect.remainingMs, 4000, 'remaining трябва да отразява точно изминалото реално време спрямо deadline-а')
})

check('[T7] svaraRingDashOffset: 0 offset при пълен пръстен (fraction=1), пълна обиколка при изтекъл (fraction=0)', () => {
  const circumference = 113.097
  assert(Math.abs(svaraRingDashOffset(1, circumference)) < 0.001, 'fraction=1 -> offset трябва да е ~0')
  assert(Math.abs(svaraRingDashOffset(0, circumference) - circumference) < 0.001, 'fraction=0 -> offset трябва да е пълната обиколка')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exitCode = 1
}
