import './style.css'

import { createActiveRoomFlowController } from './app/activeRoom/createActiveRoomFlowController'
import {
  isMatchEndedPreviewRequest,
  renderMatchEndedPreview,
} from './app/activeRoom/previewMatchEndedScreen'
import { createGameAudioController } from './app/audio/createGameAudioController'
import { createLobbyFlowController } from './app/lobby/createLobbyFlowController'
import { createGameServerClient, type GameServerClient } from './app/network/createGameServerClient'
import { createViewportResizeHandler } from './ui/layout/viewportStage'

const rootElementCandidate = document.querySelector<HTMLDivElement>('#app')

if (!rootElementCandidate) {
  throw new Error('Root element #app was not found.')
}

const rootElement: HTMLDivElement = rootElementCandidate

if (isMatchEndedPreviewRequest()) {
  const renderPreview = (): void => {
    renderMatchEndedPreview(rootElement)
  }

  const disposeViewportResizeHandler = createViewportResizeHandler(renderPreview)

  window.addEventListener('beforeunload', () => {
    disposeViewportResizeHandler()
  })

  renderPreview()
} else {
let client: GameServerClient
const gameAudio = createGameAudioController()

const lobby = createLobbyFlowController({
  root: rootElement,
  joinMatchmaking: (stake, displayName) => {
    client.joinMatchmaking(stake, displayName)
  },
  leaveMatchmaking: () => {
    client.leaveMatchmaking()
  },
  onMatchFound: (message) => {
    activeRoom.enterActiveRoom(message)
  },
})

const activeRoom = createActiveRoomFlowController({
  root: rootElement,
  gameAudio,
  isConnected: () => client.isConnected(),
  leaveActiveRoom: (roomId) => {
    client.leaveActiveRoom(roomId)
  },
  submitCutIndex: (roomId, cutIndex) => {
    client.submitCutIndex(roomId, cutIndex)
  },
  submitBidAction: (roomId, action) => {
    client.submitBidAction(roomId, action)
  },
  submitPlayCard: (roomId, cardId, declarationKeys) => {
    client.submitPlayCard(roomId, cardId, declarationKeys)
  },
  resumeHumanControl: (roomId) => {
    client.resumeHumanControl(roomId)
  },
  showLobby: (errorText = null) => {
    lobby.setConnected(client.isConnected())
    lobby.resetToLobby()
    lobby.setErrorText(errorText)
  },
  startNewGame: (stake, displayName) => {
    lobby.setConnected(client.isConnected())
    lobby.startMatchmaking(stake, displayName)
  },
})

client = createGameServerClient({
  onOpen: () => {
    if (activeRoom.hasActiveRoom()) {
      activeRoom.setConnectionState(true, null)
      return
    }

    lobby.setConnected(true)
    lobby.setErrorText(null)
  },
  onClose: () => {
    if (activeRoom.hasActiveRoom()) {
      activeRoom.setConnectionState(false, 'Връзката със сървъра е прекъсната.')
      return
    }

    lobby.setConnected(false)
    lobby.setErrorText('Връзката със сървъра е прекъсната.')
  },
  onError: () => {
    if (activeRoom.hasActiveRoom()) {
      activeRoom.setConnectionError('Възникна грешка при връзката със сървъра.')
      return
    }

    lobby.setErrorText('Възникна грешка при връзката със сървъра.')
  },
  onMessage: (message) => {
    if (activeRoom.handleServerMessage(message)) {
      return
    }

    lobby.handleServerMessage(message)
  },
})

const disposeViewportResizeHandler = createViewportResizeHandler(() => {
  if (activeRoom.hasActiveRoom()) {
    activeRoom.render()
    return
  }

  lobby.render()
})

window.addEventListener('beforeunload', () => {
  disposeViewportResizeHandler()
  client.disconnect()
})

lobby.render()
client.connect()
}
