import './style.css'
import { bootstrapApp } from './app/bootstrap'
import { renderApp } from './app/renderApp'
import { createBelotePromptController } from './app/playPrompts/createBelotePromptController'

const rootElement = document.querySelector<HTMLDivElement>('#app')

if (!rootElement) {
  throw new Error('Root element #app was not found.')
}

const appRoot = rootElement
const app = bootstrapApp()

let resizeFrameId: number | null = null

function render(): void {
  renderApp(appRoot, app, {
    onNextPhaseClick: () => {
      app.engine.goToNextPhase()
      render()
    },
    onSelectCutIndex: (cutIndex: number) => {
      app.engine.selectCutIndex(cutIndex)
      render()
    },
    onResolveCutClick: () => {
      app.engine.resolveCutPhase()
      render()
    },
    onBidPass: () => {
      app.engine.submitBidAction({ type: 'pass' })
      render()
    },
    onBidSuit: (suit) => {
      app.engine.submitBidAction({ type: 'suit', suit })
      render()
    },
    onBidNoTrumps: () => {
      app.engine.submitBidAction({ type: 'no-trumps' })
      render()
    },
    onBidAllTrumps: () => {
      app.engine.submitBidAction({ type: 'all-trumps' })
      render()
    },
    onBidDouble: () => {
      app.engine.submitBidAction({ type: 'double' })
      render()
    },
    onBidRedouble: () => {
      app.engine.submitBidAction({ type: 'redouble' })
      render()
    },
    onPlayCard: (cardId) => {
      const didOpenBelotePrompt = belotePromptController.handlePlayCard(cardId)

      if (didOpenBelotePrompt) {
        return
      }

      app.engine.submitPlayCard(cardId)
      render()
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

render()