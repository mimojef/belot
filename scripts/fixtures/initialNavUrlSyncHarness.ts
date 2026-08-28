// Real createLobbyFlowController() (not a mock), loaded through the Vite dev
// server — see checkInitialNavUrlSync.ts. Regression for the SPA URL never
// following normal in-app navigation after a fresh load (e.g. loading
// /chat, then clicking "Лоби": the UI switches to Lobby correctly, but
// window.location.pathname stays "/chat" forever — a refresh then re-opens
// Chat because the app reads the stale URL).
//
// ROOT CAUSE: createLobbyFlowController's navigateInitialPath() sets
// _pendingInitialNav = true when it runs before state.isConnected is true
// (a normal race with the WS handshake) — deferring the initial route
// resolution until the 'connected' server message arrives, at which point
// handleServerMessage('connected') is supposed to flip _pendingInitialNav
// back to false and call navigateFromPath(_loadPath). But main.ts's WS
// onMessage dispatcher intercepted 'connected' entirely for its own PWA
// bootstrap bookkeeping and never forwarded it to lobby.handleServerMessage
// — so _pendingInitialNav stayed true forever, and syncUrlPath() (called at
// the end of every render()) early-returns while it's true. The DOM still
// updated correctly (render() works regardless), but history.pushState was
// never invoked again after the very first (stuck) state.
//
// FIX: main.ts now forwards the 'connected' message to
// lobby.handleServerMessage(message) before running its own PWA bootstrap
// logic.
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'

// Simulates "the browser loaded /chat directly" — createLobbyFlowController
// captures window.location.pathname as _loadPath at construction time,
// exactly like main.ts does on a real page load.
history.pushState(null, '', '/chat')

const root = document.createElement('div')
document.body.appendChild(root)

const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  getAuthSession: () => ({
    account: { role: 'player' },
    profile: { profileId: 'me', displayName: 'Me' } as any,
  }),
})

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

;(window as any).__initialNavUrlSyncHarness = {
  // Mirrors main.ts's real bootstrap order: navigateInitialPath() runs
  // before the WS handshake resolves (state.isConnected is still false at
  // that point) — this is the normal race the bug depends on.
  runInitialNavBeforeConnected: async (): Promise<void> => {
    controller.navigateInitialPath()
    await flush()
  },
  simulateSetConnectedTrue: async (): Promise<void> => {
    controller.setConnected(true)
    await flush()
  },
  // Mirrors main.ts's onMessage dispatcher forwarding the real WS
  // 'connected' message to the lobby controller.
  simulateConnectedServerMessage: async (): Promise<void> => {
    controller.handleServerMessage({ type: 'connected' } as any)
    await flush()
  },
  getCurrentScreen: (): string => controller.getCurrentScreen(),
  getPathname: (): string => window.location.pathname,
  clickLobbyNavButton: async (): Promise<void> => {
    (root.querySelector('[data-lobby-nav-lobby="1"]') as HTMLElement | null)?.click()
    await flush()
  },
  clickPlayersNavButton: async (): Promise<void> => {
    (root.querySelector('[data-lobby-nav-players="1"]') as HTMLElement | null)?.click()
    await flush()
  },
  clickChatNavButton: async (): Promise<void> => {
    (root.querySelector('[data-lobby-nav-chat="1"]') as HTMLElement | null)?.click()
    await flush()
  },
  clickTopicsNavButton: async (): Promise<void> => {
    (root.querySelector('[data-lobby-nav-topics="1"]') as HTMLElement | null)?.click()
    await flush()
  },
  clickShopNavButton: async (): Promise<void> => {
    (root.querySelector('[data-lobby-nav-shop="1"]') as HTMLElement | null)?.click()
    await flush()
  },
  clickTournamentsNavButton: async (): Promise<void> => {
    (root.querySelector('[data-lobby-nav-tournaments="1"]') as HTMLElement | null)?.click()
    await flush()
  },
  goBack: async (): Promise<void> => {
    history.back()
    await flush()
  },
  goForward: async (): Promise<void> => {
    history.forward()
    await flush()
  },
}
