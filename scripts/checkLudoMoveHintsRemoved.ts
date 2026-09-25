// Deterministic проверка, че визуалните подсказки за legal moves/capture
// след хвърляне на зара вече НЕ се render-ват (виж task-а "премахни
// визуалните подсказки след хвърляне на зара"), докато gameplay-relevant
// поведението (selectable/clickable собствена пионка, legal-move data flow,
// capture resolution) остава напълно непроменено.
//
// Реален behavioral test за renderLudoPieceHtml/renderLudoPiecesByCell (чисти
// string-generation функции, без DOM/browser зависимост — import-нати и
// извикани directно, mirror на established checkLudoMultiPieceClusterLayout.ts
// стил), + source-text review за applyLudoBoardContent (DOM-touching,
// querySelector-based — не се инстанцира тук) и renderLudoHighlights.ts
// (потвърждава, че exported helper-ите останаха НЕПИПНАТИ, per explicit
// изискване "не го чисти").
//
// Покрива:
//   H1. Selectable пионка вече НЕ render-ва selectable-piece ring markup
//       (нито един от разпознаваемите ring-specific fingerprints).
//   H2. Selectable пионка ПРОДЪЛЖАВА да носи data-ludo-piece-selectable="1",
//       pointer-events:auto, cursor:pointer — кликаемостта е непроменена.
//   H3. Non-selectable пионка остава напълно непроменена (pointer-events:none,
//       cursor:default, без data-ludo-piece-selectable) — regression guard.
//   H4. renderLudoPiecesByCell (реалния legalMoves -> selectable data flow)
//       маркира ТОЧНО заявените piece id-та като selectable, останалите не —
//       доказва, че самата "кой е selectable" логика е непроменена, само
//       визуалният ring е премахнат.
//   S1. applyLudoBoardContent() вече не импортира/вика planLudoHighlights,
//       renderLudoNormalHighlight, renderLudoCaptureImpactRing, и не пипа
//       [data-ludo-cell-highlight]/[data-ludo-effects-overlay] изобщо.
//   S2. applyLudoBoardContent() продължава да подава state.legalMoves
//       НЕПРОМЕНЕНО на renderLudoPiecesByCell — legal-move data flow-ът към
//       selectable computation-а е запазен.
//   S3. renderLudoHighlights.ts остава НЕПИПНАТ — трите exported helper-а
//       (planLudoHighlights/renderLudoNormalHighlight/
//       renderLudoCaptureImpactRing) все още съществуват и работят
//       standalone, само вече не се извикват от renderLudoGameScreen.ts.
//   S4. renderLudoPieces.ts/renderLudoGameScreen.ts никога не са internal
//       gameplay-logic консуматори на computeLudoLegalMoves/resolveLudoCapture
//       — presentation-only премахването структурно не може да е засегнало
//       legal-move computation/capture resolution.
//
// Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { renderLudoPieceHtml, renderLudoPiecesByCell } from '../src/app/games/ludo/pieces/renderLudoPieces'
import {
  planLudoHighlights,
  renderLudoNormalHighlight,
  renderLudoCaptureImpactRing,
} from '../src/app/games/ludo/pieces/renderLudoHighlights'
import type { LudoPiece, LudoPieceId, LudoLegalMove } from '../src/app/games/ludo/ludoTypes'

const __dirname = dirname(fileURLToPath(import.meta.url))

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: string): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason}`)
}
function check(label: string, fn: () => void): void {
  try {
    fn()
    pass(label)
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err))
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

function readSourceFile(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

const RENDER_SCREEN_PATH = '../src/app/games/ludo/renderLudoGameScreen.ts'
const RENDER_PIECES_PATH = '../src/app/games/ludo/pieces/renderLudoPieces.ts'
const renderScreenSrc = readSourceFile(RENDER_SCREEN_PATH)
const renderPiecesSrc = readSourceFile(RENDER_PIECES_PATH)

console.log('\n=== checkLudoMoveHintsRemoved ===\n')

// ─── H1-H3: renderLudoPieceHtml — реален behavioral test ──────────────────

check('[H1] Selectable пионка вече НЕ render-ва selectable-piece ring markup', () => {
  const html = renderLudoPieceHtml('red-0', true)
  // Fingerprint-и на премахнатия ring (виж git diff-а на renderLudoPieces.ts):
  // тъмния фонов кръг fill, специфичния radius/stroke комбо на сегментирания
  // ring, и самото име на функцията, ако някога бъде реимпортирана погрешно.
  assert(!html.includes('#4a2f1c'), 'HTML-ът не трябва да съдържа тъмния ring фон-цвят (#4a2f1c)')
  assert(!html.includes('stroke-dasharray="48.2 48.2"'), 'HTML-ът не трябва да съдържа сегментирания ring stroke-dasharray')
  assert(!html.includes('renderSelectablePieceRing'), 'HTML-ът не трябва да реферира renderSelectablePieceRing изобщо')
})

check('[H2] Selectable пионка ПРОДЪЛЖАВА да е кликаема: data-ludo-piece-selectable="1", pointer-events:auto, cursor:pointer', () => {
  const html = renderLudoPieceHtml('red-0', true)
  assert(html.includes('data-ludo-piece-selectable="1"'), 'трябва да носи data-ludo-piece-selectable="1"')
  assert(html.includes('pointer-events:auto'), 'трябва да остане pointer-events:auto')
  assert(html.includes('cursor:pointer'), 'трябва да остане cursor:pointer')
  assert(html.includes('data-ludo-piece="red-0"'), 'трябва да пази piece identity атрибута (data-ludo-piece)')
})

check('[H3] Non-selectable пионка остава напълно непроменена (regression guard)', () => {
  const html = renderLudoPieceHtml('blue-1', false)
  assert(!html.includes('data-ludo-piece-selectable'), 'non-selectable пионка НЕ трябва да носи data-ludo-piece-selectable')
  assert(html.includes('pointer-events:none'), 'non-selectable пионка трябва да остане pointer-events:none')
  assert(html.includes('cursor:default'), 'non-selectable пионка трябва да остане cursor:default')
  assert(!html.includes('#4a2f1c'), 'non-selectable пионка никога не е показвала ring-а, и продължава да не го показва')
})

// ─── H4: renderLudoPiecesByCell — legal-move -> selectable data flow ──────

function mkPiece(id: LudoPieceId, cell: string): LudoPiece {
  const color = id.split('-')[0] as LudoPiece['color']
  return { id, color, cell: cell as LudoPiece['cell'] }
}

check('[H4] renderLudoPiecesByCell маркира ТОЧНО заявените legalMoves piece id-та като selectable', () => {
  const pieces: LudoPiece[] = [
    mkPiece('red-0', 'track-3'),
    mkPiece('blue-0', 'track-10'),
    mkPiece('green-0', 'track-20'),
  ]
  const legalMoves: LudoLegalMove[] = [
    { pieceId: 'red-0', targetCell: 'track-9', type: 'normal' },
    { pieceId: 'green-0', targetCell: 'track-26', type: 'capture' },
    // blue-0 умишлено ИЗВЪН legalMoves -> не трябва да е selectable.
  ]
  const fragments = renderLudoPiecesByCell(pieces, legalMoves, 'red')
  const byCell = new Map(fragments.map((f) => [f.cellId, f.html]))

  const redHtml = byCell.get('track-3')
  assert(!!redHtml && redHtml.includes('data-ludo-piece-selectable="1"'), 'red-0 (в legalMoves) трябва да е selectable')
  assert(!!redHtml && !redHtml.includes('#4a2f1c'), 'red-0 не трябва да показва ring markup')

  const greenHtml = byCell.get('track-20')
  assert(!!greenHtml && greenHtml.includes('data-ludo-piece-selectable="1"'), 'green-0 (в legalMoves, capture move) трябва да е selectable')
  assert(!!greenHtml && !greenHtml.includes('#4a2f1c'), 'green-0 не трябва да показва ring markup, дори за capture-source пионка')

  const blueHtml = byCell.get('track-10')
  assert(!!blueHtml && !blueHtml.includes('data-ludo-piece-selectable'), 'blue-0 (НЕ в legalMoves) НЕ трябва да е selectable')
})

// ─── S1-S2: applyLudoBoardContent — source review (DOM-touching, без DOM тук) ───

check('[S1] applyLudoBoardContent() вече не импортира/вика highlight helper-ите, нито пипа highlight/effects DOM селектори', () => {
  assert(
    !renderScreenSrc.includes("from './pieces/renderLudoHighlights'"),
    'renderLudoGameScreen.ts не трябва повече да импортира от pieces/renderLudoHighlights',
  )
  const fnStart = renderScreenSrc.indexOf('export function applyLudoBoardContent(')
  assert(fnStart !== -1, 'applyLudoBoardContent трябва да съществува')
  const fnEnd = renderScreenSrc.indexOf('\n}', fnStart)
  const fnBody = renderScreenSrc.slice(fnStart, fnEnd)
  assert(!fnBody.includes('planLudoHighlights'), 'applyLudoBoardContent не трябва повече да вика planLudoHighlights')
  assert(!fnBody.includes('renderLudoNormalHighlight'), 'applyLudoBoardContent не трябва повече да вика renderLudoNormalHighlight')
  assert(!fnBody.includes('renderLudoCaptureImpactRing'), 'applyLudoBoardContent не трябва повече да вика renderLudoCaptureImpactRing')
  assert(!fnBody.includes('data-ludo-cell-highlight'), 'applyLudoBoardContent не трябва повече да пипа [data-ludo-cell-highlight]')
  assert(!fnBody.includes('data-ludo-effects-overlay'), 'applyLudoBoardContent не трябва повече да пипа [data-ludo-effects-overlay]')
})

check('[S2] applyLudoBoardContent() продължава да подава state.legalMoves НЕПРОМЕНЕНО на renderLudoPiecesByCell', () => {
  const fnStart = renderScreenSrc.indexOf('export function applyLudoBoardContent(')
  const fnEnd = renderScreenSrc.indexOf('\n}', fnStart)
  const fnBody = renderScreenSrc.slice(fnStart, fnEnd)
  assert(
    fnBody.includes('renderLudoPiecesByCell(state.pieces, state.legalMoves, localColor)'),
    'legal-move data flow-ът към selectable computation-а трябва да остане непроменен (same call signature)',
  )
})

// ─── S3: renderLudoHighlights.ts остава НЕПИПНАТ ──────────────────────────

check('[S3] renderLudoHighlights.ts остава недокоснат — exported helper-ите все още съществуват и работят standalone', () => {
  assert(typeof planLudoHighlights === 'function', 'planLudoHighlights трябва да остане exported и извикваем')
  assert(typeof renderLudoNormalHighlight === 'function', 'renderLudoNormalHighlight трябва да остане exported и извикваем')
  assert(typeof renderLudoCaptureImpactRing === 'function', 'renderLudoCaptureImpactRing трябва да остане exported и извикваем')

  const plan = planLudoHighlights([
    { pieceId: 'red-0', targetCell: 'track-9', type: 'normal' },
    { pieceId: 'blue-0', targetCell: 'track-15', type: 'capture' },
  ])
  assertEqual(plan.normalCellIds.length, 1, 'planLudoHighlights все още коректно разпределя normal ходовете')
  assertEqual(plan.captureCellIds.length, 1, 'planLudoHighlights все още коректно разпределя capture ходовете')
  assert(renderLudoNormalHighlight().includes('ludo-normal-highlight-pulse'), 'renderLudoNormalHighlight все още генерира същия markup standalone')
  assert(
    renderLudoCaptureImpactRing({ row: 0, col: 0 }).includes('data-ludo-impact-ring="1"'),
    'renderLudoCaptureImpactRing все още генерира същия markup standalone',
  )
})

// ─── S4: presentation-only removal не може да е засегнало gameplay logic ──

check('[S4] renderLudoPieces.ts/renderLudoGameScreen.ts никога не са консуматори на legal-move/capture computation логиката', () => {
  assert(!renderPiecesSrc.includes('computeLudoLegalMoves'), 'renderLudoPieces.ts не трябва да импортира/вика legal-move computation-а')
  assert(!renderPiecesSrc.includes('resolveLudoCapture'), 'renderLudoPieces.ts не трябва да импортира/вика capture resolution-а')
  assert(!renderScreenSrc.includes('computeLudoLegalMoves'), 'renderLudoGameScreen.ts не трябва да импортира/вика legal-move computation-а')
  assert(!renderScreenSrc.includes('resolveLudoCapture'), 'renderLudoGameScreen.ts не трябва да импортира/вика capture resolution-а')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exitCode = 1
}
