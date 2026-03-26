import { renderCuttingScreen } from './renderCuttingScreen.js'
import { renderCurrentTrick } from './renderCurrentTrick.js'

export function renderCenterContent(phase, currentTrick, gameState = {}, statusText = '') {
  if (phase === 'cutting') {
    return renderCuttingScreen(gameState, statusText)
  }

  if (currentTrick.length > 0) {
    return renderCurrentTrick(currentTrick)
  }

  return ''
}
