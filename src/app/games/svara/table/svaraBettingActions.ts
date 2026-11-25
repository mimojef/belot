// Свара — извеждане на реалните бутони за игрово действие (Етап 2Б.3.7.4).
// Чиста функция: вход е САМО вече получения `you.betting` от server snapshot-а
// (SvaraBettingOptions, виж server/src/games/svara/engine/svaraBetting.ts's
// describeSvaraBettingOptions — единственият източник на истина). Клиентът
// НЕ преизчислява сам кои действия са позволени — само превежда вече
// разрешените опции в конкретни бутони/суми, по модела на заданието §3:
//
//   "Плати" = call (ако има какво да се плаща) ИЛИ отваря на минимума
//   ×5/×10/×20/×50 = множители на МИНИМУМА на текущия залог/повишаване (НЕ на
//             Входа, НЕ на остатъка) — bet.min/blindBet.min * N; над max (наличните
//             чипове) бутонът е неактивен — по-голяма сума се прави само с Ол-ин
//   Ол-ин   = реалната цел (voluntary + stack), директно от сървъра
//   Бягам   = fold
//   Без залог = само когато allowNoBet (специалното 4-то раздаване)
//   Виж     = („Погледни“) само когато играчът е на ход и още не е погледнал
//
// Сървърът валидира всяка команда независимо — тези бутони са само удобство,
// никога извор на истина за позволеността на действието.

import type { SvaraBettingOptions, SvaraParticipantCommand } from '../../../network/createGameServerClient'

export type SvaraMultiplierKind = 'x5' | 'x10' | 'x20' | 'x50'
export type SvaraActionButtonKind = 'look' | 'pay' | SvaraMultiplierKind | 'all-in' | 'no-bet' | 'fold'

export type SvaraActionButton = {
  kind: SvaraActionButtonKind
  label: string
  /** Сумата (целево ниво) на действието — null за Бягам/Виж/Без залог. */
  amount: number | null
  command: SvaraParticipantCommand
  disabled: boolean
}

export const SVARA_MULTIPLIERS: ReadonlyArray<{ kind: SvaraMultiplierKind; factor: 5 | 10 | 20 | 50 }> = [
  { kind: 'x5', factor: 5 },
  { kind: 'x10', factor: 10 },
  { kind: 'x20', factor: 20 },
  { kind: 'x50', factor: 50 },
]

/**
 * `betting === null` или `canAct === false` -> няма позволени действия (не е
 * на ход, не участва в текущото раздаване, друга фаза и т.н. — задание §9).
 */
export function deriveSvaraActionButtons(betting: SvaraBettingOptions | null, looked: boolean, entryChips?: number): SvaraActionButton[] {
  if (!betting || !betting.canAct) return []
  const buttons: SvaraActionButton[] = []

  // Виж — само на ход, само преди първото поглеждане (задание §6).
  // Веднъж тъмната фаза приключи (или никога не е била приложима), сървърът
  // автоматично разкрива картите (revealUnlookedHands) и looked вече е true,
  // затова бутонът естествено изчезва без допълнителна проверка на фазата.
  if (!looked) {
    buttons.push({ kind: 'look', label: 'Виж', amount: null, command: { type: 'look' }, disabled: false })
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
    // Право на залог на тъмно (сървърната опция blindBet) — бутонът е „Тъмни“ и
    // изпълнява реалния blind-bet. Първо откриване на светло (обикновен залог с
    // минимум точно Входа — сървърът дава този минимум само при текущ залог 0,
    // т.е. без предишен залог на тъмно; виж isSvaraOpeningPay) — „Заложи“.
    // Иначе „Плати“ (напр. отговор на залог на тъмно с минимума).
    const title = actionKind === 'blind-bet' ? 'Тъмни' : raiseOption.min === entryChips ? 'Заложи' : 'Плати'
    buttons.push({
      kind: 'pay',
      label: `${title} ${raiseOption.min}`,
      amount: raiseOption.min,
      command: { type: 'act', action: { kind: actionKind, total: raiseOption.min } },
      disabled: false,
    })
  }

  if (raiseOption) {
    for (const { kind, factor } of SVARA_MULTIPLIERS) {
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
      label: 'Ол-ин',
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
