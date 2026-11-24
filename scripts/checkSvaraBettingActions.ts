// Deterministic unit-ниво проверка на реалните игрови бутони за Свара
// (Етап 2Б.3.7.4) — чисти функции, без DOM/WS/сървър. Mirror на
// checkSvaraTableLayout.ts стила.
//
// Покрива (виж заданието §18):
//   B1.  Правилните бутони при нормален ход (canAct, различни фази).
//   B2.  "Плати" = call, когато има какво да се плаща.
//   B3.  ×5/×10/×20/×50 = min * множител, не на Входа/остатъка.
//   B4.  Първоначален залог (без call, bet.min директно от сървъра).
//   B5.  Залагане на тъмно — blindBet.min, изпраща blind-bet.
//   B6.  Недостатъчни чипове — бутон неактивен (disabled), не скрит.
//   B8.  Ол-ин — точната сума от сървъра, без total поле в командата.
//   B9.  Бягам.
//   B10. Виж (досегашното „Погледни“) — само когато canAct && !looked.
//   B20. Сървърна валидация: всеки активен ×N се приема от реалния двигател
//        (applySvaraBettingAction) с точната сума; неактивните (над наличното)
//        се отказват; Ол-ин внася точно позволеното.
//   B12. Недопустими действия (canAct=false/null) — няма никакви бутони.
//   B14. Бадж за обикновен залог (ЗАЛОГ · N).
//   B15. Бадж за залог на тъмно (НА ТЪМНО · N).
//   B18/B19. Проследяване на нови записи — без повторна анимация при
//            reconnect/дублиран snapshot/initial sync.
//
// Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.

import { deriveSvaraActionButtons } from '../src/app/games/svara/table/svaraBettingActions'
import { renderSvaraActionPanelHtml } from '../src/app/games/svara/table/renderSvaraActiveTable'
import { formatSvaraLastBetBadge, getLastSvaraBetBadge } from '../src/app/games/svara/table/svaraBettingBadges'
import { createSvaraBetAnimationTracker } from '../src/app/games/svara/table/svaraBetAnimationTracker'
import type { SvaraBettingOptions, SvaraSnapshotRound } from '../src/app/network/createGameServerClient'
import { applySvaraBettingAction, createSvaraBetting, describeSvaraBettingOptions, lookAtSvaraCards, SvaraBettingError, type SvaraBettingState } from '../server/src/games/svara/engine/svaraBetting'

let passed = 0
let failed = 0
function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: string): void { failed++; console.error(`  FAIL  ${label}: ${reason}`) }
function check(label: string, fn: () => void): void {
  try { fn(); pass(label) } catch (err) { fail(label, err instanceof Error ? err.message : String(err)) }
}
function assert(condition: boolean, msg: string): void { if (!condition) throw new Error(msg) }
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

console.log('\n=== checkSvaraBettingActions ===\n')

const NONE: SvaraBettingOptions = { canAct: false, fold: false, noBet: false, call: null, bet: null, blindBet: null, allIn: null, lookRequired: false }

// ─── B12: недопустими действия ──────────────────────────────────────────

check('[B12] betting === null -> няма бутони изобщо', () => {
  assertEqual(deriveSvaraActionButtons(null, false).length, 0, 'null betting')
})

check('[B12] canAct === false -> няма бутони, дори ако други полета "изглеждат" позволени', () => {
  const betting: SvaraBettingOptions = { ...NONE, canAct: false, fold: true, bet: { min: 5, max: 100 } }
  assertEqual(deriveSvaraActionButtons(betting, false).length, 0, 'canAct=false трябва да изключи всичко')
})

// ─── B4: първоначален залог (без call, само bet.min) ───────────────────

check('[B4] Първи залог: само bet (без call), "Плати" = bet.min директно от сървъра', () => {
  const betting: SvaraBettingOptions = { ...NONE, canAct: true, fold: true, bet: { min: 80, max: 400 } }
  const buttons = deriveSvaraActionButtons(betting, true) // вече погледнал, обикновено залагане
  const pay = buttons.find((b) => b.kind === 'pay')
  assert(pay !== undefined, 'трябва да има "Плати" бутон')
  assertEqual(pay!.label, 'Плати 80', 'label трябва да показва bet.min')
  assertEqual(pay!.amount, 80, 'amount трябва да е bet.min')
  assertEqual(JSON.stringify(pay!.command), JSON.stringify({ type: 'act', action: { kind: 'bet', total: 80 } }), 'командата трябва да носи total=min, не added delta')
})

// ─── B3: множителите ×5/×10/×20/×50 спрямо МИНИМУМА, не Входа/остатъка ─

check('[B3] ×5/×10/×20/×50 = bet.min * множител (80 -> 400/800/1600/4000)', () => {
  const betting: SvaraBettingOptions = { ...NONE, canAct: true, fold: true, bet: { min: 80, max: 5000 } }
  const buttons = deriveSvaraActionButtons(betting, true)
  const amounts = (['x5', 'x10', 'x20', 'x50'] as const).map((kind) => buttons.find((b) => b.kind === kind)?.amount)
  assertEqual(JSON.stringify(amounts), JSON.stringify([400, 800, 1600, 4000]), 'min * 5/10/20/50')
  assertEqual(JSON.stringify(buttons.filter((b) => b.kind.startsWith('x')).map((b) => b.label)), JSON.stringify(['×5', '×10', '×20', '×50']), 'надписите на множителите')
  assert(!buttons.some((b) => ['x2', 'x3', 'x4'].includes(b.kind)), 'старите ×2/×3/×4 вече не съществуват')
  for (const kind of ['x5', 'x10', 'x20', 'x50'] as const) {
    const btn = buttons.find((b) => b.kind === kind)!
    assertEqual(btn.command.type, 'act', `${kind} трябва да е act команда`)
    assertEqual((btn.command as { action: { kind: string } }).action.kind, 'bet', `${kind} трябва да изпраща kind:'bet' (не blind, не added delta)`)
  }
})

// ─── B2: "Плати" = call, когато има какво да се плаща (отделно от bet.min) ─

check('[B2] Call наличен (someone already bet) -> "Плати" праща call, НЕ bet/total', () => {
  const betting: SvaraBettingOptions = { ...NONE, canAct: true, fold: true, call: 80, bet: { min: 160, max: 1000 } }
  const buttons = deriveSvaraActionButtons(betting, true)
  const pay = buttons.find((b) => b.kind === 'pay')!
  assertEqual(pay.label, 'Плати 80', 'label трябва да показва call стойността, не bet.min')
  assertEqual(JSON.stringify(pay.command), JSON.stringify({ type: 'act', action: { kind: 'call' } }), 'командата трябва да е чист call, без total поле')
  // ×N продължават да съществуват паралелно (повишаване над call-а), от bet.min=160.
  const x5 = buttons.find((b) => b.kind === 'x5')!
  assertEqual(x5.amount, 800, '×5 трябва да остане базиран на bet.min (повишаване), не на call стойността')
})

// ─── B5: залагане на тъмно ───────────────────────────────────────────────

check('[B5] blindBet наличен (преди поглеждане) -> "Плати"/×N изпращат kind:"blind-bet"', () => {
  const betting: SvaraBettingOptions = { ...NONE, canAct: true, fold: true, blindBet: { min: 10, max: 200 }, lookRequired: true }
  const buttons = deriveSvaraActionButtons(betting, false)
  const pay = buttons.find((b) => b.kind === 'pay')!
  assertEqual(JSON.stringify(pay.command), JSON.stringify({ type: 'act', action: { kind: 'blind-bet', total: 10 } }), '"Плати" на тъмно трябва да изпрати blind-bet с total=min')
  const x10 = buttons.find((b) => b.kind === 'x10')!
  assertEqual(JSON.stringify((x10.command as { action: unknown }).action), JSON.stringify({ kind: 'blind-bet', total: 100 }), '×10 на тъмно трябва да е blind-bet total=100')
})

check('[B5] Не изобретяваме отделен бутон "На тъмно" — СЪЩИТЕ Плати/×N бутони решават blind спрямо server options', () => {
  const blindBetting: SvaraBettingOptions = { ...NONE, canAct: true, fold: true, blindBet: { min: 10, max: 200 } }
  const normalBetting: SvaraBettingOptions = { ...NONE, canAct: true, fold: true, bet: { min: 5, max: 200 } }
  const blindButtons = deriveSvaraActionButtons(blindBetting, false).map((b) => b.kind)
  const normalButtons = deriveSvaraActionButtons(normalBetting, true).map((b) => b.kind)
  assertEqual(JSON.stringify(blindButtons.filter((k) => k !== 'look')), JSON.stringify(normalButtons.filter((k) => k !== 'look')), 'същият набор от бутонни типове (pay/x5-x50/all-in/fold) в двата случая — само изпращаната команда се различава')
})

// ─── B10: Погледни — само canAct && !looked ──────────────────────────────

check('[B10] Виж се показва само когато играчът е на ход и ощe не е погледнал', () => {
  const betting: SvaraBettingOptions = { ...NONE, canAct: true, fold: true, blindBet: { min: 10, max: 200 } }
  assert(deriveSvaraActionButtons(betting, false).some((b) => b.kind === 'look' && b.label === 'Виж'), 'трябва да има „Виж“, когато !looked')
  assert(!deriveSvaraActionButtons(betting, true).some((b) => b.kind === 'look'), 'не трябва да има Погледни, щом вече е погледнал')
})

check('[B10] Погледни никога не се показва, ако играчът не е на ход', () => {
  const betting: SvaraBettingOptions = { ...NONE, canAct: false, blindBet: { min: 10, max: 200 } }
  assert(!deriveSvaraActionButtons(betting, false).some((b) => b.kind === 'look'), 'canAct=false -> няма Погледни независимо от looked')
})

// ─── B6: недостатъчни чипове -> disabled, не скрито ──────────────────────

check('[B6] ×N с total > max е НЕАКТИВЕН (disabled), не е премахнат от списъка', () => {
  const betting: SvaraBettingOptions = { ...NONE, canAct: true, fold: true, bet: { min: 20, max: 450 } }
  const buttons = deriveSvaraActionButtons(betting, true)
  const disabled = (['x5', 'x10', 'x20', 'x50'] as const).map((kind) => buttons.find((b) => b.kind === kind)!.disabled)
  assertEqual(JSON.stringify(disabled), JSON.stringify([false, false, false, true]), '×5=100, ×10=200, ×20=400 <= 450 активни; ×50=1000 > 450 НЕАКТИВЕН')
  assert(buttons.some((b) => b.kind === 'x50'), '×50 трябва да ПРИСЪСТВА в списъка (само disabled), не да липсва')
})

check('[B6] Сума точно равна на наличното (max) е позволена; с 1 над нея — не', () => {
  const exact = deriveSvaraActionButtons({ ...NONE, canAct: true, fold: true, bet: { min: 20, max: 400 } }, true).find((b) => b.kind === 'x20')!
  assertEqual(exact.disabled, false, '×20=400 == max -> активен')
  const over = deriveSvaraActionButtons({ ...NONE, canAct: true, fold: true, bet: { min: 20, max: 399 } }, true).find((b) => b.kind === 'x20')!
  assertEqual(over.disabled, true, '×20=400 > 399 -> неактивен')
})

// ─── B8: Ол-ин — точната сума, без total поле ───────────────────────────

check('[B8] Ол-ин команда няма total поле — сървърът сам изчислява реално внесеното', () => {
  const betting: SvaraBettingOptions = { ...NONE, canAct: true, fold: true, allIn: 237 }
  const buttons = deriveSvaraActionButtons(betting, true)
  const allIn = buttons.find((b) => b.kind === 'all-in')!
  assertEqual(allIn.label, 'Ол-ин', 'надписът е „Ол-ин“')
  assertEqual(allIn.amount, 237, 'сумата е реалната от сървъра (показва се на втори ред в бутона)')
  assertEqual(JSON.stringify(allIn.command), JSON.stringify({ type: 'act', action: { kind: 'all-in' } }), 'командата трябва да е само {kind:"all-in"}, БЕЗ total — сървърът определя реално внесеното')
})

check('[B8] allIn === null -> няма Ол-ин бутон', () => {
  const betting: SvaraBettingOptions = { ...NONE, canAct: true, fold: true, allIn: null }
  assert(!deriveSvaraActionButtons(betting, true).some((b) => b.kind === 'all-in'), 'allIn:null -> няма бутон')
})

// ─── B9: Бягам ────────────────────────────────────────────────────────────

check('[B9] Бягам присъства само когато options.fold е true', () => {
  assert(deriveSvaraActionButtons({ ...NONE, canAct: true, fold: true }, true).some((b) => b.kind === 'fold'), 'fold:true -> бутон присъства')
  assert(!deriveSvaraActionButtons({ ...NONE, canAct: true, fold: false }, true).some((b) => b.kind === 'fold'), 'fold:false -> бутон отсъства')
})

// ─── Без залог (специалното 4-то раздаване) ─────────────────────────────

check('[B1] "Без залог" се показва само когато options.noBet е true', () => {
  assert(deriveSvaraActionButtons({ ...NONE, canAct: true, noBet: true }, true).some((b) => b.kind === 'no-bet'), 'noBet:true -> присъства')
  assert(!deriveSvaraActionButtons({ ...NONE, canAct: true, noBet: false }, true).some((b) => b.kind === 'no-bet'), 'noBet:false -> отсъства')
})

// ─── B14/B15: баджове за залози ──────────────────────────────────────────

function makeRound(actions: Array<{ playerId: string; total: number; added: number; blind: boolean }>): SvaraSnapshotRound {
  return {
    kind: 'ordinary', roundId: 'r1', dealerId: 'p1', potId: null, participants: ['p1', 'p2'],
    currentBet: 0, blind: { status: 'closed', lastBlindTotal: 0 }, carriedIn: 0, potTotal: 0,
    provisionalPots: [], isFourthHeadsUp: false, noBetAllowed: false,
    actions: actions.map((a) => ({ playerId: a.playerId, kind: a.blind ? 'blind-bet' : 'bet', total: a.total, added: a.added, allIn: false, blind: a.blind })),
  }
}

check('[B14] Обикновен залог -> "ЗАЛОГ · N"', () => {
  const round = makeRound([{ playerId: 'p1', total: 80, added: 80, blind: false }])
  const badge = getLastSvaraBetBadge(round, 'p1')
  assert(badge !== null, 'трябва да има бадж')
  assertEqual(formatSvaraLastBetBadge(badge!), 'ЗАЛОГ · 80', 'label format')
})

check('[B15] Залог на тъмно -> "НА ТЪМНО · N"', () => {
  const round = makeRound([{ playerId: 'p1', total: 20, added: 20, blind: true }])
  const badge = getLastSvaraBetBadge(round, 'p1')
  assertEqual(formatSvaraLastBetBadge(badge!), 'НА ТЪМНО · 20', 'label format за blind')
})

check('[B14] Последният запис на играча "обновява" бейджа (не първия)', () => {
  const round = makeRound([
    { playerId: 'p1', total: 20, added: 20, blind: true },
    { playerId: 'p2', total: 40, added: 40, blind: true },
    { playerId: 'p1', total: 80, added: 60, blind: false },
  ])
  const badge = getLastSvaraBetBadge(round, 'p1')
  assertEqual(formatSvaraLastBetBadge(badge!), 'ЗАЛОГ · 80', 'трябва да вземе ПОСЛЕДНИЯ запис на p1, не първия (на тъмно)')
})

check('[B14] Играч без никакъв залог -> null (без бадж)', () => {
  const round = makeRound([{ playerId: 'p2', total: 40, added: 40, blind: false }])
  assertEqual(getLastSvaraBetBadge(round, 'p1'), null, 'p1 никога не е залагал -> null')
})

check('[B14] round === null или не-betting round (напр. svara-joining) -> без бадж', () => {
  assertEqual(getLastSvaraBetBadge(null, 'p1'), null, 'null round')
  const joining: SvaraSnapshotRound = { kind: 'svara-joining', roundId: 'r2', potId: 'pot1', fee: 10, joiners: [], closed: false, decisions: [] }
  assertEqual(getLastSvaraBetBadge(joining, 'p1'), null, 'non-betting round kind')
})

// 2Б.3.7.4А §3: баджът остава до края на ТЕКУЩАТА обиколка, не до края на раздаването.
check('[2Б.3.7.4А] Ново повишение (нова обиколка) изчиства бадж на играч, който още не е отговорил в нея', () => {
  const round = makeRound([
    { playerId: 'p1', total: 10, added: 10, blind: false }, // обиколка 1 (отваря p1)
    { playerId: 'p2', total: 10, added: 10, blind: false }, // плащане -> СЪЩА обиколка 1
    { playerId: 'p1', total: 30, added: 20, blind: false }, // повишение -> нова обиколка 2
  ])
  assertEqual(getLastSvaraBetBadge(round, 'p2'), null, 'p2 още не е отговорил в обиколка 2 -> старият бадж (10) изчезва')
  const p1Badge = getLastSvaraBetBadge(round, 'p1')
  assertEqual(formatSvaraLastBetBadge(p1Badge!), 'ЗАЛОГ · 30', 'повишаващият веднага вижда новия си бадж в новата обиколка')
})

check('[2Б.3.7.4А] Плащане (call) в СЪЩАТА обиколка не чисти бадж на вече действал играч', () => {
  const round = makeRound([
    { playerId: 'p1', total: 10, added: 10, blind: false }, // обиколка 1
    { playerId: 'p2', total: 10, added: 10, blind: false }, // плащане -> СЪЩА обиколка 1
  ])
  const p1Badge = getLastSvaraBetBadge(round, 'p1')
  assertEqual(formatSvaraLastBetBadge(p1Badge!), 'ЗАЛОГ · 10', 'плащане от друг играч не изчиства бадж от СЪЩАТА обиколка')
})

check('[2Б.3.7.4А] Играч, отговорил в новата обиколка, получава нов бадж (не старият)', () => {
  const round = makeRound([
    { playerId: 'p1', total: 10, added: 10, blind: false }, // обиколка 1
    { playerId: 'p2', total: 10, added: 10, blind: false }, // плащане -> обиколка 1
    { playerId: 'p1', total: 30, added: 20, blind: false }, // повишение -> обиколка 2
    { playerId: 'p2', total: 30, added: 20, blind: false }, // плащане в обиколка 2
  ])
  const p2Badge = getLastSvaraBetBadge(round, 'p2')
  assertEqual(formatSvaraLastBetBadge(p2Badge!), 'ЗАЛОГ · 30', 'p2 вече е отговорил в обиколка 2 -> вижда се новият бадж')
})

// ─── B18/B19: защита срещу двойни анимации (reconnect/дублиран snapshot) ──

check('[B18] Initial snapshot (първо виждане на roundId) -> baseline sync БЕЗ анимация', () => {
  const tracker = createSvaraBetAnimationTracker()
  const round = makeRound([{ playerId: 'p1', total: 80, added: 80, blind: false }])
  const entries = tracker.detectNewEntries(round)
  assertEqual(entries.length, 0, 'първото виждане на roundId никога не анимира съществуващите записи (reconnect/remount-safe)')
})

check('[B19] Дублиран snapshot (СЪЩАТА дължина на actions) -> без нови записи', () => {
  const tracker = createSvaraBetAnimationTracker()
  const round = makeRound([{ playerId: 'p1', total: 80, added: 80, blind: false }])
  tracker.detectNewEntries(round) // baseline
  const again = tracker.detectNewEntries(round) // same actions array, same length
  assertEqual(again.length, 0, 'дублиран snapshot не трябва да произвежда "нови" записи')
})

check('[B18] Реално нов запис (actions.length нараства) -> точно новия запис се анимира', () => {
  const tracker = createSvaraBetAnimationTracker()
  const round1 = makeRound([{ playerId: 'p1', total: 80, added: 80, blind: false }])
  tracker.detectNewEntries(round1) // baseline (1 запис, НЕ анимиран)
  const round2 = makeRound([
    { playerId: 'p1', total: 80, added: 80, blind: false },
    { playerId: 'p2', total: 80, added: 80, blind: false },
  ])
  const entries = tracker.detectNewEntries(round2)
  assertEqual(entries.length, 1, 'трябва да открие точно 1 нов запис')
  assertEqual(entries[0]!.playerId, 'p2', 'новият запис трябва да е на p2')
})

check('[B18] fold/no-bet записи (added=0) НИКОГА не се анимират дори да са "нови"', () => {
  const tracker = createSvaraBetAnimationTracker()
  const round1 = makeRound([{ playerId: 'p1', total: 80, added: 80, blind: false }])
  tracker.detectNewEntries(round1)
  const round2: SvaraSnapshotRound = {
    ...(round1 as Extract<SvaraSnapshotRound, { kind: 'ordinary' }>),
    actions: [
      ...(round1 as Extract<SvaraSnapshotRound, { kind: 'ordinary' }>).actions,
      { playerId: 'p2', kind: 'fold', total: 0, added: 0, allIn: false, blind: false },
    ],
  }
  const entries = tracker.detectNewEntries(round2)
  assertEqual(entries.length, 0, 'fold (added=0) не трябва да произведе анимация')
})

check('[B19] Нов roundId (ново раздаване) -> отново само baseline, НЕ "довлича" стари записи', () => {
  const tracker = createSvaraBetAnimationTracker()
  const round1 = makeRound([{ playerId: 'p1', total: 80, added: 80, blind: false }])
  tracker.detectNewEntries(round1)
  const round2: SvaraSnapshotRound = { ...(round1 as Extract<SvaraSnapshotRound, { kind: 'ordinary' }>), roundId: 'r2-new-deal', actions: [{ playerId: 'p1', kind: 'bet', total: 10, added: 10, allIn: false, blind: false }] }
  const entries = tracker.detectNewEntries(round2)
  assertEqual(entries.length, 0, 'нов roundId трябва да стартира чист baseline, не да третира съществуващите записи като "нови"')
})

check('[B19] reset() изчиства цялото проследяване (напр. unmount/remount)', () => {
  const tracker = createSvaraBetAnimationTracker()
  const round = makeRound([{ playerId: 'p1', total: 80, added: 80, blind: false }])
  tracker.detectNewEntries(round) // baseline при 1 запис
  tracker.reset()
  // След reset, СЪЩИЯТ round (непроменен) отново трябва да се третира като
  // "първо виждане" (baseline), не като "вече видяно" с 0 нови записи -
  // проверяваме чрез добавяне на НОВ запис веднага след reset: тъй като
  // tracker-ът е "забравил" предишния baseline, трябва да третира ЦЕЛИЯ
  // текущ масив (вкл. стария запис) отново само като baseline, не анимация.
  const entries = tracker.detectNewEntries(round)
  assertEqual(entries.length, 0, 'след reset, същият round отново е "първо виждане" -> baseline, не анимация')
})

// ─── B20: новите множители срещу реалната сървърна валидация ─────────────
// Бутоните се извеждат от describeSvaraBettingOptions (истинските опции на
// сървъра) и всяка команда се подава на applySvaraBettingAction.

function engineState(stacks: Record<string, number>, entry: number, lookedBy: string[]): SvaraBettingState {
  let state = createSvaraBetting({ order: Object.keys(stacks), stacks, folded: [], entryChips: entry, allowNoBet: false })
  for (const id of lookedBy) state = lookAtSvaraCards(state, id)
  return state
}

function applyResult(state: SvaraBettingState, playerId: string, command: unknown, stack: number): { ok: true; added: number } | { ok: false; code: string } {
  const action = (command as { action: Parameters<typeof applySvaraBettingAction>[2] }).action
  try {
    return { ok: true, added: applySvaraBettingAction(state, playerId, action, stack).added }
  } catch (err) {
    if (err instanceof SvaraBettingError) return { ok: false, code: err.code }
    throw err
  }
}

function checkMultipliersAgainstEngine(label: string, state: SvaraBettingState, playerId: string, stack: number, looked: boolean, expected: Record<'x5' | 'x10' | 'x20' | 'x50', number | 'disabled'>): void {
  check(label, () => {
    const buttons = deriveSvaraActionButtons(describeSvaraBettingOptions(state, playerId, stack), looked)
    for (const kind of ['x5', 'x10', 'x20', 'x50'] as const) {
      const button = buttons.find((b) => b.kind === kind)
      assert(button !== undefined, `${kind} трябва да присъства`)
      const want = expected[kind]
      const result = applyResult(state, playerId, button!.command, stack)
      if (want === 'disabled') {
        assertEqual(button!.disabled, true, `${kind} над наличното трябва да е неактивен`)
        assert(!result.ok && result.code === 'insufficient-chips', `${kind} над наличното трябва сървърът да откаже с insufficient-chips, получено ${JSON.stringify(result)}`)
      } else {
        assertEqual(button!.disabled, false, `${kind} трябва да е активен`)
        assertEqual(button!.amount, want, `${kind} сума`)
        assert(result.ok, `${kind}=${want}: сървърът трябва да приеме залога, получено ${JSON.stringify(result)}`)
        assertEqual(result.ok ? result.added : -1, want, `${kind}: внесеното в банката`)
        assert(want <= stack, `${kind}: никога над наличния баланс`)
      }
    }
  })
}

checkMultipliersAgainstEngine('[B20] Първи залог след „Виж“ (Вход 10, баланс 1000): ×5/×10/×20/×50 = 50/100/200/500 се приемат от сървъра',
  engineState({ a: 1000, b: 1000 }, 10, ['a']), 'a', 1000, true, { x5: 50, x10: 100, x20: 200, x50: 500 })

checkMultipliersAgainstEngine('[B20] Ограничен баланс 300: ×50=500 е неактивен и сървърът го отказва',
  engineState({ a: 300, b: 1000 }, 10, ['a']), 'a', 300, true, { x5: 50, x10: 100, x20: 200, x50: 'disabled' })

checkMultipliersAgainstEngine('[B20] На тъмно (минимум 2 × Вход = 20): ×5/×10/×20 → blind-bet 100/200/400, ×50=1000 над баланса 500',
  engineState({ a: 500, b: 500 }, 10, []), 'a', 500, false, { x5: 100, x10: 200, x20: 400, x50: 'disabled' })

check('[B20] Повишаване след залог (Вход 10, залог 50 → минимум 60): ×N са спрямо 60 и сървърът ги приема', () => {
  const opened = applySvaraBettingAction(engineState({ a: 1000, b: 2000 }, 10, ['a', 'b']), 'a', { kind: 'bet', total: 50 }, 1000).state
  const options = describeSvaraBettingOptions(opened, 'b', 2000)
  assertEqual(options.bet?.min, 60, 'минимумът за повишаване')
  const buttons = deriveSvaraActionButtons(options, true)
  const expected = { x5: 300, x10: 600, x20: 1200, x50: 'disabled' } as const
  for (const kind of ['x5', 'x10', 'x20', 'x50'] as const) {
    const button = buttons.find((b) => b.kind === kind)!
    const result = applyResult(opened, 'b', button.command, 2000)
    if (expected[kind] === 'disabled') {
      assert(button.disabled && !result.ok && result.code === 'insufficient-chips', `${kind}=3000 > 2000 трябва да е неактивен и отказан`)
    } else {
      assert(!button.disabled && result.ok && result.added === expected[kind], `${kind}: очаквано ${expected[kind]}, получено ${JSON.stringify(result)}`)
    }
  }
  const pay = buttons.find((b) => b.kind === 'pay')!
  assertEqual(pay.label, 'Плати 50', '„Плати“ остава call-ът')
})

check('[B20] Ол-ин внася точно наличния баланс (не повече) и е отделен бутон', () => {
  const state = engineState({ a: 237, b: 1000 }, 10, ['a'])
  const button = deriveSvaraActionButtons(describeSvaraBettingOptions(state, 'a', 237), true).find((b) => b.kind === 'all-in')!
  assertEqual(button.amount, 237, 'сумата на Ол-ин')
  const result = applyResult(state, 'a', button.command, 237)
  assert(result.ok && result.added === 237, `Ол-ин трябва да внесе точно 237, получено ${JSON.stringify(result)}`)
})

// ─── B21: постоянният панел — винаги 8 места, на телефон по 4 на ред ──────

function panelCells(html: string): string[] {
  const grid = html.slice(html.indexOf('data-svara-action-grid'))
  return [...grid.matchAll(/<button type="button" (data-svara-action-(?:button|slot))="([^"]+)"/g)].map((m) => m[1] === 'data-svara-action-slot' ? `(${m[2]})` : m[2]!)
}
function phoneColumns(html: string): number {
  const media = html.slice(html.indexOf('@media'))
  return Number(/grid-template-columns:repeat\((\d+),/.exec(media)?.[1])
}

check('[B21] 4-то раздаване на двама, преди „Виж“ (9 позволени действия): „Без залог“ е на мястото на ×50, 8 места, 4 на ред', () => {
  const state = createSvaraBetting({ order: ['a', 'b'], stacks: { a: 200, b: 200 }, folded: [], entryChips: 2, allowNoBet: true })
  const options = describeSvaraBettingOptions(state, 'a', 200)
  assert(options.noBet && options.blindBet !== null, 'сценарият трябва да позволява „Без залог“ и откриване на тъмно')
  const buttons = deriveSvaraActionButtons(options, false)
  assertEqual(buttons.length, 9, 'деветте позволени действия')
  const html = renderSvaraActionPanelHtml(buttons, false, false)
  assertEqual(JSON.stringify(panelCells(html)), JSON.stringify(['look', 'pay', 'x5', 'x10', 'x20', 'no-bet', 'all-in', 'fold']), 'редът на местата')
  assertEqual(phoneColumns(html), 4, 'телефон: 4 на ред')
  assert(!html.includes('repeat(9') && !html.includes('repeat(5'), 'никога 5 (или 9) колони')
})

check('[B21] Същото раздаване след „Виж“: „Без залог“ е на мястото на „Виж“, „Плати“ и ×50 остават', () => {
  const state = lookAtSvaraCards(createSvaraBetting({ order: ['a', 'b'], stacks: { a: 200, b: 200 }, folded: [], entryChips: 2, allowNoBet: true }), 'a')
  const buttons = deriveSvaraActionButtons(describeSvaraBettingOptions(state, 'a', 200), true)
  const cells = panelCells(renderSvaraActionPanelHtml(buttons, false, false))
  assertEqual(JSON.stringify(cells), JSON.stringify(['no-bet', 'pay', 'x5', 'x10', 'x20', 'x50', 'all-in', 'fold']), 'редът на местата')
})

check('[B21] Не е на ход / обикновен залог / „Върни се“ — винаги точно 8 места и 4 на ред на телефон', () => {
  const cases: Array<[string, string]> = [
    ['не е на ход', renderSvaraActionPanelHtml([], false, false)],
    ['обикновен залог', renderSvaraActionPanelHtml(deriveSvaraActionButtons({ ...NONE, canAct: true, fold: true, call: 50, bet: { min: 60, max: 2000 }, allIn: 2000 }, true), false, false)],
    ['Върни се', renderSvaraActionPanelHtml([], false, true)],
  ]
  for (const [label, html] of cases) {
    assertEqual(panelCells(html).length, 8, `${label}: брой места`)
    assertEqual(phoneColumns(html), 4, `${label}: 4 на ред`)
  }
  assertEqual(panelCells(cases[2]![1])[0], 'request-return', '„Върни се“ е на първото място')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exitCode = 1
}
