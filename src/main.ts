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
const SERVER_RESTART_WAIT_MESSAGE = 'Изчаква се рестарт на сървъра.'
const SERVER_RESUME_WAIT_MESSAGE = 'Възстановяване на играта...'
const SERVER_CONNECTION_ERROR_MESSAGE = 'Възникна грешка при връзката със сървъра.'
const SERVER_RECONNECT_DELAY_MS = 1_000
const SERVER_RECONNECT_MAX_DELAY_MS = 5_000

let reconnectTimerId: number | null = null
let reconnectAttempt = 0
let isPageUnloading = false

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

function clearReconnectTimer(): void {
  if (reconnectTimerId === null) {
    return
  }

  window.clearTimeout(reconnectTimerId)
  reconnectTimerId = null
}

function scheduleServerReconnect(): void {
  if (isPageUnloading || reconnectTimerId !== null) {
    return
  }

  const delayMs = Math.min(
    SERVER_RECONNECT_DELAY_MS + reconnectAttempt * SERVER_RECONNECT_DELAY_MS,
    SERVER_RECONNECT_MAX_DELAY_MS,
  )

  reconnectAttempt += 1
  reconnectTimerId = window.setTimeout(() => {
    reconnectTimerId = null
    client.connect()
  }, delayMs)
}

function requestActiveRoomResume(): boolean {
  const resumeInfo = activeRoom.getResumeInfo()

  if (resumeInfo === null) {
    return false
  }

  client.resumeRoom(resumeInfo.roomId, resumeInfo.reconnectToken)
  return true
}

client = createGameServerClient({
  onOpen: () => {
    clearReconnectTimer()
    reconnectAttempt = 0

    if (activeRoom.hasActiveRoom()) {
      activeRoom.setConnectionState(true, SERVER_RESUME_WAIT_MESSAGE)
      requestActiveRoomResume()
      return
    }

    lobby.setConnected(true)
    lobby.setErrorText(null)
  },
  onClose: () => {
    if (activeRoom.hasActiveRoom()) {
      activeRoom.setConnectionState(false, SERVER_RESTART_WAIT_MESSAGE)
      scheduleServerReconnect()
      return
    }

    lobby.setConnected(false)
    lobby.setErrorText(SERVER_RESTART_WAIT_MESSAGE)
    scheduleServerReconnect()
  },
  onError: () => {
    if (activeRoom.hasActiveRoom()) {
      activeRoom.setConnectionError(SERVER_CONNECTION_ERROR_MESSAGE)
      return
    }

    lobby.setErrorText(SERVER_CONNECTION_ERROR_MESSAGE)
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
  isPageUnloading = true
  clearReconnectTimer()
  disposeViewportResizeHandler()
  client.disconnect()
})

lobby.render()
client.connect()
}
