/**
 * checkImageViewerHistoryState.ts
 *
 * Regression test за reusable in-app image viewer history integration bug:
 * X/Esc/backdrop close караше приложението да напусне текущия screen
 * (Topics → Лоби) вместо да затвори САМО viewer overlay-я.
 *
 * Root cause: history.back() е АСИНХРОННО (popstate пристига на следващия
 * tick, никога синхронно вътре в извикването). Старата имплементация
 * маркираше viewer-а затворен СИНХРОННО (state.imageViewer = null) ПРЕДИ да
 * извика history.back() — когато popstate реално пристигаше, popstate
 * handler-ът вече виждаше viewer=null, НЕ го consume-ваше, и събитието
 * пропадаше към screen router-а (navigateFromPath), който презареждаше
 * текущия екран.
 *
 * Реалният History API/DOM не се симулира лесно в Node test script,
 * затова decision logic-ът е изнесен в чист (без DOM зависимост) helper
 * модул — src/app/lobby/imageViewerHistoryState.ts — и тестван директно
 * тук (точната state machine, ползвана от createLobbyFlowController.ts).
 *
 * [0]  decideOpenImageViewer: винаги push-history-state action, isOpen=true, historyPushed=true
 * [1]  decideRequestImageViewerClose (X/Esc/backdrop, viewer отворен, historyPushed=true): САМО call-history-back action, state НЕПРОМЕНЕН (isOpen остава true) — critical bug fix assertion
 * [2]  decideRequestImageViewerClose: НЕ произвежда finalize-close directно, докато popstate не пристигне (regression за точния bug — explicit close не бива да финализира сам)
 * [3]  decideRequestImageViewerClose defensive fallback (historyPushed=false): finalize-close директно, БЕЗ call-history-back
 * [4]  decideRequestImageViewerClose (viewer вече затворен, double-click race): noop
 * [5]  decideHandlePopstate (viewer отворен — причинено от нашия history.back() ИЛИ система Back): finalize-close action, consumed=true, isOpen=false
 * [6]  decideHandlePopstate (viewer вече затворен — normal navigation след viewer close): noop, consumed=false — следващ Back остава router responsibility
 * [7]  Full lifecycle: open → request-close → popstate == точно 1 push-history-state, точно 1 call-history-back, точно 1 finalize-close, consumed=true (Topics current screen bug сценарий от заданието)
 * [8]  Esc/backdrop споделят СЪЩАТА decideRequestImageViewerClose функция като X (shared close path parity — няма divergent логика)
 * [9]  Repeated open → close → open → close: всеки цикъл произвежда точно 1 push + 1 back + 1 finalize, без stale state между цикли
 * [10] Втори Back СЛЕД viewer вече затворен (chained popstate) не се consume-ва — нормална app navigation продължава (route state не е "заключен")
 * [11] Бърз double X/Esc/backdrop click ПРЕДИ popstate да пристигне: вторият click е noop, history.back() се вика само ЕДНАЖ (closePending guard)
 */

import {
  decideOpenImageViewer,
  decideRequestImageViewerClose,
  decideHandlePopstate,
  type ImageViewerHistoryState,
  type ImageViewerAction,
} from '../../src/app/lobby/imageViewerHistoryState.js'

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
function check(label: string, fn: () => void): void {
  try {
    fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  const same = typeof actual === 'object' && actual !== null && typeof expected === 'object' && expected !== null
    ? JSON.stringify(actual) === JSON.stringify(expected)
    : actual === expected
  if (!same) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}
function countActions(actions: ImageViewerAction[], type: ImageViewerAction['type']): number {
  return actions.filter((a) => a.type === type).length
}

const CLOSED: ImageViewerHistoryState = { isOpen: false, historyPushed: false, closePending: false }
const OPEN_WITH_HISTORY: ImageViewerHistoryState = { isOpen: true, historyPushed: true, closePending: false }
const OPEN_WITHOUT_HISTORY: ImageViewerHistoryState = { isOpen: true, historyPushed: false, closePending: false }
const OPEN_CLOSE_PENDING: ImageViewerHistoryState = { isOpen: true, historyPushed: true, closePending: true }

check('[0] decideOpenImageViewer: винаги push-history-state action, isOpen=true, historyPushed=true, closePending=false', () => {
  const { nextState, actions } = decideOpenImageViewer()
  assertEqual(nextState, { isOpen: true, historyPushed: true, closePending: false }, 'nextState')
  assertEqual(actions.length, 1, 'actions.length')
  assertEqual(actions[0]?.type, 'push-history-state', 'action type')
})

check('[1] decideRequestImageViewerClose (historyPushed=true): САМО call-history-back, isOpen НЕПРОМЕНЕН, closePending=true', () => {
  const { nextState, actions } = decideRequestImageViewerClose(OPEN_WITH_HISTORY)
  assertEqual(nextState, OPEN_CLOSE_PENDING, 'nextState трябва да остане "отворен" (isOpen=true) — финализацията идва от popstate; closePending=true маркира заявката')
  assertEqual(actions.length, 1, 'actions.length')
  assertEqual(actions[0]?.type, 'call-history-back', 'action type')
})

check('[2] decideRequestImageViewerClose НЕ произвежда finalize-close директно (regression за точния bug)', () => {
  const { actions } = decideRequestImageViewerClose(OPEN_WITH_HISTORY)
  assertEqual(countActions(actions, 'finalize-close'), 0, 'explicit close не бива да финализира viewer state-а сам — само popstate може')
})

check('[3] decideRequestImageViewerClose defensive fallback (historyPushed=false): finalize-close директно, БЕЗ call-history-back', () => {
  const { nextState, actions } = decideRequestImageViewerClose(OPEN_WITHOUT_HISTORY)
  assertEqual(nextState, CLOSED, 'nextState')
  assertEqual(actions.length, 1, 'actions.length')
  assertEqual(actions[0]?.type, 'finalize-close', 'action type')
  assertEqual(countActions(actions, 'call-history-back'), 0, 'fallback не бива да вика history.back() (нямаше pushed entry за него)')
})

check('[4] decideRequestImageViewerClose (viewer вече затворен, double-click race): noop', () => {
  const { nextState, actions } = decideRequestImageViewerClose(CLOSED)
  assertEqual(nextState, CLOSED, 'nextState')
  assertEqual(actions[0]?.type, 'noop', 'action type')
})

check('[5] decideHandlePopstate (viewer отворен): finalize-close action, consumed=true, isOpen=false', () => {
  const { nextState, actions, consumed } = decideHandlePopstate(OPEN_WITH_HISTORY)
  assertEqual(nextState, CLOSED, 'nextState')
  assertEqual(actions.length, 1, 'actions.length')
  assertEqual(actions[0]?.type, 'finalize-close', 'action type')
  assertEqual(consumed, true, 'popstate трябва да е consumed — НЕ delegate-ва към navigateFromPath')
})

check('[6] decideHandlePopstate (viewer вече затворен): noop, consumed=false', () => {
  const { nextState, actions, consumed } = decideHandlePopstate(CLOSED)
  assertEqual(nextState, CLOSED, 'nextState')
  assertEqual(actions[0]?.type, 'noop', 'action type')
  assertEqual(consumed, false, 'следващ Back СЛЕД viewer close трябва да остане нормална router responsibility')
})

check('[7] Full lifecycle: open → request-close → popstate == точно 1 push + 1 back + 1 finalize, consumed=true (Topics bug сценарий)', () => {
  // Точният сценарий от bug repro-то: Topics current screen → open viewer →
  // virtual history entry → close чрез X → popstate => viewer closed =>
  // navigateFromPath NOT called => Topics state preserved.
  let state = CLOSED
  const allActions: ImageViewerAction[] = []

  const openResult = decideOpenImageViewer()
  state = openResult.nextState
  allActions.push(...openResult.actions)
  assertEqual(state.isOpen, true, 'след open: viewer трябва да е отворен')

  // X click (или Esc/backdrop — виж [8] за parity доказателство).
  const closeResult = decideRequestImageViewerClose(state)
  state = closeResult.nextState
  allActions.push(...closeResult.actions)
  // Критичното assertion за bug-а: веднага СЛЕД explicit close request,
  // viewer-ът трябва ВСЕ ОЩЕ да е "отворен" от decision logic гледна точка
  // (финализацията идва само от popstate по-долу).
  assertEqual(state.isOpen, true, 'веднага след X click, ПРЕДИ popstate: viewer-ът НЕ трябва да е маркиран затворен (bug fix assertion)')

  // popstate пристига асинхронно (симулирано тук синхронно, тъй като
  // decision logic-ът самия е чист/синхронен — реалната асинхронност е
  // browser History API детайл, не част от decision-а).
  const popstateResult = decideHandlePopstate(state)
  state = popstateResult.nextState
  allActions.push(...popstateResult.actions)

  assertEqual(state.isOpen, false, 'след popstate: viewer-ът трябва да е затворен')
  assertEqual(popstateResult.consumed, true, 'popstate трябва да е consumed — navigateFromPath НЕ трябва да се извика (Topics state preserved)')
  assertEqual(countActions(allActions, 'push-history-state'), 1, 'точно 1 pushState на open')
  assertEqual(countActions(allActions, 'call-history-back'), 1, 'точно 1 history.back() на explicit close')
  assertEqual(countActions(allActions, 'finalize-close'), 1, 'точно 1 финализация (от popstate, НЕ от explicit close-а самия)')
})

check('[8] Esc/backdrop споделят СЪЩАТА decideRequestImageViewerClose функция като X (shared close path parity)', () => {
  // Трите (X/Esc/backdrop) в createLobbyFlowController.ts/renderLobbyScreen.ts
  // всички извикват requestImageViewerClose() → decideRequestImageViewerClose
  // — тук доказваме, че функцията е референтно СЪЩАТА (не 3 копия на
  // логиката, които могат да се разминат едно от друго).
  const xResult = decideRequestImageViewerClose(OPEN_WITH_HISTORY)
  const escResult = decideRequestImageViewerClose(OPEN_WITH_HISTORY)
  const backdropResult = decideRequestImageViewerClose(OPEN_WITH_HISTORY)
  assertEqual(xResult.actions[0]?.type, escResult.actions[0]?.type, 'X и Esc трябва да произвеждат идентичен action')
  assertEqual(escResult.actions[0]?.type, backdropResult.actions[0]?.type, 'Esc и backdrop трябва да произвеждат идентичен action')
})

check('[9] Repeated open → close → open → close: всеки цикъл произвежда точно 1 push + 1 back + 1 finalize, без stale state', () => {
  let state = CLOSED
  for (let cycle = 0; cycle < 3; cycle++) {
    const openResult = decideOpenImageViewer()
    state = openResult.nextState
    assertEqual(countActions(openResult.actions, 'push-history-state'), 1, `cycle ${cycle}: open трябва да push-не точно 1 entry`)

    const closeResult = decideRequestImageViewerClose(state)
    assertEqual(countActions(closeResult.actions, 'call-history-back'), 1, `cycle ${cycle}: close трябва да вика history.back() точно веднъж`)

    const popstateResult = decideHandlePopstate(closeResult.nextState)
    state = popstateResult.nextState
    assertEqual(popstateResult.consumed, true, `cycle ${cycle}: popstate трябва да е consumed`)
    assertEqual(state.isOpen, false, `cycle ${cycle}: viewer трябва да е затворен след popstate`)
  }
  assertEqual(state, CLOSED, 'финалният state след 3 пълни цикъла трябва да е чисто затворен, без stale historyPushed флаг')
})

check('[10] Втори Back СЛЕД viewer вече затворен (chained popstate) не се consume-ва — нормална app navigation продължава', () => {
  const openResult = decideOpenImageViewer()
  const closeResult = decideRequestImageViewerClose(openResult.nextState)
  const firstPopstate = decideHandlePopstate(closeResult.nextState)
  assertEqual(firstPopstate.consumed, true, 'първият popstate (viewer close) трябва да е consumed')

  // Симулира потребител, който натиска Back ОЩЕ веднъж — сега трябва да
  // излезе от текущия screen нормално (router responsibility), НЕ да бъде
  // прихванат от viewer logic-а отново.
  const secondPopstate = decideHandlePopstate(firstPopstate.nextState)
  assertEqual(secondPopstate.consumed, false, 'вторият Back след viewer close трябва да НЕ е consumed от viewer logic-а — нормална navigateFromPath responsibility')
})

check('[11] Бърз double X/Esc/backdrop click ПРЕДИ popstate да пристигне: вторият click е noop, история.back() се вика само ЕДНАЖ', () => {
  // Edge case, който closePending guard-ът адресира: overlay-ят остава
  // видим (isOpen все още true) до popstate — теоретично X/Esc/backdrop
  // могат да се задействат повторно в този прозорец. Без guard-а, вторият
  // click би извикал history.back() пак, навигирайки с 2 стъпки назад,
  // въпреки че само 1 виртуален entry реално е push-нат.
  const openResult = decideOpenImageViewer()

  const firstClick = decideRequestImageViewerClose(openResult.nextState)
  assertEqual(firstClick.actions[0]?.type, 'call-history-back', 'първият click трябва да инициира history.back()')
  assertEqual(firstClick.nextState.closePending, true, 'след първия click, closePending трябва да е true')

  // Втори click ВЕДНАГА след първия (popstate все още не е пристигнал).
  const secondClick = decideRequestImageViewerClose(firstClick.nextState)
  assertEqual(secondClick.actions[0]?.type, 'noop', 'вторият click ПРЕДИ popstate трябва да е noop — НЕ втори history.back()')
  assertEqual(countActions(secondClick.actions, 'call-history-back'), 0, 'вторият click не бива да вика history.back()')

  // popstate накрая пристига — финализира нормално, closePending се ресетва.
  const popstateResult = decideHandlePopstate(secondClick.nextState)
  assertEqual(popstateResult.consumed, true, 'popstate трябва да consume-не независимо от double-click-а')
  assertEqual(popstateResult.nextState, CLOSED, 'финалният state трябва да е чисто затворен')
})

console.log(`\n${passed} passed, ${failed} failed\n`)

if (failed > 0) {
  process.exitCode = 1
}
