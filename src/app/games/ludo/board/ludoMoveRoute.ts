// Изгражда стъпка-по-стъпка маршрут от клетка до клетка за mock движение.
// Engine-ът по-късно ще дава реалния route (или самите ние ще го извеждаме
// от target track index) — тук е достатъчно опростено обхождане, защото това
// е frontend simulation, не истинска валидация на ходове.

import { parseLudoCellId, ludoAdvanceTrackIndex, LUDO_TRACK_LENGTH } from './ludoBoardGeometry'
import type { LudoCellId } from '../ludoTypes'
import { ludoCellId } from '../ludoTypes'

// Връща поредица от клетки (без началната, включително крайната), по които
// пионката минава визуално. Home -> track: скача директно на target track
// клетката (излизане от базата няма междинни стъпки). Track -> track:
// изминава всяка клетка между тях по часовниковата стрелка.
export function buildLudoMoveRoute(fromCellId: LudoCellId, toCellId: LudoCellId): LudoCellId[] {
  const from = parseLudoCellId(fromCellId)
  const to = parseLudoCellId(toCellId)

  if (from.kind !== 'track' || to.kind !== 'track') {
    return [toCellId]
  }

  const route: LudoCellId[] = []
  let index = from.index
  // Защита срещу безкраен цикъл при невалиден mock route — трасето е
  // затворен пръстен от LUDO_TRACK_LENGTH клетки.
  for (let step = 0; step < LUDO_TRACK_LENGTH; step += 1) {
    index = ludoAdvanceTrackIndex(index, 1)
    route.push(ludoCellId({ kind: 'track', index }))
    if (index === to.index) break
  }
  return route
}
