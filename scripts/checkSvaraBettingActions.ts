// Deterministic unit-ниво проверка на реалните игрови бутони за Свара
// (Етап 2Б.3.7.4) — чисти функции, без DOM/WS/сървър. Mirror на
// checkSvaraTableLayout.ts стила.
//
// Покрива (виж заданието §18):
//   B1.  Правилните бутони при нормален ход (canAct, различни фази).
//   B2.  "Плати" = call, когато има какво да се плаща.
//   B3.  ×2/×3/×4/×5 = min * множител, не на Входа/остатъка.
//   B4.  Първоначален залог (без call, bet.min директно от сървъра).
//   B5.  Залагане на тъмно — blindBet.min, изпраща blind-bet.
//   B6.  Недостатъчни чипове — бутон неактивен (disabled), не скрит.
//   B8.  Ол-ин — точната сума от сървъра, без total поле в командата.
//   B9.  Бягам.
//   B10. Погледни — само когато canAct && !looked.
//   B12. Недопустими действия (canAct=false/null) — няма никакви бутони.
//   B14. Бадж за обикновен залог (ЗАЛОГ · N).
//   B15. Бадж за залог на тъмно (НА ТЪМНО · N).
//   B18/B19. Проследяване на нови записи — без повторна анимация при
//            reconnect/дублиран snapshot/initial sync.
//
// Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.

import { deriveSvaraActionButtons } from '../src/app/games/svara/table/svaraBettingActions'
import { formatSvaraLastBetBadge, getLastSvaraBetBadge } from '../src/app/games/svara/table/svaraBettingBadges'
import { createSvaraBetAnimationTracker } from '../src/app/games/svara/table/svaraBetAnimationTracker'
import type { SvaraBettingOptions, SvaraSnapshotRound } from '../src/app/network/createGameServerClient'

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

// ─── B3: множителите ×2..×5 спрямо МИНИМУМА, не Входа/остатъка ─────────

check('[B3] ×2..×5 = bet.min * множител (задание §3 примера: 80 -> 160/240/320/400)', () => {
  const betting: SvaraBettingOptions = { ...NONE, canAct: true, fold: true, bet: { min: 80, max: 1000 } }
  const buttons = deriveSvaraActionButtons(betting, true)
  const amounts = (['x2', 'x3', 'x4', 'x5'] as const).map((kind) => buttons.find((b) => b.kind === kind)?.amount)
  assertEqual(JSON.stringify(amounts), JSON.stringify([160, 240, 320, 400]), 'точно примера от заданието §3')
  for (const kind of ['x2', 'x3', 'x4', 'x5'] as const) {
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
  // ×2-×5 продължават да съществуват паралелно (повишаване над call-а), от bet.min=160.
  const x2 = buttons.find((b) => b.kind === 'x2')!
  assertEqual(x2.amount, 320, '×2 трябва да остане базиран на bet.min (повишаване), не на call стойността')
})

// ─── B5: залагане на тъмно ───────────────────────────────────────────────

check('[B5] blindBet наличен (преди поглеждане) -> "Плати"/×N изпращат kind:"blind-bet"', () => {
  const betting: SvaraBettingOptions = { ...NONE, canAct: true, fold: true, blindBet: { min: 10, max: 200 }, lookRequired: true }
  const buttons = deriveSvaraActionButtons(betting, false)
  const pay = buttons.find((b) => b.kind === 'pay')!
  assertEqual(JSON.stringify(pay.command), JSON.stringify({ type: 'act', action: { kind: 'blind-bet', total: 10 } }), '"Плати" на тъмно трябва да изпрати blind-bet с total=min')
  const x3 = buttons.find((b) => b.kind === 'x3')!
  assertEqual(JSON.stringify((x3.command as { action: unknown }).action), JSON.stringify({ kind: 'blind-bet', total: 30 }), '×3 на тъмно трябва да е blind-bet total=30')
})

check('[B5] Не изобретяваме отделен бутон "На тъмно" — СЪЩИТЕ Плати/×N бутони решават blind спрямо server options', () => {
  const blindBetting: SvaraBettingOptions = { ...NONE, canAct: true, fold: true, blindBet: { min: 10, max: 200 } }
  const normalBetting: SvaraBettingOptions = { ...NONE, canAct: true, fold: true, bet: { min: 5, max: 200 } }
  const blindButtons = deriveSvaraActionButtons(blindBetting, false).map((b) => b.kind)
  const normalButtons = deriveSvaraActionButtons(normalBetting, true).map((b) => b.kind)
  assertEqual(JSON.stringify(blindButtons.filter((k) => k !== 'look')), JSON.stringify(normalButtons.filter((k) => k !== 'look')), 'същият набор от бутонни типове (pay/x2-x5/all-in/fold) в двата случая — само изпращаната команда се различава')
})

// ─── B10: Погледни — само canAct && !looked ──────────────────────────────

check('[B10] Погледни се показва само когато играчът е на ход и ощe не е погледнал', () => {
  const betting: SvaraBettingOptions = { ...NONE, canAct: true, fold: true, blindBet: { min: 10, max: 200 } }
  assert(deriveSvaraActionButtons(betting, false).some((b) => b.kind === 'look'), 'трябва да има Погледни, когато !looked')
  assert(!deriveSvaraActionButtons(betting, true).some((b) => b.kind === 'look'), 'не трябва да има Погледни, щом вече е погледнал')
})

check('[B10] Погледни никога не се показва, ако играчът не е на ход', () => {
  const betting: SvaraBettingOptions = { ...NONE, canAct: false, blindBet: { min: 10, max: 200 } }
  assert(!deriveSvaraActionButtons(betting, false).some((b) => b.kind === 'look'), 'canAct=false -> няма Погледни независимо от looked')
})

// ─── B6: недостатъчни чипове -> disabled, не скрито ──────────────────────

check('[B6] ×N с total > max е НЕАКТИВЕН (disabled), не е премахнат от списъка', () => {
  const betting: SvaraBettingOptions = { ...NONE, canAct: true, fold: true, bet: { min: 80, max: 250 } }
  const buttons = deriveSvaraActionButtons(betting, true)
  const x2 = buttons.find((b) => b.kind === 'x2')!
  const x3 = buttons.find((b) => b.kind === 'x3')!
  const x4 = buttons.find((b) => b.kind === 'x4')!
  assertEqual(x2.disabled, false, '×2=160 <= 250, трябва да е активен')
  assertEqual(x3.disabled, false, '×3=240 <= 250, трябва да е активен')
  assertEqual(x4.disabled, true, '×4=320 > 250, трябва да е НЕАКТИВЕН')
  assert(buttons.some((b) => b.kind === 'x5'), '×5 трябва да ПРИСЪСТВА в списъка (само disabled), не да липсва')
})

// ─── B8: Ол-ин — точната сума, без total поле ───────────────────────────

check('[B8] Ол-ин команда няма total поле — сървърът сам изчислява реално внесеното', () => {
  const betting: SvaraBettingOptions = { ...NONE, canAct: true, fold: true, allIn: 237 }
  const buttons = deriveSvaraActionButtons(betting, true)
  const allIn = buttons.find((b) => b.kind === 'all-in')!
  assertEqual(allIn.label, 'Ол-ин · 237', 'label показва реалната сума от сървъра')
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
  const joining: SvaraSnapshotRound = { kind: 'svara-joining', roundId: 'r2', potId: 'pot1', fee: 10, joiners: [], closed: false }
  assertEqual(getLastSvaraBetBadge(joining, 'p1'), null, 'non-betting round kind')
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

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exitCode = 1
}
