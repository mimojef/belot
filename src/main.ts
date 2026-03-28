import './style.css'
import { bootstrapApp } from './app/bootstrap'
import { renderApp } from './app/renderApp'

const rootElement = document.querySelector<HTMLDivElement>('#app')

if (!rootElement) {
  throw new Error('Root element #app was not found.')
}

const app = bootstrapApp()

function render(): void {
  renderApp(rootElement, app, {
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
  })
}

render()