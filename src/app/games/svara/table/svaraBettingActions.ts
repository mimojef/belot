// Свара — извеждане на реалните бутони за игрово действие (Етап 2Б.3.7.4).
// Чиста функция: вход е САМО вече получения `you.betting` от server snapshot-а
// (SvaraBettingOptions, виж server/src/games/svara/engine/svaraBetting.ts's
// describeSvaraBettingOptions — единственият източник на истина). Клиентът
// НЕ преизчислява сам кои действия са позволени — само превежда вече
// разрешените опции в конкретни бутони/суми, по модела на заданието §3:
//
//   "Плати" = call (ако има какво да се плаща) ИЛИ отваря на минимума
//   ×2..×5  = множители на МИНИМУМА на текущия залог/повишаване (НЕ на Входа,
//             НЕ на остатъка) — bet.min/blindBet.min * N, клампнати до max
//   Ол-ин   = реалната цел (voluntary + stack), директно от сървъра
//   Бягам   = fold
//   Без залог = само когато allowNoBet (специалното 4-то раздаване)
//   Погледни  = само когато играчът е на ход и още не е погледнал
//
// Сървърът валидира всяка команда независимо — тези бутони са само удобство,
// никога извор на истина за позволеността на действието.

import type { SvaraBettingOptions, SvaraParticipantCommand } from '../../../network/createGameServerClient'

export type SvaraActionButtonKind = 'look' | 'pay' | 'x2' | 'x3' | 'x4' | 'x5' | 'all-in' | 'no-bet' | 'fold'

export type SvaraActionButton = {
  kind: SvaraActionButtonKind
  label: string
  /** Сумата (целево ниво), показана в бутона — null за Бягам/Погледни/Без залог. */
  amount: number | null
  command: SvaraParticipantCommand
  disabled: boolean
}

const MULTIPLIERS: ReadonlyArray<{ kind: 'x2' | 'x3' | 'x4' | 'x5'; factor: 2 | 3 | 4 | 5 }> = [
  { kind: 'x2', factor: 2 },
  { kind: 'x3', factor: 3 },
  { kind: 'x4', factor: 4 },
  { kind: 'x5', factor: 5 },
]

/**
 * `betting === null` или `canAct === false` -> няма позволени действия (не е
 * на ход, не участва в текущото раздаване, друга фаза и т.н. — задание §9).
 */
export function deriveSvaraActionButtons(betting: SvaraBettingOptions | null, looked: boolean): SvaraActionButton[] {
  if (!betting || !betting.canAct) return []
  const buttons: SvaraActionButton[] = []

  // Погледни — само на ход, само преди първото поглеждане (задание §6).
  // Веднъж тъмната фаза приключи (или никога не е била приложима), сървърът
  // автоматично разкрива картите (revealUnlookedHands) и looked вече е true,
  // затова бутонът естествено изчезва без допълнителна проверка на фазата.
  if (!looked) {
    buttons.push({ kind: 'look', label: 'Погледни', amount: null, command: { type: 'look' }, disabled: false })
  }

  // bet/blindBet са взаимно изключващи се в SvaraBettingOptions (виж
  // describeSvaraBettingOptions) — ползваме каквото е налично, blindBet има
  // приоритет само защото никога не съвпадат едновременно.
  const raiseOption = betting.blindBet ?? betting.bet
  const actionKind: 'bet' | 'blind-bet' = betting.blindBet ? 'blind-bet' : 'bet'

  if (betting.call !== null) {
    buttons.push({
      kind: 'pay',
      label: `Плати ${betting.call}`,
      amount: betting.call,
      command: { type: 'act', action: { kind: 'call' } },
      disabled: false,
    })
  } else if (raiseOption) {
    buttons.push({
      kind: 'pay',
      label: `Плати ${raiseOption.min}`,
      amount: raiseOption.min,
      command: { type: 'act', action: { kind: actionKind, total: raiseOption.min } },
      disabled: false,
    })
  }

  if (raiseOption) {
    for (const { kind, factor } of MULTIPLIERS) {
      const total = raiseOption.min * factor
      buttons.push({
        kind,
        label: `×${factor}`,
        amount: total,
        command: { type: 'act', action: { kind: actionKind, total } },
        // Задание §9: недопустима сума над наличните чипове — неактивна (не скрита).
        disabled: total > raiseOption.max,
      })
    }
  }

  if (betting.allIn !== null) {
    buttons.push({
      kind: 'all-in',
      label: `Ол-ин · ${betting.allIn}`,
      amount: betting.allIn,
      command: { type: 'act', action: { kind: 'all-in' } },
      disabled: false,
    })
  }

  if (betting.noBet) {
    buttons.push({ kind: 'no-bet', label: 'Без залог', amount: null, command: { type: 'act', action: { kind: 'no-bet' } }, disabled: false })
  }

  if (betting.fold) {
    buttons.push({ kind: 'fold', label: 'Бягам', amount: null, command: { type: 'act', action: { kind: 'fold' } }, disabled: false })
  }

  return buttons
}
