// DEV-only manual harness for the final Ludo end-game flow. It mounts the
// production controller with a seeded canonical engine state; no fake game UI.
import { createLudoFlowController } from '/src/app/games/ludo/createLudoFlowController.ts'
import type {
  LudoColor,
  LudoGamePiece,
  LudoGameState,
  LudoPiecePosition,
  LudoPieceSlot,
} from '/src/app/games/ludo/engine/ludoEngineTypes.ts'

const COLORS: readonly LudoColor[] = ['red', 'blue', 'yellow', 'green']
const panel = document.getElementById('ludo-manual-harness-panel')!
const root = document.getElementById('ludo-manual-harness-root')! as HTMLElement
const originalRandom = Math.random.bind(Math)
let controller: { destroy: () => void } | null = null

function fullRoster(overrides: Record<string, LudoPiecePosition>): LudoGamePiece[] {
  const pieces: LudoGamePiece[] = []
  for (const color of COLORS) {
    for (let slot = 0; slot < 4; slot += 1) {
      const typedSlot = slot as LudoPieceSlot
      pieces.push({
        color,
        slot: typedSlot,
        position: overrides[`${color}-${slot}`] ?? { kind: 'home', slot: typedSlot },
      })
    }
  }
  return pieces
}

function makeEndGameState(winnerColor: LudoColor): LudoGameState {
  return {
    turnOrder: ['red', 'blue', 'yellow', 'green'],
    activeColor: winnerColor,
    turnPhase: 'waiting_for_roll',
    diceValue: null,
    legalMoves: [],
    pieces: fullRoster({
      [`${winnerColor}-0`]: { kind: 'finish', finishIndex: 5 },
      [`${winnerColor}-1`]: { kind: 'finish', finishIndex: 5 },
      [`${winnerColor}-2`]: { kind: 'finish', finishIndex: 5 },
      [`${winnerColor}-3`]: { kind: 'finish', finishIndex: 4 },
    }),
    status: 'in_progress',
    winnerColor: null,
    turnVersion: 0,
    pendingExtraRoll: false,
  }
}

function forceNextRollToOne(): void {
  Math.random = () => {
    Math.random = originalRandom
    return 0
  }
}

function mountEndGame(winnerColor: 'red' | 'blue'): void {
  controller?.destroy()
  controller = null
  Math.random = originalRandom
  root.innerHTML = ''
  forceNextRollToOne()
  controller = createLudoFlowController({
    root,
    onExit: () => {},
    initialState: makeEndGameState(winnerColor),
  })
  const description = document.getElementById('scenario-desc')!
  description.textContent = winnerColor === 'red'
    ? 'Winner mode: red (local) има 3 прибрани пионки и четвърта на finishIndex=4. Хвърли зара и избери пионката. Очаквай само end-game.mp3 и „Вие сте победител в играта!“. След OK resize не трябва да върне popup-а или звука.'
    : 'Loser mode: blue (bot) има 3 прибрани пионки и четвърта на finishIndex=4. Изчакай автоматичния ход. Local red трябва да види само end-game.mp3 и „Вие загубихте играта.“. След OK resize не трябва да върне popup-а или звука.'
}

panel.innerHTML = `
  <h1>Ludo Manual Harness — End game</h1>
  <div class="row">
    <button type="button" data-end-game-winner="1">TEST 1 — End game</button>
    <button type="button" data-end-game-loser="1">Loser mode</button>
  </div>
  <div class="desc" id="scenario-desc">Избери winner или loser режима.</div>
`

panel.querySelector('[data-end-game-winner="1"]')?.addEventListener('click', () => mountEndGame('red'))
panel.querySelector('[data-end-game-loser="1"]')?.addEventListener('click', () => mountEndGame('blue'))

window.addEventListener('beforeunload', () => {
  Math.random = originalRandom
  controller?.destroy()
})
