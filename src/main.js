import './style.css'
import { players } from './data/players.js'
import { renderTableLayout } from './ui/tableLayout.js'
import { createGameEngine } from './core/gameEngine.js'

const game = createGameEngine()

function renderGame() {
  document.querySelector('#app').innerHTML = renderTableLayout(
    players,
    game.getStatusText(),
    game.getState().hands,
    game.getState()
  )
}

function passBidAndRender() {
  game.passBid()
  renderGame()
}

function bidSuitAndRender(suit) {
  game.bidSuit(suit)
  renderGame()
}

function bidAllTrumpsAndRender() {
  game.bidAllTrumps()
  renderGame()
}

function bidNoTrumpsAndRender() {
  game.bidNoTrumps()
  renderGame()
}

function doubleBidAndRender() {
  game.doubleBid()
  renderGame()
}

function redoubleBidAndRender() {
  game.redoubleBid()
  renderGame()
}

function playCardAndRender(cardId) {
  game.playCard(cardId)
  renderGame()
}

game.startNewGame()
renderGame()

window.game = game
window.renderGame = renderGame
window.passBidAndRender = passBidAndRender
window.bidSuitAndRender = bidSuitAndRender
window.bidAllTrumpsAndRender = bidAllTrumpsAndRender
window.bidNoTrumpsAndRender = bidNoTrumpsAndRender
window.doubleBidAndRender = doubleBidAndRender
window.redoubleBidAndRender = redoubleBidAndRender
window.playCardAndRender = playCardAndRender