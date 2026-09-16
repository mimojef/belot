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
// Canonical safe/star track index — ЕДИНСТВЕН source of truth (виж
// ludoGeometryConstants.ts LUDO_SAFE_TRACK_INDICES doc коментара), reuse-нат
// тук за TEST 13-15 по-долу вместо втори hardcode-нат номер.
import { LUDO_SAFE_TRACK_INDICES } from '/src/app/games/ludo/ludoGeometryConstants.ts'
// Dev-only preview helper за TEST 16 viewer switch demo (виж
// previewSharedCellAs по-долу) — СЪЩАТА функция, която production
// applyLudoBoardContent вика, не отделен/fake rendering path.
import { renderLudoPiecesByCell } from '/src/app/games/ludo/pieces/renderLudoPieces.ts'

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
  {
    id: 'T13',
    title: 'TEST 13 — Safe star collision (no capture)',
    desc: `Safe/star клетка track-${LUDO_SAFE_TRACK_INDICES[0]} (canonical LUDO_SAFE_TRACK_INDICES[0], derive-нат от production константите — НЕ hardcode-нат отделен номер). blue-0 вече стои ТОЧНО върху звездата. red-1 е ${LUDO_SAFE_TRACK_INDICES[0]! - 3} клетки преди нея, зар=3 (нарочно НЕ 6, за да не се смесва dice-extra-roll с capture-extra-roll) -> кацаш точно върху звездата. Очаквай: НЯМА shake/explosion, blue-0 ОСТАВА на клетката (coexistence), red-1 каца до нея, и двете pawns се виждат ясно, БЕЗ extra roll за red (следващ ред -> blue).`,
    run: () =>
      mount(
        { 'red-1': { kind: 'track', trackIndex: LUDO_SAFE_TRACK_INDICES[0]! - 3 }, 'blue-0': { kind: 'track', trackIndex: LUDO_SAFE_TRACK_INDICES[0]! } },
        'red',
        3,
      ),
  },
  {
    id: 'T14',
    title: 'TEST 14 — Normal capture (control scenario, NOT safe)',
    desc: `Контролен сценарий за сравнение с TEST 13 — идентична разлика в стъпки (3), но target track-12 НЕ е safe клетка. blue-0 на track-12, red-1 на track-9, зар=3 -> точно capture. Очаквай: shake -> explosion -> victim flight -> blue-0 се връща в home-blue-0 -> red-1 остава на track-12 -> extra roll за red (roll бутонът пак се появява).`,
    run: () => mount({ 'red-1': { kind: 'track', trackIndex: 9 }, 'blue-0': { kind: 'track', trackIndex: 12 } }, 'red', 3),
  },
  {
    id: 'T15',
    title: 'TEST 15 — Leave shared safe cell',
    desc: `red-1 И blue-0 вече споделят СЪЩАТА safe клетка track-${LUDO_SAFE_TRACK_INDICES[0]} (постигнато чрез TEST 13 по-горе, или зареди директно). Зар=2 (не capture, не 6) -> red-1 се мести НАПРЕД до track-${LUDO_SAFE_TRACK_INDICES[0]! + 2}. Очаквай: red-1 напуска звездата нормално, blue-0 ОСТАВА на track-${LUDO_SAFE_TRACK_INDICES[0]} без никаква промяна, без phantom capture, без visual residue (нито "duplicate" pawn на старата клетка, нито изчезнал blue-0).`,
    run: () =>
      mount(
        { 'red-1': { kind: 'track', trackIndex: LUDO_SAFE_TRACK_INDICES[0]! }, 'blue-0': { kind: 'track', trackIndex: LUDO_SAFE_TRACK_INDICES[0]! } },
        'red',
        2,
      ),
  },
  {
    id: 'T16',
    title: 'TEST 16 — 4-piece shared safe cell (CASE C: larger compact 2x2 layout + viewer switch)',
    desc: `Четирите цвята едновременно на СЪЩАТА safe клетка track-${LUDO_SAFE_TRACK_INDICES[0]} — НАЙ-ВАЖНИЯТ visual сценарий. Очаквай COMPACT "collected in the square" layout, ОСЕЗАЕМО ПО-ГОЛЯМ от предишната итерация (scale 0.56x -> 0.8x, +43% размер): четирите пионки образуват стегнат 2x2 cluster ВЪТРЕ в квадратчето на клетката — всеки остър долен връх остава в границите на клетката, никоя пионка не "стърчи" навън, но и не изглеждат като миниатюри. Всички четири цвята остават различими (по-силен overlap е ОК, но не пълно покриване). ТЕКУЩИЯТ viewer (виж "Preview as" бутоните долу) е визуално НАЙ-ОТГОРЕ. Използвай "Preview as: Red/Blue/Yellow/Green" бутоните, за да смениш viewer-а БЕЗ да пипаш game state-а — само z-order-ът на дъската се променя (пионките остават на СЪЩАТА клетка, СЪЩИЯ compact layout).`,
    run: () =>
      mount(
        {
          'red-0': { kind: 'track', trackIndex: LUDO_SAFE_TRACK_INDICES[0]! },
          'blue-0': { kind: 'track', trackIndex: LUDO_SAFE_TRACK_INDICES[0]! },
          'yellow-0': { kind: 'track', trackIndex: LUDO_SAFE_TRACK_INDICES[0]! },
          'green-0': { kind: 'track', trackIndex: LUDO_SAFE_TRACK_INDICES[0]! },
        },
        'red',
        null,
      ),
  },
  {
    id: 'T17',
    title: 'TEST 17 — 2-piece shared safe cell (CASE A: near-full-size compact layout)',
    desc: `Само red и blue на СЪЩАТА safe клетка track-${LUDO_SAFE_TRACK_INDICES[0]} — по-прост 2-piece compact layout (side-by-side, НЕ 2x2 grid), scale 0.92x (близо до пълен размер). Очаквай: и двете пионки ясно видими, ОСЕЗАЕМО по-големи от 3/4-piece сценариите, острите върхове вътре в клетката, red (local) най-отгоре.`,
    run: () =>
      mount(
        {
          'red-0': { kind: 'track', trackIndex: LUDO_SAFE_TRACK_INDICES[0]! },
          'blue-0': { kind: 'track', trackIndex: LUDO_SAFE_TRACK_INDICES[0]! },
        },
        'red',
        null,
      ),
  },
  {
    id: 'T18',
    title: 'TEST 18 — 3-piece shared safe cell (CASE B: compact cluster, no scatter)',
    desc: `red/blue/yellow на СЪЩАТА safe клетка track-${LUDO_SAFE_TRACK_INDICES[0]} — 3-piece вариант на 2x2 quadrant layout-а (scale 0.8x, четвъртата quadrant позиция просто остава празна). Очаквай: стегнат cluster вътре в квадратчето, БЕЗ "разпиляване" навън, всеки цвят различим, острите върхове вътре в клетката, red (local) най-отгоре. Сравни визуално с TEST 16 (4-piece) — идентичен scale/offset принцип, само с 1 по-малко token.`,
    run: () =>
      mount(
        {
          'red-0': { kind: 'track', trackIndex: LUDO_SAFE_TRACK_INDICES[0]! },
          'blue-0': { kind: 'track', trackIndex: LUDO_SAFE_TRACK_INDICES[0]! },
          'yellow-0': { kind: 'track', trackIndex: LUDO_SAFE_TRACK_INDICES[0]! },
        },
        'red',
        null,
      ),
  },
]

// ---- TEST 16 viewer preview (dev-only DOM overlay, НЕ пипа engine state) ----
// "Preview as: <color>" бутоните по-долу demo-ват explicit local-viewer-
// identity fix-а (виж LudoGameScreenState.localColor doc коментара в
// renderLudoGameScreen.ts) — БЕЗ да пипат createLudoFlowController/
// createLudoMockPlayers (production wiring остава недокоснат, все още само
// red е "истинският" non-bot local player, виж fix-а report-а за пълния
// architecture rationale защо това НЕ е паралелен identity model, а чисто
// presentation-layer demo). Directно override-ва DOM съдържанието на
// shared safe клетката чрез СЪЩАТА renderLudoPiecesByCell() функция,
// която production controller-ът вика — доказва реалния rendering path, не
// fake markup. Работи след TEST 16/17/18 mount (клетката трябва вече да е
// рендирана на дъската — preview override-ът винаги показва всичките 4
// цвята, независимо колко от тях реално стоят в engine state-а към момента,
// чисто DOM demo, никога не пипа engine state-а).
function previewSharedCellAs(localColor: LudoColor): void {
  const cellId = `track-${LUDO_SAFE_TRACK_INDICES[0]!}`
  const container = root.querySelector(`[data-ludo-cell-pieces="${cellId}"]`)
  if (!container) {
    document.getElementById('scenario-desc')!.textContent = `Preview: клетката ${cellId} не е намерена в текущия DOM — зареди TEST 16/17/18 първо.`
    return
  }
  const pieces = ['red-0', 'blue-0', 'yellow-0', 'green-0'].map((id) => {
    const color = id.split('-')[0] as LudoColor
    return { id: id as any, color, cell: cellId as any }
  })
  container.innerHTML = renderLudoPiecesByCell(pieces, [], localColor).find((f) => f.cellId === cellId)?.html ?? ''
  document.getElementById('scenario-desc')!.textContent = `Preview: viewer=${localColor} — ${localColor} pawn-ът трябва да е визуално най-отгоре на ${cellId}. (Game state непроменен — само DOM preview override.)`
}

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
    <div class="row">
      <span style="align-self:center;color:#aaa;">Preview as (за TEST 16/17/18, DOM-only viewer switch):</span>
      ${COLORS.map((c) => `<button data-preview-viewer="${c}">${c}</button>`).join('')}
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
  panel.querySelectorAll<HTMLButtonElement>('[data-preview-viewer]').forEach((btn) => {
    btn.addEventListener('click', () => {
      previewSharedCellAs(btn.dataset.previewViewer as LudoColor)
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
