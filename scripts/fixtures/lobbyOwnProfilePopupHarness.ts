// Real createLobbyFlowController() (not a mock), loaded through the Vite dev
// server — see checkLobbyOwnProfilePopup.ts. Regression for the Lobby own-
// profile entry points (avatar click, "ПРОФИЛ" link click — both render
// [data-lobby-profile-button="1"]) appearing to do nothing, while the exact
// same canonical own-profile popup opened correctly from the Players
// directory card click.
//
// ROOT CAUSE: onProfileClick (createLobbyFlowController.ts) set
// state.profilePopupOpen/profilePopupProfile/profilePopupCanEdit and called
// the generic render(). The profile popup lives on document.body (outside
// root.innerHTML, via syncProfilePopup/renderPopupOnly) — render() ->
// renderLobbyScreen() has a skip-if-unchanged guard on root.innerHTML, and
// none of the popup-open state fields affect that string, so the guard's
// early return meant syncProfilePopup() (itself only called from inside
// renderLobbyScreen(), after the guard) was never reached — the click
// appeared to do nothing. The working Players-card path
// (openProtectedProfileById's isOwn branch) already called
// renderPopupOnly() directly for exactly this reason.
//
// FIX: onProfileClick now calls renderPopupOnly() directly, mirroring the
// already-working Players-card own-profile path.
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
    profile: { profileId: 'me', displayName: 'Me', likesCount: 0 } as any,
  }),
})

controller.render()

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

function isPopupOpen(): boolean {
  return document.querySelector('[data-player-profile-popup-root="1"]') !== null
}

;(window as any).__lobbyOwnProfilePopupHarness = {
  isPopupOpen: (): boolean => isPopupOpen(),
  clickAvatarAndFlush: async (): Promise<void> => {
    const buttons = root.querySelectorAll<HTMLElement>('[data-lobby-profile-button="1"]')
    ;(buttons[0] ?? null)?.click()
    await flush()
  },
  clickProfileLinkAndFlush: async (): Promise<void> => {
    const buttons = root.querySelectorAll<HTMLElement>('[data-lobby-profile-button="1"]')
    ;(buttons[1] ?? buttons[0] ?? null)?.click()
    await flush()
  },
  closePopupAndFlush: async (): Promise<void> => {
    (document.querySelector('[data-player-profile-popup-close="1"]') as HTMLElement | null)?.click()
    await flush()
  },
  getProfileButtonCount: (): number => root.querySelectorAll('[data-lobby-profile-button="1"]').length,
}
