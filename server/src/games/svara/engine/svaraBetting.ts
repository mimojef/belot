// Свара — наддаване в едно раздаване (чиста логика, Етап 2Б.2Б).
//
// Потвърдени правила (спецификация 2Б.2Б, раздели 4–6):
//   • Първи действа следващият след дилъра; дилърът е последен.
//   • Няма обикновен „Пас“: играч с чипове залага или се отказва.
//   • Минимален първи доброволен залог = 1 Вход; минимално повишаване =
//     1 Вход над текущия доброволен залог; без ограничение в броя.
//   • Ол-ин за по-малко е разрешен; непълно ол-ин повишаване НЕ дава ново
//     право за повишаване на вече действалите (те могат само да платят
//     или да се откажат).
//   • Наддаването свършва, когато всички с възможност за действие са
//     изравнили доброволния залог или са ол-ин (или остане един играч).
//   • Тъмно: само първият действащ, преди да е погледнал; минимум 2 × Вход;
//     всеки следващ тъмен залог ≥ 2 × предишния (общ доброволен залог);
//     първият погледнал, който продължава, слага ≥ 2 × последния тъмен
//     залог и с това тъмната фаза приключва за всички.
//   • „Без залог“ — само в специалното 4-то раздаване при двама.
//
//   • Непълен ол-ин на тъмно (решение на собственика, случай №4): позволен;
//     не е пълно повишаване; тъмната фаза продължава; следващият пълен
//     тъмен минимум остава 2 × последния ПЪЛЕН тъмен залог; вече действалите
//     не получават ново право за повишаване (могат само да доплатят/откажат —
//     единственото „плащане“, допустимо в тъмната фаза).
//
// Изричен отказ ('rule-not-implemented') за неуточнените подслучаи:
//   • ол-ин под минимума на тъмната фаза от играч, който е погледнал;
//   • непълен ол-ин „на тъмно“ от първия играч (под 2 × Вход), който би
//     започнал тъмната поредица.
//
// Суми: total = общият ДОБРОВОЛЕН залог на играча в раздаването (без Входа).

export type SvaraBettingAction =
  | { kind: 'fold' }
  | { kind: 'call' }
  | { kind: 'all-in' }
  | { kind: 'no-bet' }
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
  | 'rule-not-implemented'

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

/** Пълно залагане/повишаване: всички останали с възможност за действие трябва да отговорят. */
function applyFullRaise(state: SvaraBettingState, playerId: string, total: number): void {
  state.currentBet = total
  state.anyVoluntaryBet = true
  state.acted = [playerId]
  state.raiseLocked = []
  state.pending = state.order.filter((id) => id !== playerId && canAct(state, id))
}

/** Непълно ол-ин повишаване: вече действалите могат само да платят/откажат. */
function applyShortRaise(state: SvaraBettingState, playerId: string, total: number): void {
  const previouslyActed = state.acted.filter((id) => id !== playerId)
  state.currentBet = total
  state.anyVoluntaryBet = true
  state.pending = state.order.filter((id) => id !== playerId && canAct(state, id))
  state.raiseLocked = previouslyActed.filter((id) => state.pending.includes(id))
  state.acted = [...previouslyActed, playerId]
}

/**
 * Случай №4: непълен ол-ин на тъмно. Не е пълно повишаване; тъмната фаза
 * продължава; lastBlindTotal (база за следващия пълен минимум) не се променя.
 */
function applyIncompleteBlindAllIn(state: SvaraBettingState, playerId: string, total: number, commitTotal: (total: number) => void): void {
  commitTotal(total)
  if (total > state.currentBet) {
    applyShortRaise(state, playerId, total)
  } else {
    remove(state.pending, playerId)
    remove(state.raiseLocked, playerId)
    state.acted.push(playerId)
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
  const isFirstActorOpening = state.blind.status === 'available' && playerId === state.firstActor && state.currentBet === 0
  let added = 0
  let blind = false

  const commitTotal = (total: number) => {
    added = total - voluntary
    state.voluntary[playerId] = total
    if (added === stack) state.allIn.push(playerId)
  }

  switch (action.kind) {
    case 'fold': {
      state.folded.push(playerId)
      remove(state.pending, playerId)
      remove(state.raiseLocked, playerId)
      if (state.blind.status === 'available' && playerId === state.firstActor) state.blind.status = 'closed'
      break
    }
    case 'no-bet': {
      if (!state.allowNoBet) fail('invalid-action', '"Без залог" is only allowed in the special 4th heads-up deal')
      if (state.currentBet !== 0) fail('invalid-action', '"Без залог" is not possible after a voluntary bet')
      state.noBet.push(playerId)
      remove(state.pending, playerId)
      state.acted.push(playerId)
      if (state.blind.status === 'available' && playerId === state.firstActor) state.blind.status = 'closed'
      break
    }
    case 'call': {
      // В тъмната фаза плащане е допустимо само за доплащане на непълен ол-ин (случай №4).
      if (state.blind.status === 'active' && !state.raiseLocked.includes(playerId)) fail('invalid-action', 'during the blind phase a bet must be at least double the last blind bet')
      if (state.currentBet <= voluntary) fail('invalid-action', 'nothing to call')
      const need = state.currentBet - voluntary
      if (need > stack) fail('insufficient-chips', `call needs ${need}, ${playerId} has ${stack}; use all-in`)
      commitTotal(state.currentBet)
      remove(state.pending, playerId)
      remove(state.raiseLocked, playerId)
      state.acted.push(playerId)
      break
    }
    case 'bet':
    case 'blind-bet': {
      const total = action.total
      if (!Number.isSafeInteger(total) || total <= voluntary) fail('invalid-action', `total must be an integer above ${voluntary}`)
      if (total > maxTotal) fail('insufficient-chips', `${playerId} can reach at most ${maxTotal}`)
      if (action.kind === 'blind-bet') {
        if (looked) fail('blind-not-allowed', `${playerId} has already looked at the cards`)
        if (!(isFirstActorOpening || state.blind.status === 'active')) fail('blind-not-allowed', 'a blind sequence can only be started by the first player before any bet')
        const minimum = state.blind.status === 'active' ? 2 * state.blind.lastBlindTotal : 2 * entry
        if (total < minimum) {
          if (total !== maxTotal) fail('below-minimum', `blind bet must be at least ${minimum}`)
          if (state.blind.status !== 'active') fail('rule-not-implemented', `a blind all-in below ${minimum} that would start the blind sequence is not specified yet`)
          applyIncompleteBlindAllIn(state, playerId, total, commitTotal)
          blind = true
          break
        }
        if (state.raiseLocked.includes(playerId)) fail('raise-not-allowed', `${playerId} may only call or fold after an incomplete all-in raise`)
        commitTotal(total)
        applyFullRaise(state, playerId, total)
        state.blind = { status: 'active', lastBlindTotal: total }
        blind = true
        break
      }
      // Обикновен (с погледнати карти или след тъмната фаза) залог.
      if (state.blind.status === 'active') {
        if (!looked) fail('look-required', 'during the blind phase look at the cards first or continue blind')
        if (state.raiseLocked.includes(playerId)) fail('raise-not-allowed', `${playerId} may only call or fold after an incomplete all-in raise`)
        const minimum = 2 * state.blind.lastBlindTotal
        if (total < minimum) {
          if (total === maxTotal) fail('rule-not-implemented', `all-in below the blind-phase minimum ${minimum} is not specified yet`)
          fail('below-minimum', `after looking, the bet must be at least ${minimum}`)
        }
        commitTotal(total)
        applyFullRaise(state, playerId, total)
        state.blind.status = 'closed'
        break
      }
      if (isFirstActorOpening && !looked) fail('look-required', 'the first player must look at the cards or bet blind')
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
        const minimum = 2 * state.blind.lastBlindTotal
        if (total < minimum) {
          if (looked) fail('rule-not-implemented', `an all-in below the blind-phase minimum ${minimum} by a player who has looked is not specified yet`)
          applyIncompleteBlindAllIn(state, playerId, total, commitTotal)
          blind = true
          break
        }
        if (state.raiseLocked.includes(playerId)) fail('raise-not-allowed', `${playerId} may only call or fold after an incomplete all-in raise`)
        commitTotal(total)
        applyFullRaise(state, playerId, total)
        if (looked) state.blind.status = 'closed'
        else {
          state.blind.lastBlindTotal = total
          blind = true
        }
        break
      }
      if (isFirstActorOpening && !looked) {
        if (total < 2 * entry) fail('rule-not-implemented', `a blind all-in below ${2 * entry} that would start the blind sequence is not specified yet; look at the cards first`)
        commitTotal(total)
        applyFullRaise(state, playerId, total)
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

  // Първият играч, който не започне тъмна поредица, я затваря.
  if (state.blind.status === 'available' && playerId === state.firstActor && !blind) state.blind.status = 'closed'
  state.log.push({ playerId, kind: action.kind, total: state.voluntary[playerId] ?? 0, added, allIn: state.allIn.includes(playerId), blind })
  refreshCompletion(state, playerId)
  return { state, added }
}

/** Играчът поглежда картите си (по всяко време, докато е в раздаването). */
export function lookAtSvaraCards(input: SvaraBettingState, playerId: string): SvaraBettingState {
  if (!input.order.includes(playerId)) fail('invalid-action', `${playerId} is not in this deal`)
  if (input.folded.includes(playerId)) fail('player-folded', `${playerId} has folded`)
  if (input.looked.includes(playerId)) return input
  const state = structuredClone(input)
  state.looked.push(playerId)
  // Ако първият погледне преди да е действал, тъмна поредица не може да започне.
  if (state.blind.status === 'available' && playerId === state.firstActor) state.blind.status = 'closed'
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
  if (state.blind.status === 'available' && playerId === state.firstActor) state.blind.status = 'closed'
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
}

/** Позволените действия (за UI/тестове); applySvaraBettingAction валидира независимо. */
export function describeSvaraBettingOptions(state: SvaraBettingState, playerId: string, stack: number): SvaraBettingOptions {
  const none: SvaraBettingOptions = { canAct: false, fold: false, noBet: false, call: null, bet: null, blindBet: null, allIn: null, lookRequired: false }
  if (state.complete || state.toAct !== playerId) return none
  const entry = state.entryChips
  const voluntary = state.voluntary[playerId] ?? 0
  const maxTotal = voluntary + stack
  const looked = state.looked.includes(playerId)
  const firstOpening = state.blind.status === 'available' && playerId === state.firstActor && state.currentBet === 0
  const options: SvaraBettingOptions = { ...none, canAct: true, fold: true }
  options.noBet = state.allowNoBet && state.currentBet === 0
  if (state.blind.status === 'active') {
    const minimum = 2 * state.blind.lastBlindTotal
    const locked = state.raiseLocked.includes(playerId)
    if (locked && state.currentBet > voluntary && state.currentBet - voluntary <= stack) options.call = state.currentBet
    if (!locked && !looked && maxTotal >= minimum) options.blindBet = { min: minimum, max: maxTotal }
    if (!locked && looked && maxTotal >= minimum) options.bet = { min: minimum, max: maxTotal }
    // Непълен тъмен ол-ин е позволен (случай №4); за погледнал играч — само пълен.
    if (stack > 0 && (locked ? maxTotal <= state.currentBet : !looked || maxTotal >= minimum)) options.allIn = maxTotal
    options.lookRequired = !looked && !locked
    return options
  }
  if (firstOpening && !looked) {
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
