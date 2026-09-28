/**
 * checkLudoBotMovePolicy.ts
 *
 * Regression тест за production server-side Ludo bot move policy
 * (server/src/game/ludoEngine/ludoBotPolicy.ts::pickLudoBotMoveForState),
 * ползвана от ludoMatchRuntime.ts при bot takeover / timeout auto-move.
 *
 * Всички state-ове са построени с реалната canonical геометрия (start
 * 0/14/28/42, звезди 8/22/36/50) и legalMoves от computeLudoEngineLegalMoves —
 * policy-то само избира измежду тях.
 *
 * Покрива:
 *   [P1]  реален capture > base exit при 6
 *   [P2]  противник на собствения си старт е protected -> не е capture
 *   [P2b] противник върху ЧУЖД старт не е protected -> capture се избира
 *   [P3]  противник върху звезда е protected -> не е capture
 *   [P4]  при 6 без capture: base exit > нормален ход
 *   [P5]  безопасен ход (противник на 7) > ход на 3 пред противник, дори с
 *         по-малък progress
 *   [P6]  всички рискови: 1 заплаха > 2 заплахи
 *   [P7]  еднакъв брой заплахи: противник на 6 стъпки > противник на 1 стъпка
 *   [P8]  звезда = 0 риск дори с противник на 2 стъпки зад
 *   [P9]  собственият старт (base exit) = 0 риск; чужд старт НЕ е safe
 *   [P10] finish-lane пионка е нисък приоритет при равен риск
 *   [P11] единствен legal ход във finish lane -> изпълнява се
 *   [P12] няколко capture-а -> най-безопасният
 *   [P13] напуснал цвят (leftColors) не е заплаха
 *   [P14] противник, чийто маршрут завива към неговия finish lane, не е заплаха
 *   [P15] детерминизъм + slot tie-break
 *   [P16] без legal moves -> null; изборът винаги е от state.legalMoves
 *   [P17] ludoMatchRuntime.ts вика pickLudoBotMoveForState(match.state) и
 *         изпраща избрания slot през applyMove (без bot-only ходове)
 *   [P18] legacy pickLudoBotMove(legalMoves) е непроменен
 *   [P19] пионка на ЧУЖД старт + противникова пионка в базата -> заплаха
 *         (base exit при 6, тегло 1)
 *   [P20] противник без пионки в базата -> няма base заплаха
 *   [P21] няколко base пионки на един цвят = една заплаха
 *   [P22] напуснал цвят с пионки в базата -> не е заплаха
 *   [P23] безопасна алтернатива > кацане на чужд старт с противникова база
 *   [P24] собствената база/старт не е заплаха за собствени пионки
 *   [P25] wrap-around 55 -> 0: blue на 54 заплашва yellow на 2 (engine: само зар 4)
 *   [P26] wrap-around контрола: blue на 51 не стига 2 с нито един зар 1..6
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  evaluateLudoBotMoves,
  pickLudoBotMove,
  pickLudoBotMoveForState,
} from '../src/game/ludoEngine/ludoBotPolicy.js'
import { computeLudoEngineLegalMoves } from '../src/game/ludoEngine/ludoEngineLegalMoves.js'
import { findLudoEngineCaptureVictims } from '../src/game/ludoEngine/ludoEngineCapture.js'
import type {
  LudoColor,
  LudoDiceValue,
  LudoGamePiece,
  LudoGameState,
  LudoLegalMove,
  LudoPiecePosition,
  LudoPieceSlot,
} from '../src/game/ludoEngine/ludoEngineTypes.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')

let passed = 0
let failed = 0
function check(label: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed++
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

type Placement = [LudoColor, LudoPieceSlot, LudoPiecePosition]
const track = (trackIndex: number): LudoPiecePosition => ({ kind: 'track', trackIndex })
const finish = (finishIndex: number): LudoPiecePosition => ({ kind: 'finish', finishIndex })

const allStates: LudoGameState[] = []

function makeState(
  activeColor: LudoColor,
  diceValue: LudoDiceValue,
  placements: Placement[],
  options: { turnOrder?: LudoColor[]; leftColors?: LudoColor[] } = {},
): LudoGameState {
  const turnOrder = options.turnOrder ?? ['red', 'blue', 'yellow', 'green']
  const pieces: LudoGamePiece[] = turnOrder.flatMap((color) =>
    ([0, 1, 2, 3] as const).map((slot) => {
      const placed = placements.find(([c, s]) => c === color && s === slot)
      return { color, slot, position: placed ? placed[2] : { kind: 'home', slot } }
    }),
  )
  const state: LudoGameState = {
    turnOrder,
    activeColor,
    turnPhase: 'awaiting_move_selection',
    diceValue,
    legalMoves: computeLudoEngineLegalMoves(pieces, activeColor, diceValue),
    pieces,
    status: 'in_progress',
    winnerColor: null,
    turnVersion: 1,
    pendingExtraRoll: false,
    leftColors: options.leftColors ?? [],
  }
  allStates.push(state)
  return state
}

function pickSlot(state: LudoGameState): LudoPieceSlot | null {
  return pickLudoBotMoveForState(state)?.slot ?? null
}

function evaluationFor(state: LudoGameState, slot: LudoPieceSlot) {
  const evaluation = evaluateLudoBotMoves(state).find((entry) => entry.move.slot === slot)
  assert.ok(evaluation, `няма legal ход за slot ${slot}`)
  return evaluation!
}

console.log('\ncheckLudoBotMovePolicy\n')

check('[P1] реален capture > base exit при 6', () => {
  // red0 10 -> 16 удря blue0; red1..3 в базата могат да излязат с 6.
  const state = makeState('red', 6, [['red', 0, track(10)], ['blue', 0, track(16)]])
  assert.ok(state.legalMoves.some((move) => move.slot === 1 && move.targetPosition.kind === 'track'), 'base exit трябва да е legal')
  assert.equal(pickSlot(state), 0)
  assert.equal(pickLudoBotMoveForState(state)!.isCapture, true)
})

check('[P2] зелена пионка на зеленото стартово поле е protected -> не е capture', () => {
  // red0 38 -> 42 (green start), green0 стои там; red1 20 -> 24.
  const state = makeState('red', 4, [['red', 0, track(38)], ['red', 1, track(20)], ['green', 0, track(42)]])
  const toGreenStart = evaluationFor(state, 0)
  assert.equal(toGreenStart.move.isCapture, false)
  assert.notEqual(toGreenStart.tier, 0, 'не бива да е в capture tier-а')
})

check('[P2b] синя пионка на зеленото стартово поле НЕ е protected -> capture се избира', () => {
  const state = makeState('red', 4, [['red', 0, track(38)], ['red', 1, track(20)], ['blue', 0, track(42)]])
  assert.equal(evaluationFor(state, 0).move.isCapture, true)
  assert.equal(pickSlot(state), 0)
})

check('[P3] противник върху звезда е protected -> не е capture', () => {
  const state = makeState('red', 4, [['red', 0, track(18)], ['blue', 0, track(22)]])
  const toStar = evaluationFor(state, 0)
  assert.equal(toStar.move.isCapture, false)
  assert.notEqual(toStar.tier, 0)
})

check('[P4] при 6 без capture: base exit > нормален ход (finish-lane пионката няма legal ход с 6)', () => {
  const state = makeState('red', 6, [['red', 0, track(10)], ['red', 1, finish(0)]])
  assert.ok(!state.legalMoves.some((move) => move.slot === 1), 'finish 0 + 6 е overshoot')
  const picked = pickLudoBotMoveForState(state)!
  assert.equal(picked.targetPosition.kind, 'track')
  assert.equal(state.pieces.find((p) => p.color === 'red' && p.slot === picked.slot)!.position.kind, 'home', 'трябва да е изваждане от базата')
  assert.equal(picked.slot, 2, 'най-малкият slot в базата (deterministic)')
})

check('[P5] безопасен ход > ход на 4 стъпки пред противник (дори с по-малък progress)', () => {
  // red0 30 -> 33: blue0 на 29 (distance 4). red1 20 -> 23: blue1 на 16 (distance 7).
  const state = makeState('red', 3, [
    ['red', 0, track(30)], ['red', 1, track(20)],
    ['blue', 0, track(29)], ['blue', 1, track(16)],
  ])
  assert.equal(evaluationFor(state, 0).threatCount, 1)
  assert.equal(evaluationFor(state, 1).threatCount, 0)
  assert.equal(pickSlot(state), 1)
})

check('[P6] всички рискови: 1 заплаха > 2 заплахи', () => {
  // red0 30 -> 33: blue0 29 (4), yellow0 31 (2). red1 44 -> 47: blue1 45 (2).
  const state = makeState('red', 3, [
    ['red', 0, track(30)], ['red', 1, track(44)],
    ['blue', 0, track(29)], ['yellow', 0, track(31)], ['blue', 1, track(45)],
  ])
  assert.equal(evaluationFor(state, 0).threatCount, 2)
  assert.equal(evaluationFor(state, 1).threatCount, 1)
  assert.equal(pickSlot(state), 1)
})

check('[P7] еднакъв брой заплахи: противник на 6 стъпки > противник на 1 стъпка', () => {
  // red0 30 -> 33: blue0 32 (1). red1 44 -> 47: blue1 41 (6).
  const state = makeState('red', 3, [
    ['red', 0, track(30)], ['red', 1, track(44)],
    ['blue', 0, track(32)], ['blue', 1, track(41)],
  ])
  const near = evaluationFor(state, 0)
  const far = evaluationFor(state, 1)
  assert.equal(near.threatCount, 1)
  assert.equal(far.threatCount, 1)
  assert.equal(near.threatWeight, 6)
  assert.equal(far.threatWeight, 1)
  assert.equal(pickSlot(state), 1)
})

check('[P8] звезда = 0 риск, дори с противник на 2 стъпки зад', () => {
  // red0 18 -> 22 (звезда), blue0 на 20. red1 40 -> 44, blue1 41 (3) -> рисков.
  const state = makeState('red', 4, [
    ['red', 0, track(18)], ['red', 1, track(40)],
    ['blue', 0, track(20)], ['blue', 1, track(41)],
  ])
  assert.equal(evaluationFor(state, 0).threatCount, 0)
  assert.equal(evaluationFor(state, 1).threatCount, 1)
  assert.equal(pickSlot(state), 0)
})

check('[P9] собственият старт = 0 риск; чужд старт НЕ е safe', () => {
  // Base exit на red start 0, blue0 на 53 (3 стъпки зад) -> 0 риск.
  const ownStart = makeState('red', 6, [['blue', 0, track(53)]])
  const baseExit = evaluateLudoBotMoves(ownStart).find((entry) => entry.move.targetPosition.kind === 'track')!
  assert.equal(baseExit.threatCount, 0)
  // red0 10 -> 14 (blue start): yellow0 на 11 (3 стъпки) + синята база (6) -> 2 заплахи.
  const foreignStart = makeState('red', 4, [['red', 0, track(10)], ['yellow', 0, track(11)]])
  assert.equal(evaluationFor(foreignStart, 0).threatCount, 2)
})

check('[P10] при равен риск: shared-track пионка > вече защитена finish-lane пионка', () => {
  const state = makeState('red', 2, [['red', 0, finish(0)], ['red', 1, track(10)]])
  assert.equal(evaluationFor(state, 0).isFinishLanePiece, true)
  assert.equal(pickSlot(state), 1)
})

check('[P11] единствен legal ход във finish lane -> изпълнява се', () => {
  const state = makeState('red', 3, [['red', 0, finish(0)]])
  assert.equal(state.legalMoves.length, 1)
  assert.equal(pickSlot(state), 0)
})

check('[P12] няколко capture-а -> най-безопасният', () => {
  // red0 10 -> 13 удря blue0 (без заплахи). red1 30 -> 33 удря blue1, yellow0 31 (2) заплашва.
  const state = makeState('red', 3, [
    ['red', 0, track(10)], ['red', 1, track(30)],
    ['blue', 0, track(13)], ['blue', 1, track(33)], ['yellow', 0, track(31)],
  ])
  assert.equal(evaluationFor(state, 0).move.isCapture, true)
  assert.equal(evaluationFor(state, 1).move.isCapture, true)
  assert.equal(evaluationFor(state, 1).threatCount, 1)
  assert.equal(pickSlot(state), 0)
})

check('[P13] напуснал цвят (leftColors) не е заплаха', () => {
  const placements: Placement[] = [['red', 0, track(30)], ['yellow', 0, track(31)]]
  assert.equal(evaluationFor(makeState('red', 3, placements), 0).threatCount, 1)
  assert.equal(evaluationFor(makeState('red', 3, placements, { leftColors: ['yellow'] }), 0).threatCount, 0)
})

check('[P14] противник, който завива към своя finish lane, не е заплаха', () => {
  // green0 на index 41 = 55 стъпки от green start -> следващата му стъпка е finish.
  // red0 40 -> 43 е 2 стъпки "пред" него по индекс, но green не може да стигне там.
  const state = makeState('red', 3, [['red', 0, track(40)], ['green', 0, track(41)]])
  assert.equal(evaluationFor(state, 0).threatCount, 0)
})

check('[P15] детерминизъм + slot tie-break', () => {
  const state = makeState('red', 6, [])
  const first = pickLudoBotMoveForState(state)
  for (let index = 0; index < 5; index++) assert.deepEqual(pickLudoBotMoveForState(state), first)
  assert.equal(first!.slot, 0)
})

check('[P19] blue пионка на green start + green пионка в базата -> заплаха (base exit при 6)', () => {
  // blue0 38 -> 42 (green start); green има пионки в базата.
  const state = makeState('blue', 4, [['blue', 0, track(38)]], { turnOrder: ['blue', 'green'] })
  const evaluation = evaluationFor(state, 0)
  assert.equal(evaluation.threatCount, 1)
  assert.equal(evaluation.threatWeight, 1, 'base exit е при зар 6 -> тегло 7-6')
})

check('[P20] противник без пионки в базата -> няма base заплаха на неговия старт', () => {
  const state = makeState('blue', 4, [
    ['blue', 0, track(38)],
    ['green', 0, finish(0)], ['green', 1, finish(1)], ['green', 2, finish(2)], ['green', 3, finish(3)],
  ], { turnOrder: ['blue', 'green'] })
  assert.equal(evaluationFor(state, 0).threatCount, 0)
})

check('[P21] няколко base пионки на един цвят = една заплаха', () => {
  const oneInBase = makeState('blue', 4, [
    ['blue', 0, track(38)],
    ['green', 1, finish(1)], ['green', 2, finish(2)], ['green', 3, finish(3)],
  ], { turnOrder: ['blue', 'green'] })
  const fourInBase = makeState('blue', 4, [['blue', 0, track(38)]], { turnOrder: ['blue', 'green'] })
  assert.equal(evaluationFor(oneInBase, 0).threatCount, 1)
  assert.equal(evaluationFor(fourInBase, 0).threatCount, 1)
})

check('[P22] напуснал цвят с пионки в базата -> не е заплаха', () => {
  const state = makeState('blue', 4, [['blue', 0, track(38)]], { turnOrder: ['blue', 'green', 'red'], leftColors: ['green'] })
  assert.equal(evaluationFor(state, 0).threatCount, 0)
})

check('[P23] безопасна алтернатива > кацане на чужд старт с противникова база', () => {
  // blue0 38 -> 42 (green start, green база) vs blue1 16 -> 20 (без заплахи).
  const state = makeState('blue', 4, [['blue', 0, track(38)], ['blue', 1, track(16)]], { turnOrder: ['blue', 'green'] })
  assert.equal(evaluationFor(state, 0).threatCount, 1)
  assert.equal(evaluationFor(state, 1).threatCount, 0)
  assert.equal(pickSlot(state), 1)
})

check('[P24] собствената база не е заплаха за собствена пионка (own start е safe)', () => {
  // red base exit -> red start 0; червените в базата са собствени, сини/жълти/зелени не излизат на 0.
  const state = makeState('red', 6, [])
  for (const evaluation of evaluateLudoBotMoves(state)) assert.equal(evaluation.threatCount, 0)
})

// Wrap-around 55 -> 0 helpers: всичко се доказва с canonical engine
// legal moves / capture victims — без собствена % 56 формула.
function piecesAfterYellowMove(state: LudoGameState, slot: LudoPieceSlot, destination: number): LudoGamePiece[] {
  return state.pieces.map((piece) =>
    piece.color === 'yellow' && piece.slot === slot ? { ...piece, position: track(destination) } : piece,
  )
}

// Заровете 1..6, с които blue пионката (sourceSlot) реално каца на
// destination И удря yellow пионката там.
function blueCapturingDice(pieces: readonly LudoGamePiece[], sourceSlot: LudoPieceSlot, destination: number, yellowSlot: LudoPieceSlot): LudoDiceValue[] {
  const dice: LudoDiceValue[] = [1, 2, 3, 4, 5, 6]
  return dice.filter((diceValue) =>
    computeLudoEngineLegalMoves(pieces, 'blue', diceValue).some(
      (move) =>
        move.slot === sourceSlot &&
        move.targetPosition.kind === 'track' &&
        move.targetPosition.trackIndex === destination &&
        move.isCapture &&
        findLudoEngineCaptureVictims(pieces, destination, 'blue').some((victim) => victim.color === 'yellow' && victim.slot === yellowSlot),
    ),
  )
}

check('[P25] wrap-around 55 -> 0: blue на 54 заплашва yellow на 2', () => {
  const state = makeState('yellow', 5, [
    ['yellow', 0, track(53)], ['yellow', 1, track(30)],
    ['blue', 0, track(54)],
  ], { turnOrder: ['yellow', 'blue'] })
  const wrapMove = evaluationFor(state, 0)
  assert.deepEqual(wrapMove.move.targetPosition, { kind: 'track', trackIndex: 2 }, 'yellow 53 + 5 трябва canonical да е track-2')
  assert.deepEqual(blueCapturingDice(piecesAfterYellowMove(state, 0, 2), 0, 2, 0), [4], 'engine: само зар 4 стига и удря')
  assert.equal(wrapMove.threatCount, 1)
  assert.equal(wrapMove.threatWeight, 3, '7 - 4')
  const safeMove = evaluationFor(state, 1)
  assert.deepEqual(safeMove.move.targetPosition, { kind: 'track', trackIndex: 35 })
  assert.equal(safeMove.threatCount, 0)
  assert.equal(pickSlot(state), 1, 'policy избира безопасния ход 30 -> 35')
})

check('[P26] wrap-around 55 -> 0 контрола: blue на 51 не стига yellow на 2', () => {
  const state = makeState('yellow', 5, [['yellow', 0, track(53)], ['blue', 0, track(51)]], { turnOrder: ['yellow', 'blue'] })
  const wrapMove = evaluationFor(state, 0)
  assert.deepEqual(wrapMove.move.targetPosition, { kind: 'track', trackIndex: 2 })
  const piecesAfter = piecesAfterYellowMove(state, 0, 2)
  const dice: LudoDiceValue[] = [1, 2, 3, 4, 5, 6]
  for (const diceValue of dice) {
    const reaches = computeLudoEngineLegalMoves(piecesAfter, 'blue', diceValue).some(
      (move) => move.slot === 0 && move.targetPosition.kind === 'track' && move.targetPosition.trackIndex === 2,
    )
    assert.equal(reaches, false, `blue 51 не бива да стига 2 със зар ${diceValue}`)
  }
  assert.equal(wrapMove.threatCount, 0)
})

check('[P16] без legal moves -> null; изборът винаги е от state.legalMoves', () => {
  assert.equal(pickLudoBotMoveForState(makeState('red', 3, [])), null)
  for (const state of allStates) {
    const picked = pickLudoBotMoveForState(state)
    if (picked === null) {
      assert.equal(state.legalMoves.length, 0)
      continue
    }
    assert.ok(state.legalMoves.includes(picked as LudoLegalMove), 'изборът трябва да е точно обект от state.legalMoves')
  }
})

check('[P17] ludoMatchRuntime.ts вика pickLudoBotMoveForState(match.state) и изпраща slot-а през applyMove', () => {
  const runtimeSrc = readFileSync(resolve(serverRoot, 'src/game/ludoMatchRuntime.ts'), 'utf8')
  assert.match(runtimeSrc, /const move = pickLudoBotMoveForState\(match\.state\)/)
  assert.match(runtimeSrc, /applyMove\(match, move\.slot, takeoverEvents\)/)
  assert.ok(!/pickLudoBotMove\(match\.state\.legalMoves\)/.test(runtimeSrc), 'старият legal-moves-only избор не бива да се ползва в runtime-а')
})

check('[P18] legacy pickLudoBotMove(legalMoves) е непроменен (първи capture, иначе първи ход)', () => {
  const state = makeState('red', 6, [['red', 0, track(10)], ['blue', 0, track(16)]])
  assert.equal(pickLudoBotMove(state.legalMoves)!.isCapture, true)
  assert.equal(pickLudoBotMove([]), null)
  const noCapture = makeState('red', 6, [['red', 0, track(10)]])
  assert.equal(pickLudoBotMove(noCapture.legalMoves), noCapture.legalMoves[0])
})

console.log('\n' + '═'.repeat(75))
console.log(`Passed: ${passed}  Failed: ${failed}`)
console.log('═'.repeat(75) + '\n')
if (failed > 0) process.exitCode = 1
