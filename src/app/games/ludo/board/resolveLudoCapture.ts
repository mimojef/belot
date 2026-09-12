// Изчислява/прилага "кой бива уловен и къде отива" при capture ход —
// извадено като чист, тестваем модул по СЪЩИЯ модел като
// computeLudoLegalMoves.ts (чист вход/изход, никакъв DOM/animation код
// тук). createLudoFlowController.ts::animateCapture се грижи само за
// визуалния impact момент; РЕАЛНАТА state мутация живее тук, за да може
// да се тества директно (виж task-а — deterministic checks за stack
// capture).

import type { LudoCellId, LudoColor, LudoPiece } from '../ludoTypes'

// Извлича постоянния home slot номер на пионката от нейния собствен id
// (LudoPieceId = `${color}-${0|1|2|3}`) — виж коментара при
// applyLudoCaptureToHome по-долу за пълния audit защо това е ЕДИНСТВЕНИЯТ
// коректен модел (ID-то вече еднозначно определя slot-а, гарантирано без
// collision, за разлика от "count на вече заети slots").
function ludoPieceHomeSlotFromId(pieceId: LudoPiece['id']): number {
  const lastDash = pieceId.lastIndexOf('-')
  return Number(pieceId.slice(lastDash + 1))
}

// Всички пионки на target клетката, които НЕ са от цвета на пристигащата
// пионка — не само първата намерена (виж task-а: stack от 2-4 противникови
// пионки на target-а → всички биват уловени, не само representative-а).
// Собствените пионки на moving color НЕ се връщат тук — те просто остават
// на target-а и образуват/растат stack с пристигащата пионка.
export function findLudoCaptureVictims(
  pieces: LudoPiece[],
  targetCellId: LudoCellId,
  capturingColor: LudoColor,
): LudoPiece[] {
  return pieces.filter((piece) => piece.cell === targetCellId && piece.color !== capturingColor)
}

// Връща всяка victim пионка на нейното ПРАВИЛНО home място.
//
// AUDIT (виж task-а): предишният вариант смяташе home slot-а като "count
// на вече прибрани пионки от този цвят = следващия slot" — грешен модел.
// LudoPieceId = `${color}-${0|1|2|3}` вече еднозначно определя постоянния
// home slot на всяка пионка (потвърдено и от createLudoMockPieces.ts:
// red-0 винаги е home-red-0, red-3 винаги е home-red-3 — id suffix-ът И
// slot номерът СЪВПАДАТ по конвенция от самото начало). "Count"-моделът
// чупеше този invariant при sparse home occupancy — а тя НЕ е рядък edge
// case, а РЕАЛНОТО начално състояние на mock-а (red: slot 0 и 3 заети,
// slot 1 и 2 свободни). Доказан конкретен collision: capture на red-1,
// после red-2, последователно от този начален state — count-моделът
// изпращаше и двете на 'home-red-2' после 'home-red-3' (вече зает от
// red-3), реален overlap. Model B ("първия свободен slot") би избегнал
// collision-а, но не е нужен — ID-то вече дава коректния slot директно,
// без search.
//
// Затова: всяка victim се връща ТОЧНО на slot-а, кодиран в собствения ѝ
// id — детерминистично, без възможност за collision (всеки цвят има точно
// 4 уникални id-та, значи точно 4 уникални slot-а). Мутира victim.cell НА
// МЯСТО (същите LudoPiece обекти от входния pieces масив, не копия) —
// controller-ът разчита точно на тази reference mutation.
export function applyLudoCaptureToHome(victims: LudoPiece[]): void {
  for (const victim of victims) {
    const slot = ludoPieceHomeSlotFromId(victim.id)
    victim.cell = `home-${victim.color}-${slot}`
  }
}
