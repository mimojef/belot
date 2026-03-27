import { BID_ORDER } from './biddingConfig.js'

export function getBidOrder(startPlayer = 'bottom') {
  const startIndex = BID_ORDER.indexOf(startPlayer)

  if (startIndex === -1) {
    return [...BID_ORDER]
  }

  return [
    ...BID_ORDER.slice(startIndex),
    ...BID_ORDER.slice(0, startIndex),
  ]
}

export function getNextBidPlayer(currentPlayer) {
  const currentIndex = BID_ORDER.indexOf(currentPlayer)

  if (currentIndex === -1) {
    return BID_ORDER[0]
  }

  return BID_ORDER[(currentIndex + 1) % BID_ORDER.length]
}