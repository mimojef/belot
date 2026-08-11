// Pure decision logic за reusable in-app image viewer history integration
// (виж createLobbyFlowController.ts openImageViewer/requestImageViewerClose/
// handleWindowPopstate) — изнесено тук, за да е testable без реален DOM/
// History API (browser-only, не се симулира лесно в Node test scripts).
//
// КРИТИЧЕН INVARIANT (bug fix): history.back() е АСИНХРОННО — popstate
// пристига на следващия tick, никога синхронно вътре в извикването. Затова
// explicit close (X/Esc/backdrop) НЕ бива да маха viewer state-а синхронно
// преди history.back() — ако го направи, popstate handler-ът вижда viewer
// вече затворен, НЕ го consume-ва, и събитието пропада към screen router-а
// (презарежда текущия екран — Topics thread/scroll/subscription state се
// губи). Fix: history pop е ЕДИНСТВЕНОТО място, което финализира
// затварянето — explicit close само инициира history.back().

export type ImageViewerHistoryState = {
  isOpen: boolean
  historyPushed: boolean
  /**
   * True от момента на ПЪРВОТО explicit close request (X/Esc/backdrop) до
   * момента, в който popstate реално пристигне и финализира затварянето.
   * Guard срещу double history.back(): overlay-ят остава видим (isOpen все
   * още true) през целия този прозорец, значи X/Esc/backdrop технически
   * могат да се задействат повторно (напр. бърз double-click) ПРЕДИ
   * асинхронния popstate да пристигне — без този флаг всеки повторен click
   * би извикал history.back() пак, навигирайки с повече стъпки назад,
   * отколкото виртуални entries реално са push-нати.
   */
  closePending: boolean
}

export type ImageViewerAction =
  | { type: 'push-history-state' }
  | { type: 'call-history-back' }
  | { type: 'finalize-close' }
  | { type: 'noop' }

/** Отваряне: винаги push-ва виртуален history entry + маркира viewer-а отворен. */
export function decideOpenImageViewer(): {
  nextState: ImageViewerHistoryState
  actions: ImageViewerAction[]
} {
  return {
    nextState: { isOpen: true, historyPushed: true, closePending: false },
    actions: [{ type: 'push-history-state' }],
  }
}

/**
 * Explicit close заявка (X/Esc/backdrop click) — единна decision точка за
 * трите. Ако viewer-ът вече е затворен (defensive race) → no-op. Ако
 * затварянето вече е поискано и чака popstate (closePending=true —
 * double-click преди асинхронния popstate да пристигне) → no-op, НЕ вика
 * history.back() повторно. Ако има виртуален history entry (нормален flow,
 * първо close request) → само инициира history.back(), state-ът маркира
 * closePending=true, viewer-ът остава "отворен" до popstate (виж
 * invariant-а по-горе). Defensive fallback (historyPushed=false — не би
 * трябвало да се случи при нормален flow) → затвори директно, без app
 * navigation.
 */
export function decideRequestImageViewerClose(current: ImageViewerHistoryState): {
  nextState: ImageViewerHistoryState
  actions: ImageViewerAction[]
} {
  if (!current.isOpen) {
    return { nextState: current, actions: [{ type: 'noop' }] }
  }
  if (current.closePending) {
    return { nextState: current, actions: [{ type: 'noop' }] }
  }
  if (current.historyPushed) {
    // state (без closePending) непроменен — финализацията идва през popstate.
    return { nextState: { ...current, closePending: true }, actions: [{ type: 'call-history-back' }] }
  }
  return {
    nextState: { isOpen: false, historyPushed: false, closePending: false },
    actions: [{ type: 'finalize-close' }],
  }
}

/**
 * Popstate събитие (system/browser Back ИЛИ нашия собствен history.back()
 * от decideRequestImageViewerClose). Ако viewer-ът е отворен → consume-ва
 * (финализира close, connsumed=true — повикващият НЕ delegate-ва към
 * screen router-a). Ако вече е затворен → не-consumed, нормална app
 * navigation продължава (следващ Back след viewer close).
 */
export function decideHandlePopstate(current: ImageViewerHistoryState): {
  nextState: ImageViewerHistoryState
  actions: ImageViewerAction[]
  consumed: boolean
} {
  if (!current.isOpen) {
    return { nextState: current, actions: [{ type: 'noop' }], consumed: false }
  }
  return {
    nextState: { isOpen: false, historyPushed: false, closePending: false },
    actions: [{ type: 'finalize-close' }],
    consumed: true,
  }
}
