// Свара — детерминистично визуално разположение на местата (Етап 2Б.3.7.3).
// Чиста функция, без DOM — решението на собственика фиксира точните слотове
// за 2/3/4 играчи (виж заданието §4): собственият профил е ВИНАГИ долу;
// останалите места се подреждат по posoka на реда на ходовете (следващият
// seatIndex по часовниковата стрелка спрямо локалния играч), по същия
// bottom->right->top->left цикъл, установен за Белот в cuttingSeatLayout.ts
// (SEAT_ORDER), съкратен според капацитета на масата.

export type SvaraVisualSlot = 'bottom' | 'right' | 'top' | 'left'

/** Визуален ред по часовниковата стрелка, започвайки от собственото място. */
const SLOT_CYCLE: readonly SvaraVisualSlot[] = ['bottom', 'right', 'top', 'left']

/** Точните слотове за всеки капацитет, по заданието §4 — за 3 играчи НЯМА ляво място. */
const SLOTS_BY_CAPACITY: Record<2 | 3 | 4, readonly SvaraVisualSlot[]> = {
  2: ['bottom', 'top'],
  3: ['bottom', 'right', 'top'],
  4: ['bottom', 'right', 'top', 'left'],
}

/**
 * Визуалният слот за дадено място, спрямо локалния играч — детерминистично
 * за всеки играч поотделно (всеки вижда себе си долу), без значение от реда
 * на свързване/reload. `localSeatIndex === null` (напр. зрител без собствено
 * място — не се очаква в този подетап, но пазим безопасно поведение):
 * връща слотовете в суровия сървърен ред, seat 0 долу.
 */
export function getSvaraVisualSlot(
  seatIndex: number,
  localSeatIndex: number | null,
  capacity: 2 | 3 | 4,
): SvaraVisualSlot {
  const offset = ((seatIndex - (localSeatIndex ?? 0)) % capacity + capacity) % capacity
  const slots = SLOTS_BY_CAPACITY[capacity]
  return slots[offset] ?? SLOT_CYCLE[offset % SLOT_CYCLE.length]!
}

export type SvaraSeatWithSlot<TSeat> = { seat: TSeat; slot: SvaraVisualSlot }

/**
 * Подрежда произволен масив от места (с `seatIndex`) по визуалните им
 * слотове спрямо локалния играч. Не сортира по име/време на свързване —
 * само по действителния сървърен seatIndex (виж заданието §4).
 */
export function assignSvaraVisualSlots<TSeat extends { seatIndex: number }>(
  seats: readonly TSeat[],
  localSeatIndex: number | null,
  capacity: 2 | 3 | 4,
): SvaraSeatWithSlot<TSeat>[] {
  return seats.map((seat) => ({ seat, slot: getSvaraVisualSlot(seat.seatIndex, localSeatIndex, capacity) }))
}
