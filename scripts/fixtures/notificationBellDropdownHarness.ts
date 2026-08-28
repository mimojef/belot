// Real createLobbyFlowController() (not a mock), loaded through the Vite dev
// server — see checkNotificationBellDropdown.ts. Regression for the bell
// dropdown appearing "stuck" — bell click changed state.notificationsOpen but
// syncNotificationsDropdown() (which mounts the dropdown on document.body,
// outside root.innerHTML) was only ever reached AFTER the skip-if-unchanged
// guard in renderLobbyScreen.ts, and notificationsOpen never affects
// nextRootHtml — so the guard's early `return` skipped it on every bell
// click. The dropdown only appeared once some OTHER render produced a
// genuinely different nextRootHtml (e.g. navigating screens), and the same
// guard then blocked every subsequent close (bell click again, or backdrop
// click) from ever reaching the syncNotificationsDropdown() call that would
// have removed the fixed, full-viewport backdrop.
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'

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

controller.render()

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

function clickBell(): void {
  (root.querySelector('[data-lobby-nav-bell="1"]') as HTMLElement | null)?.click()
}

function clickBackdrop(): void {
  (document.querySelector('[data-notifications-backdrop="1"]') as HTMLElement | null)?.click()
}

function isDropdownInDom(): boolean {
  return document.querySelector('[data-notifications-backdrop="1"]') !== null
}

function backdropCoversViewport(): boolean {
  const el = document.querySelector('[data-notifications-backdrop="1"]') as HTMLElement | null
  if (el === null) return false
  const style = getComputedStyle(el)
  return style.position === 'fixed' && style.inset === '0px'
}

function clickSomewhereElseOnPage(): void {
  // A click target that is NOT the bell and NOT the dropdown/backdrop —
  // proxy for "the rest of the site is clickable".
  (root.querySelector('[data-lobby-nav-back="1"]') as HTMLElement | null)?.click()
    ?? (document.body.click())
}

;(window as any).__notificationBellDropdownHarness = {
  clickBellAndFlush: async (): Promise<void> => {
    clickBell()
    await flush()
  },
  clickBackdropAndFlush: async (): Promise<void> => {
    clickBackdrop()
    await flush()
  },
  triggerUnrelatedRender: async (): Promise<void> => {
    // Simulates a WS event unrelated to the bell (e.g. lobby_chat_message) —
    // any handler that calls the generic render().
    controller.handleServerMessage({
      type: 'lobby_chat_message',
      seq: Math.floor(Math.random() * 1_000_000),
      messageId: `msg-${Math.random()}`,
      senderProfileId: 'other-player',
      senderDisplayName: 'Other Player',
      senderIsChatAdmin: false,
      senderRole: 'player',
      body: 'hello',
      createdAt: new Date().toISOString(),
    } as any)
    await flush()
  },
  isDropdownVisible: (): boolean => isDropdownInDom(),
  backdropCoversViewport,
  clickBellButton: (): void => clickBell(),
  clickElsewhereAndFlush: async (): Promise<void> => {
    clickSomewhereElseOnPage()
    await flush()
  },
  isBellButtonPresent: (): boolean => root.querySelector('[data-lobby-nav-bell="1"]') !== null,
}
