// Свара — проследяване на "ново" поглеждане на собствените карти (ръчно
// „Погледни“ ИЛИ автоматичното разкриване след приключване на тъмната фаза,
// 2Б.3.7.0) за анимация (Етап 2Б.3.7.5, задание §9/§10/§14). Самата анимация
// е винаги само за ЛОКАЛНИЯ играч — чуждите карти никога не се анимират тук
// (sever-ът никога не ги изпраща, виж snapshot protocol-а), затова следи само
// you.looked, не отделен запис в round.actions (поглеждането не е betting
// действие, не влиза в журнала). Същата baseline-on-first-sight архитектура
// като svaraBetAnimationTracker.ts — ПЪРВОТО виждане на даден roundId никога
// не анимира, дори ако картите вече са видими (reconnect/remount/Демо<->
// Истинска игра) — задание §9 "при вече разрешени карти след reconnect покажи
// действителното състояние, без да възпроизвеждаш фиктивно ново поглеждане".

export type SvaraLookAnimationTracker = {
  /** true само когато you.looked РЕАЛНО е преминал от false в true за ТЕКУЩИЯ roundId, след baseline. */
  detectNewLook: (roundId: string | null, looked: boolean) => boolean
  reset: () => void
}

export function createSvaraLookAnimationTracker(): SvaraLookAnimationTracker {
  const seen = new Map<string, boolean>()

  function detectNewLook(roundId: string | null, looked: boolean): boolean {
    if (roundId === null) return false
    const previouslySeen = seen.get(roundId)
    if (previouslySeen === undefined) {
      seen.set(roundId, looked)
      return false
    }
    seen.set(roundId, looked)
    return looked && !previouslySeen
  }

  function reset(): void {
    seen.clear()
  }

  return { detectNewLook, reset }
}
