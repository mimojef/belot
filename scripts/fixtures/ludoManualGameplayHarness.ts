// РЪЧЕН (manual) gameplay dev harness за Ludo Phase 3B — temporary dev/test
// seam, НЕ част от production navigation, НЕ пипа нормалния production
// initial state (createLobbyFlowController.ts продължава да вика
// createLudoEngineInitialState() без initialState override).
//
// Стартирай с `npm run dev` (root Vite dev server, СЪЩИЯТ, който Playwright
// browser check-овете вече ползват) и отвори:
//   http://localhost:5173/scripts/fixtures/ludoManualGameplayHarness.html
//
// Control panel-ът горе съдържа бутон за всеки TEST 1-12 сценарий от
// заявката — click зарежда РЕАЛНИЯ createLudoFlowController() с точно
// seeded pieces разположение (през LudoFlowControllerOptions.initialState),
// готов за нормално ръчно click-ване (зар, пионки) в истинската игра долу.
//
// "Force next dice roll" полето override-ва window.Math.random ЕДИНСТВЕНО
// за следващото хвърляне (после автоматично се връща към истинска
// случайност) — единственият начин да получиш детерминистичен резултат за
// ръчно тестване, без да пипаш production dice кода
// (rollLudoMockDiceResult() няма injection seam).
import { createLudoFlowController } from '/src/app/games/ludo/createLudoFlowController.ts'
import type { LudoGameState, LudoGamePiece, LudoColor, LudoPieceSlot, LudoPiecePosition } from '/src/app/games/ludo/engine/ludoEngineTypes.ts'

const COLORS: LudoColor[] = ['red', 'blue', 'yellow', 'green']
const panel = document.getElementById('ludo-manual-harness-panel')!
const root = document.getElementById('ludo-manual-harness-root')! as HTMLElement

let controller: { destroy: () => void } | null = null

function fullRoster(overrides: Record<string, LudoPiecePosition>): LudoGamePiece[] {
  const pieces: LudoGamePiece[] = []
  for (const color of COLORS) {
    for (let slot = 0; slot < 4; slot += 1) {
      const key = `${color}-${slot}`
      const position = overrides[key] ?? { kind: 'home', slot: slot as LudoPieceSlot }
      pieces.push({ color, slot: slot as LudoPieceSlot, position })
    }
  }
  return pieces
}

function makeState(activeColor: LudoColor, overrides: Record<string, LudoPiecePosition>): LudoGameState {
  return {
    turnOrder: ['red', 'blue', 'yellow', 'green'],
    activeColor,
    turnPhase: 'waiting_for_roll',
    diceValue: null,
    legalMoves: [],
    pieces: fullRoster(overrides),
    status: 'in_progress',
    turnVersion: 0,
    pendingExtraRoll: false,
  }
}

function mount(overrides: Record<string, LudoPiecePosition>, activeColor: LudoColor, forcedRoll: number | null): void {
  if (controller) {
    controller.destroy()
    controller = null
  }
  root.innerHTML = ''
  if (forcedRoll !== null) forceNextRollOnce(forcedRoll)
  controller = createLudoFlowController({ root, onExit: () => {}, initialState: makeState(activeColor, overrides) })
}

// ---- forced dice (self-resetting after ONE roll) ----
const originalRandom = Math.random.bind(Math)
function forceNextRollOnce(value: number): void {
  const patched = () => {
    Math.random = originalRandom // consume exactly once
    return (value - 0.5) / 6 // rollLudoMockDiceResult(): floor(x*6)+1 === value
  }
  Math.random = patched
}

// ---- scenarios: TEST 1-12, exact setups from the task ----
type Scenario = { id: string; title: string; desc: string; run: () => void }

const scenarios: Scenario[] = [
  {
    id: 'T1',
    title: 'TEST 1 — Home exit',
    desc: 'red има pawn в home, следващ зар=6. Очаквай: selectable + rotating marker, click -> излиза на track-1 с animation, после SAME player получава extra roll (roll бутонът пак се появява).',
    run: () => mount({}, 'red', 6),
  },
  {
    id: 'T2',
    title: 'TEST 2 — Home pawn без 6',
    desc: 'зар=3 (не 6). Очаквай: red-0 (home) НЕ е selectable/без marker; red-1 (track-4) Е selectable.',
    run: () => mount({ 'red-1': { kind: 'track', trackIndex: 4 } }, 'red', 3),
  },
  {
    id: 'T3',
    title: 'TEST 3 — Normal move / turn advance',
    desc: 'red-1 на track-4, зар=3 (не 6, без capture). Очаквай: премества се точно 3 клетки (track-7), после редът минава към blue.',
    run: () => mount({ 'red-1': { kind: 'track', trackIndex: 4 } }, 'red', 3),
  },
  {
    id: 'T4',
    title: 'TEST 4 — Six extra roll',
    desc: 'red-1 на track-4, зар=6. Очаквай: нормален ход, active player остава red, нов waiting_for_roll, timer се рестартира, roll бутонът пак се появява (само ЕДИН extra roll).',
    run: () => mount({ 'red-1': { kind: 'track', trackIndex: 4 } }, 'red', 6),
  },
  {
    id: 'T5',
    title: 'TEST 5 — Capture extra roll',
    desc: 'red-1 track-14, blue-0 track-17 (3 стъпки), зар=3 -> точно capture. Очаквай: move -> shake -> explosion -> victim flight -> victim в home-blue-0 -> attacker на track-17 -> extra roll за red.',
    run: () => mount({ 'red-1': { kind: 'track', trackIndex: 14 }, 'blue-0': { kind: 'track', trackIndex: 17 } }, 'red', 3),
  },
  {
    id: 'T6',
    title: 'TEST 6 — Six + capture',
    desc: 'red-1 track-14, blue-0 track-20 (6 стъпки), зар=6. Очаквай: capture sequence, после ТОЧНО един extra roll (не два — след него нов non-6/non-capture ход трябва да подаде хода на blue).',
    run: () => mount({ 'red-1': { kind: 'track', trackIndex: 14 }, 'blue-0': { kind: 'track', trackIndex: 20 } }, 'red', 6),
  },
  {
    id: 'T7',
    title: 'TEST 7 — Track -> Finish',
    desc: 'red-1 на track-54 (stepsFromStart=53), зар=4. Очаквай route: track-55 -> track-0 -> finish-red-0 -> finish-red-1, без teleport. Финал: finishIndex=1.',
    run: () => mount({ 'red-1': { kind: 'track', trackIndex: 54 } }, 'red', 4),
  },
  {
    id: 'T8',
    title: 'TEST 8 — Finish movement',
    desc: 'red-1 finishIndex=2, зар=2. Очаквай: finish-2 -> finish-3 -> finish-4.',
    run: () => mount({ 'red-1': { kind: 'finish', finishIndex: 2 } }, 'red', 2),
  },
  {
    id: 'T9',
    title: 'TEST 9 — Exact finish',
    desc: 'red-1 finishIndex=4, зар=1. Очаквай: -> finishIndex=5. След това тази pawn никога повече не трябва да е legal move (пробвай пак по-късно с всякакъв зар).',
    run: () => mount({ 'red-1': { kind: 'finish', finishIndex: 4 } }, 'red', 1),
  },
  {
    id: 'T10',
    title: 'TEST 10 — Overshoot',
    desc: 'red-1 finishIndex=4, зар=2. Очаквай: red-1 НЕ е selectable, без marker, без движение.',
    run: () => mount({ 'red-1': { kind: 'finish', finishIndex: 4 } }, 'red', 2),
  },
  {
    id: 'T11A',
    title: 'TEST 11A — Zero legal moves, non-6',
    desc: 'всичките 4 red pieces на finishIndex=5, зар=3 (не 6). Очаквай: автоматично minava към blue, БЕЗ click, без 15s чакане, без hang.',
    run: () =>
      mount(
        {
          'red-0': { kind: 'finish', finishIndex: 5 },
          'red-1': { kind: 'finish', finishIndex: 5 },
          'red-2': { kind: 'finish', finishIndex: 5 },
          'red-3': { kind: 'finish', finishIndex: 5 },
        },
        'red',
        3,
      ),
  },
  {
    id: 'T11B',
    title: 'TEST 11B — Zero legal moves, six',
    desc: 'същото разположение, зар=6. Очаквай: red ОСТАВА активен, получава extra roll (roll бутонът пак се появява), без hang.',
    run: () =>
      mount(
        {
          'red-0': { kind: 'finish', finishIndex: 5 },
          'red-1': { kind: 'finish', finishIndex: 5 },
          'red-2': { kind: 'finish', finishIndex: 5 },
          'red-3': { kind: 'finish', finishIndex: 5 },
        },
        'red',
        6,
      ),
  },
  {
    id: 'T12',
    title: 'TEST 12 — Bot (home/track/finish/overshoot)',
    desc: 'blue е bot: blue-0 в home, blue-1 близо до собствения finish (stepsFromStart=53), blue-2 finishIndex=2, blue-3 finishIndex=4 (overshoot-prone). Гледай автоматично — bot roll-ва/мести сам (700ms think delay). Ползвай "force next roll" за да насочиш кой преход да видиш (6=home exit, 4=blue-1 track->finish, 2=blue-2 finish move, 2 отново=blue-3 overshoot skip).',
    run: () => mount({ 'blue-1': { kind: 'track', trackIndex: 12 }, 'blue-2': { kind: 'finish', finishIndex: 2 }, 'blue-3': { kind: 'finish', finishIndex: 4 } }, 'blue', null),
  },
]

// ---- live state readout (DOM-derived — controller не излага engineState директно) ----
function buildStatePanelHtml(): string {
  const selectable = Array.from(root.querySelectorAll<HTMLElement>('[data-ludo-piece-selectable="1"]'))
    .map((el) => el.getAttribute('data-ludo-piece'))
    .filter(Boolean)
  const rollButton = root.querySelector('[data-ludo-dice-roll-button="1"]') !== null
  return `selectable pieces: ${JSON.stringify(selectable)}\nroll button present (= local player's waiting_for_roll): ${rollButton}`
}

function renderPanel(): void {
  panel.innerHTML = `
    <h1>Ludo Phase 3B — Manual Gameplay Harness (dev-only, не production)</h1>
    <div class="row">
      ${scenarios.map((s) => `<button data-scenario="${s.id}">${s.title}</button>`).join('')}
      <button data-action="force-roll">Force next roll: <input id="force-roll-input" type="number" min="1" max="6" value="6"></button>
      <button data-action="clear-force">Clear force</button>
    </div>
    <div class="desc" id="scenario-desc">Избери сценарий отгоре.</div>
    <pre id="state-readout"></pre>
  `
  panel.querySelectorAll<HTMLButtonElement>('[data-scenario]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const scenario = scenarios.find((s) => s.id === btn.dataset.scenario)!
      document.getElementById('scenario-desc')!.textContent = scenario.desc
      scenario.run()
    })
  })
  panel.querySelector<HTMLButtonElement>('[data-action="force-roll"]')?.addEventListener('click', (event) => {
    event.preventDefault()
    const input = document.getElementById('force-roll-input') as HTMLInputElement
    const value = Math.min(6, Math.max(1, Number(input.value) || 6))
    forceNextRollOnce(value)
    document.getElementById('scenario-desc')!.textContent = `Следващото хвърляне (за КОЙТО и да е цвят) е forced на ${value}. Consume-ва се веднъж, после пак истинска случайност.`
  })
  panel.querySelector<HTMLButtonElement>('[data-action="clear-force"]')?.addEventListener('click', () => {
    Math.random = originalRandom
    document.getElementById('scenario-desc')!.textContent = 'Forced dice изчистен — истинска случайност.'
  })
}

renderPanel()
setInterval(() => {
  const el = document.getElementById('state-readout')
  if (el) el.textContent = buildStatePanelHtml()
}, 300)

;(window as any).__ludoManualHarness = { mount, forceNextRollOnce, clearForce: () => { Math.random = originalRandom } }
