// Pure legal-move изчисление за engine-а — Phase 3B "REAL MOVEMENT RULES"
// (виж task-а). Заменя Phase 1's минимална track-only версия: сега покрива
// home exit (само при dice===6), пълния 56-cell shared track (canonical
// progress спрямо СОБСТВЕНИЯ start на пионката, виж ludoEngineStepsFromStart
// в ludoEngineGeometry.ts), вход и движение във finish lane, exact finish,
// overshoot-като-illegal, и safe/star cells (landing на safe track index
// никога не е capture — виж isCapture изчислението по-долу).
//
// Canonical progress модел (task-а т.2): всяка track пионка държи absolute
// trackIndex (0-55), но legal-move математиката винаги минава първо през
// stepsFromStart = ludoEngineStepsFromStart(color, trackIndex) — числото,
// което ЕДНОЗНАЧНО отговаря "колко напреднала е тази пионка спрямо
// собствения си старт", независимо от wrap-а на absolute index-а. "Абсолютни
// стъпки" по-долу означава: 0..55 = все още на shared track-а (56 клетки
// общо), 56..61 = вече във finish lane-а (finishIndex = totalSteps - 56,
// 0..5), >61 = overshoot (illegal, пионката просто няма move за този dice).

import { ludoEngineAdvanceTrackIndex, ludoEngineStepsFromStart, ludoEngineIsSafeTrackIndex, ludoEngineIsOwnStartTrackIndex, LUDO_ENGINE_START_INDEX, LUDO_ENGINE_TRACK_LENGTH, LUDO_ENGINE_FINISH_LENGTH } from './ludoEngineGeometry.js'
import type { LudoColor, LudoDiceValue, LudoGamePiece, LudoLegalMove, LudoPiecePosition } from './ludoEngineTypes.js'

// Опитва да изчисли target позицията за ЕДНА пионка на track-а — null ако
// dice-ът overshoot-ва (нито валидна track, нито валидна finish клетка).
function computeTrackMoveTarget(color: LudoColor, trackIndex: number, diceValue: LudoDiceValue): LudoPiecePosition | null {
  const stepsFromStart = ludoEngineStepsFromStart(color, trackIndex)
  const totalSteps = stepsFromStart + diceValue

  if (totalSteps <= LUDO_ENGINE_TRACK_LENGTH - 1) {
    // Все още на shared track-а — нов absolute index, derive-нат от
    // СОБСТВЕНИЯ start на цвета (никога directно "trackIndex + dice", за да
    // остане wrap-ът винаги коректен спрямо canonical progress-а, не спрямо
    // суровия absolute номер).
    return { kind: 'track', trackIndex: ludoEngineAdvanceTrackIndex(LUDO_ENGINE_START_INDEX[color], totalSteps) }
  }

  const finishIndex = totalSteps - LUDO_ENGINE_TRACK_LENGTH
  if (finishIndex <= LUDO_ENGINE_FINISH_LENGTH - 1) {
    return { kind: 'finish', finishIndex }
  }

  // Overshoot — нито target track клетка (вече отвъд пълната обиколка),
  // нито валиден finish index (отвъд finish-5). Не clamp-ваме, не местим
  // "доколкото може" — просто НЯМА legal move за тази пионка с този dice.
  return null
}

// Опитва target за пионка ВЕЧЕ във finish lane-а — само напред, само до
// finishIndex 5 (exact finish). Overshoot (finishIndex+dice > 5) -> null.
function computeFinishMoveTarget(finishIndex: number, diceValue: LudoDiceValue): LudoPiecePosition | null {
  const nextFinishIndex = finishIndex + diceValue
  if (nextFinishIndex > LUDO_ENGINE_FINISH_LENGTH - 1) return null
  return { kind: 'finish', finishIndex: nextFinishIndex }
}

export function computeLudoEngineLegalMoves(
  pieces: readonly LudoGamePiece[],
  activeColor: LudoColor,
  diceValue: LudoDiceValue,
): LudoLegalMove[] {
  const moves: LudoLegalMove[] = []

  for (const piece of pieces) {
    if (piece.color !== activeColor) continue

    let targetPosition: LudoPiecePosition | null = null

    if (piece.position.kind === 'home') {
      // Home exit — САМО при dice===6 (task-а т.3). Не forced: ако друга
      // legal-move пионка съществува, човекът избира свободно кое да мести
      // измежду всички legal moves (тук просто добавяме home-exit-a като
      // ОЩЕ една опция в масива, не единствена/приоритетна).
      if (diceValue === 6) {
        targetPosition = { kind: 'track', trackIndex: LUDO_ENGINE_START_INDEX[piece.color] }
      }
    } else if (piece.position.kind === 'track') {
      targetPosition = computeTrackMoveTarget(piece.color, piece.position.trackIndex, diceValue)
    } else {
      // piece.position.kind === 'finish' — private lane, движение само напред.
      targetPosition = computeFinishMoveTarget(piece.position.finishIndex, diceValue)
    }

    if (targetPosition === null) continue

    // Capture е възможен САМО при landing точно на SHARED TRACK клетка —
    // finish lane-ът е private (task-а т.6/т.8), там isCapture винаги false.
    // (Извеждаме trackIndex-а в отделна const ПРЕДИ closure-а по-долу — `let
    // targetPosition` narrowing не се пази вътре в pieces.some() callback-а.)
    //
    // Safe/star клетка (LUDO_ENGINE_SAFE_TRACK_INDICES, виж
    // ludoEngineGeometry.ts) НИКОГА не е capture target — engine-level
    // rule, не само presentation (виж fix: opponent piece on a star cell was
    // incorrectly captured). Движението остава legal (пионките coexist-ват
    // на клетката, engine-ът вече поддържа мулти-цветен track occupancy
    // навсякъде другаде — виж findLudoEngineCaptureVictims/
    // applyLudoEngineCaptureToHome), просто isCapture е винаги false тук,
    // значи handleMoveRequested никога не извиква capture resolution за
    // target на safe индекс — нито victim се връща в home, нито
    // pieces_captured event се emit-ва (→ нито capture animation, нито
    // extra roll от capture).
    //
    // OWNERSHIP-AWARE own-start protection (ново правило) — за разлика от
    // safe/star клетката по-горе (глобално safe за всички), собственото
    // exit/start поле на даден цвят е safe САМО за пионки ОТ ТОЗИ цвят.
    // Затова тук не проверяваме само target index-a — за всеки potential
    // victim проверяваме ludoEngineIsOwnStartTrackIndex(other.color,
    // captureTargetTrackIndex): ако target-ът Е собственият start на victim-a,
    // тази конкретна victim е protected (coexist, не се capture-ва), дори
    // ако target-ът НЕ е собственият start на пристигащата пионка. Асиметрия
    // (виж task-а): Blue landing на Red's occupied start НЕ capture-ва Red
    // (Red protected на собствения си start); Red landing на СЪЩИЯ индекс,
    // окупиран от Blue, capture-ва Blue нормално (Blue не е protected там —
    // не е нейният own start). isCapture е true, ако съществува поне ЕДНА
    // opponent пионка на target-a, която НЕ е protected по това правило.
    const captureTargetTrackIndex = targetPosition.kind === 'track' ? targetPosition.trackIndex : null
    const isCapture =
      captureTargetTrackIndex !== null &&
      !ludoEngineIsSafeTrackIndex(captureTargetTrackIndex) &&
      pieces.some(
        (other) =>
          other.color !== activeColor &&
          other.position.kind === 'track' &&
          other.position.trackIndex === captureTargetTrackIndex &&
          !ludoEngineIsOwnStartTrackIndex(other.color, captureTargetTrackIndex),
      )

    moves.push({
      color: piece.color,
      slot: piece.slot,
      targetPosition,
      isCapture,
    })
  }

  return moves
}
