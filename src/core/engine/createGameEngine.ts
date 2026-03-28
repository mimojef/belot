import { chooseFirstDealer } from '../phases/chooseFirstDealer'
import { resolveCutPhase } from '../phases/resolveCutPhase'
import { runPhaseTransition } from '../phases/runPhaseTransition'
import { selectCutIndex } from '../phases/selectCutIndex'
import { submitBidAction } from '../phases/submitBidAction'
import { createInitialState } from '../state/createInitialState'
import type { BidAction, GameState } from '../state/gameTypes'
import type { PhaseType } from '../phases/phaseTypes'

export type GameEngine = {
  getState: () => GameState
  setState: (nextState: GameState) => void
  updateState: (updater: (currentState: GameState) => GameState) => void
  resetState: () => void
  setPhase: (phase: PhaseType) => void
  startNewGame: () => void
  chooseFirstDealer: () => void
  goToNextPhase: () => void
  selectCutIndex: (cutIndex: number) => void
  resolveCutPhase: () => void
  submitBidAction: (action: BidAction) => void
}

function cloneState<T>(value: T): T {
  return structuredClone(value)
}

export function createGameEngine(): GameEngine {
  let state = createInitialState()

  function getState(): GameState {
    return cloneState(state)
  }

  function setState(nextState: GameState): void {
    state = cloneState(nextState)
  }

  function updateState(updater: (currentState: GameState) => GameState): void {
    const nextState = updater(cloneState(state))
    state = cloneState(nextState)
  }

  function resetState(): void {
    state = createInitialState()
  }

  function setPhase(phase: PhaseType): void {
    state = {
      ...state,
      phase,
    }
  }

  function startNewGame(): void {
    state = createInitialState()
    state = {
      ...state,
      phase: 'choose-first-dealer',
    }
  }

  function runChooseFirstDealer(): void {
    state = chooseFirstDealer(state)
  }

  function goToNextPhase(): void {
    state = runPhaseTransition(state)
  }

  function runSelectCutIndex(cutIndex: number): void {
    state = selectCutIndex(state, cutIndex)
  }

  function runResolveCutPhase(): void {
    state = resolveCutPhase(state)
  }

  function runSubmitBidAction(action: BidAction): void {
    state = submitBidAction(state, action)
  }

  return {
    getState,
    setState,
    updateState,
    resetState,
    setPhase,
    startNewGame,
    chooseFirstDealer: runChooseFirstDealer,
    goToNextPhase,
    selectCutIndex: runSelectCutIndex,
    resolveCutPhase: runResolveCutPhase,
    submitBidAction: runSubmitBidAction,
  }
}