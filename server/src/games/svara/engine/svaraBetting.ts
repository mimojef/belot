// Свара — наддаване в едно раздаване (чиста логика, Етап 2Б.2Б/2Б.3.7.0).
//
// Потвърдени правила (спецификация 2Б.2Б, раздели 4–6):
//   • Първи действа следващият след дилъра; дилърът е последен.
//   • Няма обикновен „Пас“: играч с чипове залага или се отказва.
//   • Минимален първи доброволен залог = 1 Вход; минимално повишаване =
//     1 Вход над текущия доброволен залог; без ограничение в броя.
//   • Ол-ин за по-малко е разрешен при ОБИКНОВЕНО наддаване; непълно
//     повишаване НЕ дава ново право за повишаване на вече действалите
//     (те могат само да платят или да се откажат).
//   • Наддаването свършва, когато всички с възможност за действие са
//     изравнили доброволния залог или са ол-ин (или остане един играч).
//   • „Без залог“ — само в специалното 4-то раздаване при двама.
//
// Окончателно решение на собственика за тъмно (16.10.2026, Етап 2Б.3.7.0—
// заменя по-старото „само първият играч“ от §5 на спецификацията):
//   1. Правото да ОТВОРИ тъмната фаза принадлежи на първия играч след
//      дилъра, но при отказ БЕЗ залог (fold) правото последователно
//      преминава към следващия допустим играч — и може да се повтори за
//      трети, четвърти и т.н., докато остане повече от един неотказал.
//   2. Поглеждането на картите САМО ПО СЕБЕ СИ не затваря тъмната фаза
//      глобално и не отнема правото на следващите — но погледналият играч
//      лично няма право да залага на тъмно (блъф „на тъмно след поглеждане“
//      е невъзможен). Ако след поглеждане играчът се откаже без залог,
//      правото пак преминава към следващия.
//   3. Щом някой заложи на тъмно, следващите МОГАТ да продължат на тъмно
//      (минимум 2 × предишния тъмен залог), докато фазата е разрешена.
//   4. Първият ОБИКНОВЕН (небляндов) залог — независимо кой точно играч го
//      прави и независимо дали преди това е имало тъмни залози — приключва
//      тъмната фаза ОКОНЧАТЕЛНО за цялото раздаване. Минимумът за този
//      залог е 1 Вход (ако никой не е залагал на тъмно) или 2 × последния
//      тъмен залог (ако е имало тъмна поредица). След тази точка никой
//      няма право да залага на тъмно до следващото раздаване.
//   5. Решение №1/№2 от втората вълна (15.10.2026) остават в сила непроменени:
//      пълна забрана на непълен тъмен залог/ол-ин; нормален (непълен) ол-ин
//      е позволен за погледнал играч с недостатъчни чипове и също окончателно
//      затваря тъмната фаза (точка 4 по-горе).
//
// Автоматично разкриване (Етап 2Б.3.7.0, извършва се от svaraMatch.ts чрез
// `revealUnlookedHands`, не тук): когато първия обикновен залог приключи
// тъмната фаза, останалите активни неотказали играчи автоматично получават
// право да видят собствените си карти, без изрично „Погледни“.
//
// Суми: total = общият ДОБРОВОЛЕН залог на играча в раздаването (без Входа).

// Решение на собственика (27.11.2026) — тъмният залог се брои двойно:
//   • Залогът на играч, който е залагал на тъмно и още не е погледнал, се
//     брои ДВОЙНО за изравняване със светъл залог (реалните чипове не се
//     удвояват). currentBet е в „светла“ стойност: тъмен залог T → 2T.
//   • Погледнал играч, който изравнява двойния тъмен залог, ПЛАЩА (call).
//     Решение (28.11.2026): успешното плащане на погледнал играч (вкл. ол-ин
//     за плащане) затваря тъмната фаза за цялото раздаване — както
//     повишаването на светло. Само поглеждане или отказ не я затварят.
//     Играчите на тъмно, чийто двоен залог е равен на текущия след нов тъмен
//     залог, получават ход за решение: „Оставам на тъмно“ (stay-blind, без
//     чипове — не е „Пас“), поглеждане и плащане/повишаване, нов тъмен залог
//     или „Бягам“.
//   • Повишаване на светло = над текущия залог с поне 1 Вход; то (както
//     досега, правило 4) затваря тъмната фаза и разкрива картите на всички.
//   • При сравняване тъмният залог се брои двойно и за правото на банката
//     (svaraPots.ts, blindDoubled).
export type SvaraBettingAction =
  | { kind: 'fold' }
  | { kind: 'call' }
  | { kind: 'all-in' }
  | { kind: 'no-bet' }
  | { kind: 'stay-blind' }
  | { kind: 'bet'; total: number }
  | { kind: 'blind-bet'; total: number }

export type SvaraBlindStatus = 'available' | 'active' | 'closed'

export type SvaraBettingLogEntry = {
  playerId: string
  kind: SvaraBettingAction['kind'] | 'forced-fold'
  /** Доброволен залог на играча след действието. */
  total: number
  /** Добавени чипове с това действие. */
  added: number
  allIn: boolean
  blind: boolean
}

export type SvaraBettingState = {
  entryChips: number
  /** Ред на действие: първият след дилъра … дилърът. */
  order: string[]
  firstActor: string | null
  voluntary: Record<string, number>
  currentBet: number
  anyVoluntaryBet: boolean
  folded: string[]
  /** Без свободни чипове — не действат, но не са отказали. */
  allIn: string[]
  looked: string[]
  /** Трябва да действат, преди наддаването да приключи. */
  pending: string[]
  /** Действали след последното пълно залагане/повишаване. */
  acted: string[]
  /** Могат само да платят или да се откажат (непълно ол-ин повишаване). */
  raiseLocked: string[]
  toAct: string | null
  /** lastBlindTotal = последният ПЪЛЕН тъмен залог (непълен ол-ин не го променя). */
  blind: { status: SvaraBlindStatus; lastBlindTotal: number }
  /**
   * Заложилите на тъмно (27.11.2026). Докато такъв играч не е погледнал,
   * залогът му се брои двойно (svaraEffectiveBet). Липсва в състояния,
   * записани преди промяната — тогава се приема за празен.
   */
  blindBettors?: string[]
  /** Играчи на тъмно, избрали „Оставам на тъмно“ след последното повишаване. */
  blindConfirmed?: string[]
  allowNoBet: boolean
  noBet: string[]
  complete: boolean
  log: SvaraBettingLogEntry[]
}

export type SvaraBettingErrorCode =
  | 'betting-complete'
  | 'not-your-turn'
  | 'player-folded'
  | 'invalid-action'
  | 'below-minimum'
  | 'raise-not-allowed'
  | 'insufficient-chips'
  | 'look-required'
  | 'blind-not-allowed'

export class SvaraBettingError extends Error {
  constructor(readonly code: SvaraBettingErrorCode, message: string) {
    super(message)
    this.name = 'SvaraBettingError'
  }
}

const fail = (code: SvaraBettingErrorCode, message: string): never => {
  throw new SvaraBettingError(code, message)
}

export function createSvaraBetting(input: {
  order: string[]
  stacks: Record<string, number>
  folded: string[]
  entryChips: number
  allowNoBet: boolean
}): SvaraBettingState {
  const folded = [...input.folded]
  const allIn = input.order.filter((id) => !folded.includes(id) && (input.stacks[id] ?? 0) === 0)
  const pending = input.order.filter((id) => !folded.includes(id) && !allIn.includes(id))
  const firstActor = pending[0] ?? null
  const state: SvaraBettingState = {
    entryChips: input.entryChips,
    order: [...input.order],
    firstActor,
    voluntary: {},
    currentBet: 0,
    anyVoluntaryBet: false,
    folded,
    allIn,
    looked: [],
    pending,
    acted: [],
    raiseLocked: [],
    toAct: firstActor,
    blind: { status: firstActor ? 'available' : 'closed', lastBlindTotal: 0 },
    blindBettors: [],
    blindConfirmed: [],
    allowNoBet: input.allowNoBet,
    noBet: [],
    complete: false,
    log: [],
  }
  refreshCompletion(state, null)
  return state
}

function nonFolded(state: SvaraBettingState): string[] {
  return state.order.filter((id) => !state.folded.includes(id))
}

/** Следващият чакащ след играча (по кръга); null ако няма. */
function nextPending(state: SvaraBettingState, after: string | null): string | null {
  if (state.pending.length === 0) return null
  const start = after === null ? -1 : state.order.indexOf(after)
  for (let step = 1; step <= state.order.length; step += 1) {
    const id = state.order[(start + step + state.order.length) % state.order.length]!
    if (state.pending.includes(id)) return id
  }
  return null
}

function refreshCompletion(state: SvaraBettingState, lastActor: string | null): void {
  if (nonFolded(state).length <= 1 || state.pending.length === 0) {
    state.complete = true
    state.toAct = null
    return
  }
  state.toAct = nextPending(state, lastActor)
}

function canAct(state: SvaraBettingState, id: string): boolean {
  return !state.folded.includes(id) && !state.allIn.includes(id)
}

function remove(list: string[], id: string): void {
  const index = list.indexOf(id)
  if (index >= 0) list.splice(index, 1)
}

/** Залогът на играча се брои двойно: залагал е на тъмно, не е погледнал и не е отказал. */
export function isSvaraBlindCountedDouble(state: SvaraBettingState, playerId: string): boolean {
  return (state.blindBettors ?? []).includes(playerId) && !state.looked.includes(playerId) && !state.folded.includes(playerId)
}

/** Залогът на играча в „светла“ стойност (тъмният — двойно). Сравнява се с currentBet. */
export function svaraEffectiveBet(state: SvaraBettingState, playerId: string): number {
  const voluntary = state.voluntary[playerId] ?? 0
  return isSvaraBlindCountedDouble(state, playerId) ? 2 * voluntary : voluntary
}

/** Играчите, чийто залог в момента се брои двойно (публично — показва се на масата). */
export function svaraBlindPlayers(state: SvaraBettingState): string[] {
  return state.order.filter((id) => isSvaraBlindCountedDouble(state, id))
}

/**
 * За банката при приключване: реално внесените на тъмно чипове на всеки
 * играч, чийто залог се брои двойно (виж svaraPots.ts blindDoubled).
 */
export function svaraBlindDoubledContributions(state: SvaraBettingState): Record<string, number> {
  const doubled: Record<string, number> = {}
  for (const id of svaraBlindPlayers(state)) {
    const voluntary = state.voluntary[id] ?? 0
    if (voluntary > 0) doubled[id] = voluntary
  }
  return doubled
}

function markBlindBettor(state: SvaraBettingState, playerId: string): void {
  state.blindBettors = state.blindBettors ?? []
  if (!state.blindBettors.includes(playerId)) state.blindBettors.push(playerId)
}

/** Пълно залагане/повишаване: всички останали с възможност за действие трябва да отговорят. */
function applyFullRaise(state: SvaraBettingState, playerId: string, total: number): void {
  state.currentBet = total
  state.anyVoluntaryBet = true
  state.acted = [playerId]
  state.raiseLocked = []
  state.blindConfirmed = []
  state.pending = state.order.filter((id) => id !== playerId && canAct(state, id))
}

/** Непълно ол-ин повишаване: вече действалите могат само да платят/откажат. */
function applyShortRaise(state: SvaraBettingState, playerId: string, total: number): void {
  const previouslyActed = state.acted.filter((id) => id !== playerId)
  state.currentBet = total
  state.anyVoluntaryBet = true
  state.blindConfirmed = []
  state.pending = state.order.filter((id) => id !== playerId && canAct(state, id))
  state.raiseLocked = previouslyActed.filter((id) => state.pending.includes(id))
  state.acted = [...previouslyActed, playerId]
}

/**
 * След плащане (вкл. ол-ин за плащане): играчите на тъмно, чийто двоен
 * залог вече е равен на текущия и които още не са решили след последното
 * повишаване, получават ход за решение (не дължат автоматично доплащане).
 */
function offerBlindDecision(state: SvaraBettingState, callerId: string): void {
  const confirmed = state.blindConfirmed ?? []
  for (const id of state.order) {
    if (id === callerId || !canAct(state, id) || !isSvaraBlindCountedDouble(state, id)) continue
    if (svaraEffectiveBet(state, id) !== state.currentBet || confirmed.includes(id) || state.pending.includes(id)) continue
    state.pending.push(id)
  }
}

export type SvaraBettingResult = { state: SvaraBettingState; added: number }

/**
 * Прилага действие на играча, който е на ход. stack = свободните му чипове.
 * Не променя входа; връща ново състояние и колко чипа да се преместят в банката.
 */
export function applySvaraBettingAction(input: SvaraBettingState, playerId: string, action: SvaraBettingAction, stack: number): SvaraBettingResult {
  if (input.complete) fail('betting-complete', 'betting is complete')
  if (input.folded.includes(playerId)) fail('player-folded', `${playerId} has folded`)
  if (input.toAct !== playerId) fail('not-your-turn', `it is ${String(input.toAct)}'s turn, not ${playerId}'s`)
  if (!Number.isSafeInteger(stack) || stack < 0) fail('invalid-action', 'invalid stack')
  const state = structuredClone(input)
  const entry = state.entryChips
  const voluntary = state.voluntary[playerId] ?? 0
  const maxTotal = voluntary + stack
  const looked = state.looked.includes(playerId)
  // Правото да ОТВОРИ тъмната фаза принадлежи на ТОЗИ действащ играч, докато
  // никой не е заложил нищо (на тъмно или обикновено) — не само на литералния
  // firstActor. Отказ без залог го предава естествено на следващия (виж 'fold').
  const canOpenBlind = state.blind.status === 'available' && state.currentBet === 0
  // Залогът на играча в „светла“ стойност (тъмният — двойно; 27.11.2026).
  const effective = svaraEffectiveBet(state, playerId)
  const countedDouble = isSvaraBlindCountedDouble(state, playerId)
  state.blindBettors = state.blindBettors ?? []
  state.blindConfirmed = state.blindConfirmed ?? []
  let added = 0
  let blind = false

  const commitTotal = (total: number) => {
    added = total - voluntary
    state.voluntary[playerId] = total
    if (added === stack) state.allIn.push(playerId)
  }

  switch (action.kind) {
    case 'fold': {
      // Решение (16.10.2026): отказ без залог НЕ затваря тъмната фаза — тя
      // остава 'available' и правото преминава естествено към следващия
      // чакащ играч (nextPending по-долу), не само към литералния firstActor.
      state.folded.push(playerId)
      remove(state.pending, playerId)
      remove(state.raiseLocked, playerId)
      break
    }
    case 'no-bet': {
      if (!state.allowNoBet) fail('invalid-action', '"Без залог" is only allowed in the special 4th heads-up deal')
      if (state.currentBet !== 0) fail('invalid-action', '"Без залог" is not possible after a voluntary bet')
      // Същото решение: „Без залог“ не е залог и не затваря тъмната фаза.
      state.noBet.push(playerId)
      remove(state.pending, playerId)
      state.acted.push(playerId)
      break
    }
    case 'call': {
      // 27.11.2026: погледнал играч ПЛАЩА и срещу тъмен залог — изравнява
      // „светлата“ стойност (тъмният залог се брои двойно); на тъмно не се
      // плаща (нов тъмен залог е ≥ 2×). 28.11.2026: успешното плащане
      // затваря тъмната фаза (виж горе) — svaraMatch.ts обръща картите.
      if (state.blind.status === 'active' && !looked) fail('look-required', 'during the blind phase look at the cards before paying, or continue blind')
      if (state.currentBet <= effective) fail('invalid-action', 'nothing to call')
      const need = state.currentBet - effective
      if (need > stack) fail('insufficient-chips', `call needs ${need}, ${playerId} has ${stack}; use all-in`)
      commitTotal(voluntary + need)
      remove(state.pending, playerId)
      remove(state.raiseLocked, playerId)
      state.acted.push(playerId)
      if (state.blind.status === 'active') state.blind.status = 'closed'
      else offerBlindDecision(state, playerId)
      break
    }
    case 'stay-blind': {
      // „Оставам на тъмно“ (27.11.2026): двойният тъмен залог вече е равен на
      // текущия — без нови чипове и без повишаване. Не е обикновен „Пас“:
      // възможно е само за играч на тъмно с изравнен залог.
      if (state.blind.status !== 'active' || !countedDouble) fail('invalid-action', 'only a player who is still betting blind can stay blind')
      if (effective !== state.currentBet) fail('invalid-action', 'staying blind is only possible when the blind bet already matches the current bet')
      remove(state.pending, playerId)
      if (!state.blindConfirmed.includes(playerId)) state.blindConfirmed.push(playerId)
      if (!state.acted.includes(playerId)) state.acted.push(playerId)
      blind = true
      break
    }
    case 'bet':
    case 'blind-bet': {
      const total = action.total
      if (!Number.isSafeInteger(total) || total <= voluntary) fail('invalid-action', `total must be an integer above ${voluntary}`)
      if (total > maxTotal) fail('insufficient-chips', `${playerId} can reach at most ${maxTotal}`)
      if (action.kind === 'blind-bet') {
        if (looked) fail('blind-not-allowed', `${playerId} has already looked at the cards`)
        if (!(canOpenBlind || state.blind.status === 'active')) fail('blind-not-allowed', 'a blind bet is only possible while the blind phase is still open and before any voluntary bet')
        const minimum = state.blind.status === 'active' ? 2 * state.blind.lastBlindTotal : 2 * entry
        // Решение №1: пълна забрана на непълен залог на тъмно — важи за
        // първоначалния и за всеки следващ (отменя старото Решение №4).
        if (total < minimum) fail('below-minimum', `blind bet must be at least ${minimum}; a player without enough free chips may not bet blind`)
        if (state.raiseLocked.includes(playerId)) fail('raise-not-allowed', `${playerId} may only call or fold after an incomplete all-in raise`)
        commitTotal(total)
        markBlindBettor(state, playerId)
        // Тъмният залог се брои двойно: текущият залог става 2 × total.
        applyFullRaise(state, playerId, 2 * total)
        state.blind = { status: 'active', lastBlindTotal: total }
        blind = true
        break
      }
      // Повишаване на светло по време на тъмната фаза (27.11.2026): над
      // текущия („светъл“) залог с поне 1 Вход; изравняването е „Плати“ (call).
      // Затваря тъмната фаза (правило 4) — останалите виждат картите си.
      if (state.blind.status === 'active') {
        if (!looked) fail('look-required', 'during the blind phase look at the cards first or continue blind')
        if (state.raiseLocked.includes(playerId)) fail('raise-not-allowed', `${playerId} may only call or fold after an incomplete all-in raise`)
        if (total <= state.currentBet) fail('invalid-action', `total ${total} does not exceed the current bet ${state.currentBet}; use call`)
        const minimum = state.currentBet + entry
        if (total < minimum) {
          if (total !== maxTotal) fail('below-minimum', `minimum raise is ${minimum}`)
          // Погледнал играч с недостатъчни чипове → непълно ол-ин повишаване.
          commitTotal(total)
          applyShortRaise(state, playerId, total)
          state.blind.status = 'closed'
          break
        }
        commitTotal(total)
        applyFullRaise(state, playerId, total)
        state.blind.status = 'closed'
        break
      }
      if (canOpenBlind && !looked) fail('look-required', 'the current player must look at the cards or bet blind')
      const minimum = state.currentBet === 0 ? entry : state.currentBet + entry
      if (state.currentBet > 0 && state.raiseLocked.includes(playerId)) fail('raise-not-allowed', `${playerId} may only call or fold after an incomplete all-in raise`)
      if (total <= state.currentBet) fail('invalid-action', `total ${total} does not exceed the current bet ${state.currentBet}; use call`)
      if (total < minimum) {
        if (total !== maxTotal) fail('below-minimum', `minimum is ${minimum}`)
        commitTotal(total)
        applyShortRaise(state, playerId, total)
        break
      }
      commitTotal(total)
      applyFullRaise(state, playerId, total)
      break
    }
    case 'all-in': {
      if (stack === 0) fail('invalid-action', `${playerId} has no free chips`)
      const total = maxTotal
      if (state.blind.status === 'active') {
        if (!looked) {
          // Ол-ин на тъмно = тъмен залог за цялата наличност (брои се двойно).
          // Решение №1: под минимума на тъмно не е позволен — погледни.
          const minimum = 2 * state.blind.lastBlindTotal
          if (total < minimum) fail('blind-not-allowed', `${playerId} has only ${total}, below the blind minimum ${minimum}; look at the cards to continue`)
          if (state.raiseLocked.includes(playerId)) fail('raise-not-allowed', `${playerId} may only call or fold after an incomplete all-in raise`)
          commitTotal(total)
          markBlindBettor(state, playerId)
          applyFullRaise(state, playerId, 2 * total)
          state.blind.lastBlindTotal = total
          blind = true
          break
        }
        if (total <= state.currentBet) {
          // Погледнал играч: ол-ин за плащане (пълно или непълно) — не
          // повишава, но като всяко плащане затваря тъмната фаза (28.11.2026).
          commitTotal(total)
          remove(state.pending, playerId)
          remove(state.raiseLocked, playerId)
          state.acted.push(playerId)
          state.blind.status = 'closed'
          break
        }
        // Погледнал играч: ол-ин повишаване на светло — затваря тъмната фаза.
        if (state.raiseLocked.includes(playerId)) fail('raise-not-allowed', `${playerId} may only call or fold after an incomplete all-in raise`)
        commitTotal(total)
        if (total >= state.currentBet + entry) applyFullRaise(state, playerId, total)
        else applyShortRaise(state, playerId, total)
        state.blind.status = 'closed'
        break
      }
      if (canOpenBlind && !looked) {
        // Решение №1: непълен тъмен залог/ол-ин на самото начало е забранен;
        // играчът трябва да погледне (и да залага нормално) или да се откаже.
        if (total < 2 * entry) fail('blind-not-allowed', `${playerId} has only ${total}, below the blind minimum ${2 * entry}; look at the cards to continue`)
        commitTotal(total)
        markBlindBettor(state, playerId)
        applyFullRaise(state, playerId, 2 * total)
        state.blind = { status: 'active', lastBlindTotal: total }
        blind = true
        break
      }
      if (total <= state.currentBet) {
        // Ол-ин за плащане (пълно или непълно).
        commitTotal(total)
        remove(state.pending, playerId)
        remove(state.raiseLocked, playerId)
        state.acted.push(playerId)
        break
      }
      if (state.raiseLocked.includes(playerId)) fail('raise-not-allowed', `${playerId} may only call or fold after an incomplete all-in raise`)
      const minimum = state.currentBet === 0 ? entry : state.currentBet + entry
      commitTotal(total)
      if (total >= minimum) applyFullRaise(state, playerId, total)
      else applyShortRaise(state, playerId, total)
      break
    }
    default:
      fail('invalid-action', `unknown action ${String((action as { kind?: unknown }).kind)}`)
  }

  // Правило 4 (16.10.2026): първият ОБИКНОВЕН залог (не на тъмно) — от който
  // и да е играч, докато тъмната фаза е още 'available' — я затваря завинаги
  // за това раздаване. Отказ/„Без залог“ не достигат дотук с blind=false по
  // начин, който трябва да затваря фазата (вижте техните отделни клонове).
  if (state.blind.status === 'available' && !blind && (action.kind === 'bet' || action.kind === 'all-in')) state.blind.status = 'closed'
  state.log.push({ playerId, kind: action.kind, total: state.voluntary[playerId] ?? 0, added, allIn: state.allIn.includes(playerId), blind })
  refreshCompletion(state, playerId)
  return { state, added }
}

/**
 * Играчът поглежда картите си (по всяко време, докато е в раздаването).
 * Правило 2 (16.10.2026): поглеждането САМО ПО СЕБЕ СИ не затваря тъмната
 * фаза глобално — само отнема личното право на ТОЗИ играч да залага на
 * тъмно (проверено отделно чрез `looked` във `applySvaraBettingAction`).
 */
export function lookAtSvaraCards(input: SvaraBettingState, playerId: string): SvaraBettingState {
  if (!input.order.includes(playerId)) fail('invalid-action', `${playerId} is not in this deal`)
  if (input.folded.includes(playerId)) fail('player-folded', `${playerId} has folded`)
  if (input.looked.includes(playerId)) return input
  const state = structuredClone(input)
  state.looked.push(playerId)
  return state
}

/**
 * Автоматично разкриване (Етап 2Б.3.7.0): когато първия обикновен залог
 * приключи тъмната фаза, всички останали активни неотказали играчи
 * автоматично получават право да видят собствените си карти, без изрично
 * „Погледни“. Вика се от svaraMatch.ts след преход на blind.status към
 * 'closed'; `excludePlayerIds` носи отсъстващите участници (само свараMatch.ts
 * знае статуса на мястото — тук „активен“ не се проверява пряко).
 */
export function revealUnlookedHands(input: SvaraBettingState, excludePlayerIds: readonly string[] = []): SvaraBettingState {
  const state = structuredClone(input)
  for (const id of state.order) {
    if (!state.folded.includes(id) && !state.looked.includes(id) && !excludePlayerIds.includes(id)) state.looked.push(id)
  }
  return state
}

/**
 * След затварянето на тъмната фаза и автоматичното обръщане (svaraMatch.ts):
 * обърнатият залог вече не се брои двойно (както досега след повишаване на
 * светло). Който остане под текущия залог, трябва да плати, да повиши или да
 * избяга, преди наддаването да приключи — дори плащането да го е изравнило
 * по двойната стойност.
 */
export function requireCallsAfterBlindClose(input: SvaraBettingState, lastActor: string): SvaraBettingState {
  const state = structuredClone(input)
  let reopened = false
  for (const id of state.order) {
    if (!canAct(state, id) || state.pending.includes(id) || svaraEffectiveBet(state, id) >= state.currentBet) continue
    state.pending.push(id)
    reopened = true
  }
  if (!reopened) return input
  state.complete = false
  refreshCompletion(state, lastActor)
  return state
}

/** Принудителен отказ извън реда (отсъствие/изход). */
export function forceSvaraFold(input: SvaraBettingState, playerId: string): SvaraBettingState {
  if (input.folded.includes(playerId) || !input.order.includes(playerId)) return input
  const state = structuredClone(input)
  state.folded.push(playerId)
  remove(state.pending, playerId)
  remove(state.raiseLocked, playerId)
  remove(state.allIn, playerId)
  // Същото правило като доброволния 'fold': не затваря тъмната фаза; правото
  // преминава естествено към следващия чакащ (ако има такъв).
  state.log.push({ playerId, kind: 'forced-fold', total: state.voluntary[playerId] ?? 0, added: 0, allIn: false, blind: false })
  const wasToAct = input.toAct === playerId
  if (state.complete) return state
  if (nonFolded(state).length <= 1 || state.pending.length === 0) {
    state.complete = true
    state.toAct = null
  } else if (wasToAct || state.toAct === null) {
    state.toAct = nextPending(state, playerId)
  }
  return state
}

export type SvaraBettingOptions = {
  canAct: boolean
  fold: boolean
  noBet: boolean
  call: number | null
  bet: { min: number; max: number } | null
  blindBet: { min: number; max: number } | null
  allIn: number | null
  lookRequired: boolean
  /** „Оставам на тъмно“ (27.11.2026): двойният тъмен залог вече е равен на текущия. */
  stayBlind: boolean
}

/** Позволените действия (за UI/тестове); applySvaraBettingAction валидира независимо. */
export function describeSvaraBettingOptions(state: SvaraBettingState, playerId: string, stack: number): SvaraBettingOptions {
  const none: SvaraBettingOptions = { canAct: false, fold: false, noBet: false, call: null, bet: null, blindBet: null, allIn: null, lookRequired: false, stayBlind: false }
  if (state.complete || state.toAct !== playerId) return none
  const entry = state.entryChips
  const voluntary = state.voluntary[playerId] ?? 0
  const maxTotal = voluntary + stack
  const looked = state.looked.includes(playerId)
  const canOpenBlind = state.blind.status === 'available' && state.currentBet === 0
  const options: SvaraBettingOptions = { ...none, canAct: true, fold: true }
  options.noBet = state.allowNoBet && state.currentBet === 0
  if (state.blind.status === 'active') {
    const locked = state.raiseLocked.includes(playerId)
    if (looked) {
      // 27.11.2026: погледналият плаща до текущия („светъл“) залог или вдига
      // с поне 1 Вход над него; ол-ин — винаги (за плащане или повишаване).
      if (state.currentBet > voluntary && state.currentBet - voluntary <= stack) options.call = state.currentBet
      const minimum = state.currentBet + entry
      if (!locked && maxTotal >= minimum) options.bet = { min: minimum, max: maxTotal }
      if (stack > 0 && (!locked || maxTotal <= state.currentBet)) options.allIn = maxTotal
      return options
    }
    // На тъмно: нов тъмен залог (≥ 2 × последния), „Оставам на тъмно“ при
    // изравнен двоен залог, поглеждане или отказ.
    // Решение №1: непогледнал играч под минимума няма опция за ол-ин на тъмно.
    const minimum = 2 * state.blind.lastBlindTotal
    if (!locked && maxTotal >= minimum) {
      options.blindBet = { min: minimum, max: maxTotal }
      if (stack > 0) options.allIn = maxTotal
    }
    options.stayBlind = isSvaraBlindCountedDouble(state, playerId) && svaraEffectiveBet(state, playerId) === state.currentBet
    options.lookRequired = !locked
    return options
  }
  if (canOpenBlind && !looked) {
    if (maxTotal >= 2 * entry) {
      options.blindBet = { min: 2 * entry, max: maxTotal }
      options.allIn = maxTotal
    }
    options.lookRequired = true
    return options
  }
  if (state.currentBet > voluntary) {
    const need = state.currentBet - voluntary
    if (need <= stack) options.call = state.currentBet
  }
  const locked = state.currentBet > 0 && state.raiseLocked.includes(playerId)
  const minimum = state.currentBet === 0 ? entry : state.currentBet + entry
  if (!locked && maxTotal >= minimum) options.bet = { min: minimum, max: maxTotal }
  if (stack > 0 && (!locked || maxTotal <= state.currentBet)) options.allIn = maxTotal
  return options
}
