// Изгражда стъпка-по-стъпка маршрут от клетка до клетка за pawn движение —
// Phase 3B (виж task-а т.12 "ROUTE GENERATION"): покрива и четирите
// canonical прехода (home->start, track->track, track->finish, finish->
// finish), никога не teleport-ва пионка над реални визуални стъпки.
//
// A. home -> track: единичен скок (излизане от базата няма междинни
//    стъпки — реферetна Ludo механика, пионката просто се появява на
//    собствения си start).
// B. track -> track: изминава всяка клетка между тях по часовниковата
//    стрелка (непроменено спрямо Phase 1/2, включително wrap 55->0).
// C. track -> finish: довършва оставащите shared-track клетки до
//    собствения "последен" track cell (stepsFromStart=55 спрямо
//    destination-ния цвят), после продължава във finish-0..finish-N.
// D. finish -> finish: изминава finish-(from+1)..finish-to последователно.

import { parseLudoCellId, ludoAdvanceTrackIndex, ludoStartTrackIndex, LUDO_TRACK_LENGTH } from './ludoBoardGeometry'
import type { LudoCellId, LudoColor } from '../ludoTypes'
import { ludoCellId } from '../ludoTypes'

function buildTrackToTrackRoute(fromIndex: number, toIndex: number): LudoCellId[] {
  const route: LudoCellId[] = []
  let index = fromIndex
  // Защита срещу безкраен цикъл при невалиден route — трасето е затворен
  // пръстен от LUDO_TRACK_LENGTH клетки.
  for (let step = 0; step < LUDO_TRACK_LENGTH; step += 1) {
    index = ludoAdvanceTrackIndex(index, 1)
    route.push(ludoCellId({ kind: 'track', index }))
    if (index === toIndex) break
  }
  return route
}

function buildTrackToFinishRoute(fromIndex: number, toFinishSlot: number, color: LudoColor): LudoCellId[] {
  const route: LudoCellId[] = []
  const startIndex = ludoStartTrackIndex(color)
  // Последната shared-track клетка преди собствения finish lane
  // (stepsFromStart=55 спрямо СЪЩИЯ start index) — mirror на
  // ludoEngineStepsFromStart(color, trackIndex)===LUDO_TRACK_LENGTH-1 в
  // engine/ludoEngineGeometry.ts, изразено тук directno чрез absolute index
  // аритметика (route builder-ът работи с cell id strings, не engine типове).
  const lastTrackIndex = (startIndex + LUDO_TRACK_LENGTH - 1) % LUDO_TRACK_LENGTH

  let index = fromIndex
  for (let step = 0; step < LUDO_TRACK_LENGTH; step += 1) {
    if (index === lastTrackIndex) break
    index = ludoAdvanceTrackIndex(index, 1)
    route.push(ludoCellId({ kind: 'track', index }))
  }

  for (let slot = 0; slot <= toFinishSlot; slot += 1) {
    route.push(ludoCellId({ kind: 'finish', color, slot }))
  }

  return route
}

function buildFinishToFinishRoute(fromSlot: number, toFinishSlot: number, color: LudoColor): LudoCellId[] {
  const route: LudoCellId[] = []
  for (let slot = fromSlot + 1; slot <= toFinishSlot; slot += 1) {
    route.push(ludoCellId({ kind: 'finish', color, slot }))
  }
  return route
}

// Връща поредица от клетки (без началната, включително крайната), по които
// пионката минава визуално.
export function buildLudoMoveRoute(fromCellId: LudoCellId, toCellId: LudoCellId): LudoCellId[] {
  const from = parseLudoCellId(fromCellId)
  const to = parseLudoCellId(toCellId)

  if (from.kind === 'track' && to.kind === 'track') {
    return buildTrackToTrackRoute(from.index, to.index)
  }

  if (from.kind === 'track' && to.kind === 'finish') {
    return buildTrackToFinishRoute(from.index, to.slot, to.color)
  }

  if (from.kind === 'finish' && to.kind === 'finish') {
    return buildFinishToFinishRoute(from.slot, to.slot, to.color)
  }

  // home -> track (излизане от базата) — единичен скок, няма междинни
  // визуални стъпки за никоя друга комбинация от kind-ове в тази игра.
  return [toCellId]
}
