import './style.css'
import { bootstrapApp } from './app/bootstrap'
import { renderApp } from './app/renderApp'
import { runPlayingBotsUntilHumanTurn } from './app/runPlayingBotsUntilHumanTurn'
import { createBelotePromptController } from './app/playPrompts/createBelotePromptController'

const rootElement = document.querySelector<HTMLDivElement>('#app')

if (!rootElement) {
  throw new Error('Root element #app was not found.')
}

const appRoot = rootElement
const app = bootstrapApp()

let resizeFrameId: number | null = null

function syncPlayingBotsAndRender(): void {
  runPlayingBotsUntilHumanTurn(app)
  render()
}

function render(): void {
  renderApp(appRoot, app, {
    onNextPhaseClick: () => {
      app.engine.goToNextPhase()
      syncPlayingBotsAndRender()
    },
    onSelectCutIndex: (cutIndex: number) => {
      app.engine.selectCutIndex(cutIndex)
      syncPlayingBotsAndRender()
    },
    onResolveCutClick: () => {
      app.engine.resolveCutPhase()
      syncPlayingBotsAndRender()
    },
    onBidPass: () => {
      app.engine.submitBidAction({ type: 'pass' })
      syncPlayingBotsAndRender()
    },
    onBidSuit: (suit) => {
      app.engine.submitBidAction({ type: 'suit', suit })
      syncPlayingBotsAndRender()
    },
    onBidNoTrumps: () => {
      app.engine.submitBidAction({ type: 'no-trumps' })
      syncPlayingBotsAndRender()
    },
    onBidAllTrumps: () => {
      app.engine.submitBidAction({ type: 'all-trumps' })
      syncPlayingBotsAndRender()
    },
    onBidDouble: () => {
      app.engine.submitBidAction({ type: 'double' })
      syncPlayingBotsAndRender()
    },
    onBidRedouble: () => {
      app.engine.submitBidAction({ type: 'redouble' })
      syncPlayingBotsAndRender()
    },
    onPlayCard: (cardId) => {
      const didOpenBelotePrompt = belotePromptController.handlePlayCard(cardId)

      if (didOpenBelotePrompt) {
        return
      }

      app.engine.submitPlayCard(cardId)
      syncPlayingBotsAndRender()
    },
  })

  belotePromptController.renderPendingPrompt()
}

const belotePromptController = createBelotePromptController({
  app,
  render,
})

window.addEventListener('resize', () => {
  if (resizeFrameId !== null) {
    window.cancelAnimationFrame(resizeFrameId)
  }

  resizeFrameId = window.requestAnimationFrame(() => {
    resizeFrameId = null
    render()
  })
})

syncPlayingBotsAndRender()