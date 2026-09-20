import { renderLudoGameScreen, applyLudoBoardContent, type LudoGameScreenState } from '/src/app/games/ludo/renderLudoGameScreen.ts'
import { createLudoMockPlayers } from '/src/app/games/ludo/mock/ludoMockState.ts'
import { playLudoMoveRouteOverlay } from '/src/app/games/ludo/pieces/playLudoMoveRouteOverlay.ts'
import { buildLudoMoveRoute } from '/src/app/games/ludo/board/ludoMoveRoute.ts'
import type { LudoCellId, LudoPiece, LudoPieceId } from '/src/app/games/ludo/ludoTypes.ts'

const root = document.getElementById('ludo-effect-root')!
const panel = document.getElementById('ludo-effect-panel')!
const status = document.getElementById('ludo-effect-status')!
const players = createLudoMockPlayers()

type Scenario = {
  id: string
  title: string
  from: LudoCellId
  to: LudoCellId
  pieces: LudoPiece[]
  note: string
}

let currentPieces: LudoPiece[] = []
let speedScale = 1
let cancelActive: (() => void) | null = null

const mover: LudoPieceId = 'red-0'

const scenarios: Scenario[] = [
  {
    id: 'one',
    title: '1 step',
    from: 'track-4',
    to: 'track-5',
    pieces: [{ id: mover, color: 'red', cell: 'track-4' }],
    note: 'Single visible step: move, pulse, one afterimage, cleanup.',
  },
  {
    id: 'three',
    title: '3 steps',
    from: 'track-4',
    to: 'track-7',
    pieces: [{ id: mover, color: 'red', cell: 'track-4' }],
    note: 'Three separate cell visits with overlapping fading trails.',
  },
  {
    id: 'six',
    title: '6 steps',
    from: 'track-4',
    to: 'track-10',
    pieces: [{ id: mover, color: 'red', cell: 'track-4' }],
    note: 'Six fast game-like steps without a long dice=6 delay.',
  },
  {
    id: 'home',
    title: 'home exit',
    from: 'home-red-0',
    to: 'track-0',
    pieces: [{ id: mover, color: 'red', cell: 'home-red-0' }],
    note: 'Home slot to start cell, still using the shared effects overlay.',
  },
  {
    id: 'finish',
    title: 'track -> finish',
    from: 'track-54',
    to: 'finish-red-1',
    pieces: [{ id: mover, color: 'red', cell: 'track-54' }],
    note: 'Route crosses track-55, finish-red-0, finish-red-1.',
  },
  {
    id: 'capture',
    title: 'capture setup',
    from: 'track-14',
    to: 'track-17',
    pieces: [
      { id: mover, color: 'red', cell: 'track-14' },
      { id: 'blue-0', color: 'blue', cell: 'track-17' },
    ],
    note: 'Movement arrives on an occupied target; use gameplay harness for the full victim flight.',
  },
  {
    id: 'safe',
    title: 'shared safe dest',
    from: 'track-7',
    to: 'track-10',
    pieces: [
      { id: mover, color: 'red', cell: 'track-7' },
      { id: 'blue-0', color: 'blue', cell: 'track-10' },
      { id: 'yellow-0', color: 'yellow', cell: 'track-10' },
    ],
    note: 'Mover lands on a shared safe-style occupied cell; no clipping or duplicate mover.',
  },
]

function screenState(pieces: LudoPiece[]): LudoGameScreenState {
  return {
    players,
    localColor: 'red',
    pieces,
    legalMoves: [],
    activeColor: 'red',
    turnPhase: 'turn_complete',
    turnStartedAt: Date.now(),
    turnCountdownMs: 700,
    isHumanCountdownActive: false,
    isDiceRolling: false,
    canRollDice: false,
    turnSecondsLeft: 1,
    useMobileLayout: window.innerWidth <= 700,
  }
}

function render(pieces: LudoPiece[]): void {
  currentPieces = pieces
  root.innerHTML = renderLudoGameScreen(screenState(pieces))
  applyLudoBoardContent(root, screenState(pieces))
}

function withoutMover(pieces: LudoPiece[]): LudoPiece[] {
  return pieces.filter((piece) => piece.id !== mover)
}

function withMoverAt(pieces: LudoPiece[], cell: LudoCellId): LudoPiece[] {
  return [...withoutMover(pieces), { id: mover, color: 'red', cell }]
}

async function runScenario(scenario: Scenario): Promise<void> {
  cancelActive?.()
  cancelActive = null
  render(scenario.pieces)
  await new Promise((resolve) => requestAnimationFrame(resolve))

  const pieceEl = root.querySelector<HTMLElement>(`[data-ludo-piece="${mover}"], [data-ludo-piece-group~="${mover}"]`)
  const sourceCell = root.querySelector<HTMLElement>(`[data-ludo-cell-pieces="${scenario.from}"]`)
  const pieceSizePx = pieceEl?.getBoundingClientRect().width || Math.min(30, (sourceCell?.getBoundingClientRect().width ?? 38) * 0.8)
  const route = buildLudoMoveRoute(scenario.from, scenario.to)

  render(withoutMover(scenario.pieces))
  const overlay = playLudoMoveRouteOverlay({
    root,
    pieceId: mover,
    fromCellId: scenario.from,
    route,
    pieceSizePx,
    initiallyHidden: false,
    debugSpeedScale: speedScale,
  })
  cancelActive = overlay.cancel
  status.textContent = `${scenario.title}: ${scenario.note} Route=${route.join(' -> ')} Speed=${speedScale === 1 ? 'normal' : 'slow'}`
  await overlay.finished
  cancelActive = null
  render(withMoverAt(scenario.pieces, scenario.to))
}

function renderPanel(): void {
  panel.innerHTML = `
    ${scenarios.map((scenario) => `<button data-scenario="${scenario.id}">${scenario.title}</button>`).join('')}
    <label><input type="checkbox" data-slow="1"> Slow debug</label>
    <button data-replay="1">Replay current</button>
  `
  panel.querySelector<HTMLInputElement>('[data-slow="1"]')?.addEventListener('change', (event) => {
    speedScale = (event.currentTarget as HTMLInputElement).checked ? 2.8 : 1
  })
  panel.querySelectorAll<HTMLButtonElement>('[data-scenario]').forEach((button) => {
    button.addEventListener('click', () => {
      const scenario = scenarios.find((item) => item.id === button.dataset.scenario)!
      void runScenario(scenario)
    })
  })
  panel.querySelector<HTMLButtonElement>('[data-replay="1"]')?.addEventListener('click', () => {
    const selected = status.textContent?.split(':')[0]
    const scenario = scenarios.find((item) => item.title === selected) ?? scenarios[0]!
    void runScenario(scenario)
  })
}

window.addEventListener('resize', () => render(currentPieces.length > 0 ? currentPieces : scenarios[0]!.pieces))
renderPanel()
render(scenarios[0]!.pieces)
