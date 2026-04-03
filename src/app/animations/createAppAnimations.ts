import type { GameState } from '../../core/state/gameTypes'
import {
  createTrickCollectionController,
  type TrickCollectionController,
} from './createTrickCollectionController'
import {
  getTrickCollectionAnimationState,
  type TrickCollectionAnimationState,
} from './getTrickCollectionAnimationState'

export type AppAnimations = {
  sync(state: GameState): Promise<void>
  reset(): void
  isBusy(): boolean
  hasCompletedTrick(trickKey: string | null): boolean
  getTrickCollectionState(state: GameState): TrickCollectionAnimationState
}

type CreateAppAnimationsOptions = {
  trickCollectionController?: TrickCollectionController
}

export function createAppAnimations(
  options: CreateAppAnimationsOptions = {},
): AppAnimations {
  const trickCollectionController =
    options.trickCollectionController ?? createTrickCollectionController()

  function getTrickCollectionState(state: GameState): TrickCollectionAnimationState {
    return getTrickCollectionAnimationState(state)
  }

  async function sync(state: GameState): Promise<void> {
    const trickCollectionState = getTrickCollectionState(state)
    await trickCollectionController.sync(trickCollectionState)
  }

  function reset(): void {
    trickCollectionController.reset()
  }

  function isBusy(): boolean {
    return trickCollectionController.isRunning()
  }

  function hasCompletedTrick(trickKey: string | null): boolean {
    return trickCollectionController.hasCompleted(trickKey)
  }

  return {
    sync,
    reset,
    isBusy,
    hasCompletedTrick,
    getTrickCollectionState,
  }
}