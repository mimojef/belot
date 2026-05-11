import './style.css'

import { createActiveRoomFlowController } from './app/activeRoom/createActiveRoomFlowController'
import {
  isMatchEndedPreviewRequest,
  renderMatchEndedPreview,
} from './app/activeRoom/previewMatchEndedScreen'
import { createGameAudioController } from './app/audio/createGameAudioController'
import {
  createLobbyFlowController,
  type LobbyFlowController,
} from './app/lobby/createLobbyFlowController'
import type { AvatarCropSelection } from './app/lobby/renderLobbyScreen'
import {
  createGameServerClient,
  type GameServerClient,
  type PlayerPublicProfileSnapshot,
} from './app/network/createGameServerClient'
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
let lobby: LobbyFlowController
const gameAudio = createGameAudioController()
const SERVER_RESTART_WAIT_MESSAGE = 'Изчаква се рестарт на сървъра.'
const SERVER_RESUME_WAIT_MESSAGE = 'Възстановяване на играта...'
const SERVER_CONNECTION_ERROR_MESSAGE = 'Възникна грешка при връзката със сървъра.'
const SERVER_RECONNECT_DELAY_MS = 1_000
const SERVER_RECONNECT_MAX_DELAY_MS = 5_000
const MAX_PROFILE_GALLERY_IMAGES = 6

let reconnectTimerId: number | null = null
let reconnectAttempt = 0
let isPageUnloading = false
let isRefreshingAuthConnection = false
let currentAuthSession: AuthSession | null = null

type AuthSession = {
  sessionId: string
  account: {
    accountId: string
    email: string
    role: string
    status: string
  }
  profile: PlayerPublicProfileSnapshot
}

type AuthResponse = {
  ok: boolean
  session?: AuthSession | null
  message?: string
}

type PlayersResponse = {
  ok: boolean
  players?: PlayerPublicProfileSnapshot[]
  message?: string
}

function getApiBaseUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:'
  const host = window.location.hostname || 'localhost'
  return `${protocol}//${host}:3001`
}

async function readAuthResponse(response: Response): Promise<AuthResponse> {
  try {
    return (await response.json()) as AuthResponse
  } catch {
    return {
      ok: false,
      message: 'Невалиден отговор от сървъра.',
    }
  }
}

function syncLobbyWithAuthSession(): void {
  if (currentAuthSession === null) {
    return
  }

  lobby.setDisplayName(currentAuthSession.profile.displayName)
  lobby.setLocalAvatarUrl(currentAuthSession.profile.avatarUrl)
}

function refreshGameServerConnectionForAuth(): void {
  isRefreshingAuthConnection = true
  clearReconnectTimer()
  client.disconnect()
  lobby.setConnected(false)

  window.setTimeout(() => {
    if (!isRefreshingAuthConnection) {
      return
    }

    isRefreshingAuthConnection = false
    client.connect()
  }, 80)
}

async function loadAuthSession(): Promise<void> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/auth/me`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = await readAuthResponse(response)
    currentAuthSession = data.ok ? data.session ?? null : null
    syncLobbyWithAuthSession()
    lobby.render()
  } catch {
    currentAuthSession = null
  }
}

async function submitAuthRequest(
  endpoint: 'login' | 'register',
  body: Record<string, string>,
): Promise<string | null> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/auth/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify(body),
    })
    const data = await readAuthResponse(response)

    if (!response.ok || !data.ok || !data.session) {
      return data.message ?? 'Заявката не беше успешна.'
    }

    currentAuthSession = data.session
    syncLobbyWithAuthSession()
    refreshGameServerConnectionForAuth()
    return null
  } catch {
    return 'Няма връзка със сървъра за профили.'
  }
}

async function loadPlayersDirectory(): Promise<
  | { ok: true; players: PlayerPublicProfileSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/players`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as PlayersResponse

    if (!response.ok || !data.ok || !Array.isArray(data.players)) {
      return {
        ok: false,
        message: data.message ?? 'Списъкът с играчи не беше зареден.',
      }
    }

    return {
      ok: true,
      players: data.players,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за играчи.',
    }
  }
}

function validateImageFile(file: File): string | null {
  const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp'])

  if (!allowedTypes.has(file.type)) {
    return 'Позволени са само jpg, png и webp снимки.'
  }

  if (file.size > 5_000_000) {
    return 'Снимката трябва да е до 5 MB.'
  }

  return null
}

async function fileToDataUrl(file: File): Promise<string> {
  const validationError = validateImageFile(file)

  if (validationError !== null) {
    throw new Error(validationError ?? undefined)
  }

  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      resolve(String(reader.result ?? ''))
    })
    reader.addEventListener('error', () => {
      reject(new Error('Снимката не можа да бъде прочетена.'))
    })
    reader.readAsDataURL(file)
  })
}

async function imageFileToServerUploadDataUrl(
  file: File,
  _options: { mode: 'avatar' | 'gallery' },
): Promise<string> {
  return fileToDataUrl(file)
}

async function submitProfileImageData(
  endpoint: 'avatar' | 'gallery',
  imageDataUrl: string,
  crop?: AvatarCropSelection,
): Promise<AuthResponse> {
  const response = await fetch(`${getApiBaseUrl()}/api/profile/me/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({
      imageDataUrl,
      ...(crop
        ? {
            cropX: crop.x,
            cropY: crop.y,
            cropSize: crop.size,
          }
        : {}),
    }),
  })
  const data = await readAuthResponse(response)

  if (!response.ok || !data.ok || !data.session) {
    throw new Error(data.message ?? 'Профилът не беше обновен.')
  }

  return data
}

async function deleteProfileGalleryImage(imageId: string): Promise<string | null> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/profile/me/gallery/${encodeURIComponent(imageId)}`,
      {
        method: 'DELETE',
        credentials: 'include',
      },
    )
    const data = await readAuthResponse(response)

    if (!response.ok || !data.ok || !data.session) {
      return data.message ?? 'Снимката не беше изтрита.'
    }

    currentAuthSession = data.session
    syncLobbyWithAuthSession()
    return null
  } catch {
    return 'Няма връзка със сървъра за профили.'
  }
}

async function submitProfileUpdate(
  avatarFile: File | null,
  avatarCrop: AvatarCropSelection | null,
  galleryFiles: File[],
): Promise<string | null> {
  if (avatarFile === null && galleryFiles.length === 0) {
    return 'Избери снимка за аватар или галерия.'
  }

  try {
    const currentGalleryCount =
      currentAuthSession?.profile.galleryImages.length ?? 0
    const remainingGallerySlots = Math.max(
      0,
      MAX_PROFILE_GALLERY_IMAGES - currentGalleryCount,
    )

    if (galleryFiles.length > remainingGallerySlots) {
      return `Галерията може да има най-много ${MAX_PROFILE_GALLERY_IMAGES} снимки.`
    }

    if (avatarFile !== null) {
      if (avatarCrop === null) {
        return 'Очертай квадрат върху снимката за аватар.'
      }

      const imageDataUrl = await fileToDataUrl(avatarFile)
      const data = await submitProfileImageData('avatar', imageDataUrl, avatarCrop)
      currentAuthSession = data.session ?? currentAuthSession
    }

    for (const galleryFile of galleryFiles.slice(0, remainingGallerySlots)) {
      const imageDataUrl = await imageFileToServerUploadDataUrl(galleryFile, {
        mode: 'gallery',
      })
      const data = await submitProfileImageData('gallery', imageDataUrl)
      currentAuthSession = data.session ?? currentAuthSession
    }

    syncLobbyWithAuthSession()
    return null
  } catch (error) {
    return error instanceof Error
      ? error.message
      : 'Няма връзка със сървъра за профили.'
  }
}

lobby = createLobbyFlowController({
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
  getAuthSession: () => currentAuthSession,
  onLoginSubmit: (email, password) =>
    submitAuthRequest('login', {
      email,
      password,
    }),
  onRegisterSubmit: (displayName, email, password) =>
    submitAuthRequest('register', {
      displayName,
      email,
      password,
    }),
  onProfileEditSubmit: (avatarFile, avatarCrop, galleryFiles) =>
    submitProfileUpdate(avatarFile, avatarCrop, galleryFiles),
  onProfileGalleryDelete: (imageId) => deleteProfileGalleryImage(imageId),
  onPlayersLoad: () => loadPlayersDirectory(),
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
  submitPartnerRating: (roomId, ratingValue) => {
    client.submitPartnerRating(roomId, ratingValue)
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
    if (isRefreshingAuthConnection) {
      isRefreshingAuthConnection = false
      lobby.setConnected(false)
      client.connect()
      return
    }

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
void loadAuthSession()
client.connect()
}
