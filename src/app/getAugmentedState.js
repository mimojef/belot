export function getAugmentedState({ game, cuttingFlow, biddingFlow }) {
  const state = game.getState()

  const cuttingUiState = cuttingFlow ? cuttingFlow.getUiState(state) : {}
  const biddingUiState = biddingFlow ? biddingFlow.getUiState(state) : {}

  return {
    ...state,
    ui: {
      ...(state.ui ?? {}),
      cutting: {
        ...(state.ui?.cutting ?? {}),
        ...cuttingUiState,
      },
      bidding: {
        ...(state.ui?.bidding ?? {}),
        ...biddingUiState,
      },
    },
  }
}