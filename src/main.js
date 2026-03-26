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

// Рендер след пас
function passBidAndRender() {
  game.passBid()
  renderGame()
}

// Рендер след боя
function bidSuitAndRender(suit) {
  game.bidSuit(suit)
  renderGame()
}

// Рендер след всичко коз
function bidAllTrumpsAndRender() {
  game.bidAllTrumps()
  renderGame()
}

// Рендер след без коз
function bidNoTrumpsAndRender() {
  game.bidNoTrumps()
  renderGame()
}

// Рендер след контра
function doubleBidAndRender() {
  game.doubleBid()
  renderGame()
}

// Рендер след ре контра
function redoubleBidAndRender() {
  game.redoubleBid()
  renderGame()
}

// Рендер след игра на карта
function playCardAndRender(cardId) {
  game.playCard(cardId)
  renderGame()
}

// Рендер след цепене
function cutDeckAndDealAndRender(cutIndex = null) {
  game.cutDeckAndDeal(cutIndex)
  renderGame()
}

// Рендер при потвърждение за цепене
function confirmCutAndRender(cutIndex = null) {
  game.confirmCut(cutIndex)
  renderGame()
}

// Следващ рунд
function startNextRoundAndRender() {
  game.startNextRound()
  renderGame()
}

// Нова игра
function startNewGameAndRender() {
  game.startNewGame()
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
window.cutDeckAndDealAndRender = cutDeckAndDealAndRender
window.confirmCutAndRender = confirmCutAndRender
window.startNextRoundAndRender = startNextRoundAndRender
window.startNewGameAndRender = startNewGameAndRender