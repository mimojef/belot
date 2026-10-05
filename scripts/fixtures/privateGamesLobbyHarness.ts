// Браузърна тестова "сглобка" (fixture) за checkPrivateGamesLobbyTabs.ts —
// кара реалния production код (createLobbyFlowController +
// renderLobbyScreen), зареден през Vite dev server (без build, без jsdom), в
// истински браузър (Playwright). Server push съобщенията (private_rooms_list,
// private_games_list, private_game_score_updated) се подават директно през
// controller.handleServerMessage(...) — точно по пътя, по който main.ts
// подава реални WS кадри. Самият екран/DOM/CSS под тест е 100% истинският
// production render код, не мокап. Mirror на privateRoomWaitingHarness.ts
// конвенцията (виж него за rationale на подхода).
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'

const root = document.createElement('div')
document.body.appendChild(root)

type RecordedCall = { name: string; args: unknown[] }
const calls: RecordedCall[] = []

function record(name: string) {
  return (...args: unknown[]) => {
    calls.push({ name, args })
  }
}

// Belot Spectator Mode VIP gate — configurable mock responses (виж
// checkBelotSpectatorWatchVipFlow.ts). Default: gate още не е "resolved"
// (getVipGateStatusResponse() връща null) значи ensureTopicsVipGateLoaded
// не пише нищо в state — тестовете explicit сетват сценарий преди click.
let vipGateStatusResponse: { ok: true; isActive: boolean; hasClaimedLaunchGift: boolean; launchGiftDays: number } | { ok: false } = { ok: false }
let claimLaunchGiftResponse: { ok: true; isActive: boolean; activeUntil?: string | null } | { ok: false; alreadyClaimed: boolean; giftDisabled: boolean } = { ok: false, alreadyClaimed: false, giftDisabled: false }

const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  getAuthSession: () => ({
    account: { role: 'player' },
    profile: { profileId: 'me', displayName: 'Me' } as any,
  }),
  onPrivateRoomsOpen: record('onPrivateRoomsOpen'),
  onPrivateRoomsClose: record('onPrivateRoomsClose'),
  onPrivateGamesOpen: record('onPrivateGamesOpen'),
  onPrivateRoomCreate: record('onPrivateRoomCreate'),
  onPrivateRoomJoinSlot: record('onPrivateRoomJoinSlot'),
  onPrivateRoomLeave: record('onPrivateRoomLeave'),
  onPrivateRoomInvite: record('onPrivateRoomInvite'),
  onPrivateRoomInviteRespond: record('onPrivateRoomInviteRespond'),
  onPrivateRoomAddBot: record('onPrivateRoomAddBot'),
  onPrivateRoomRemoveBot: record('onPrivateRoomRemoveBot'),
  onPrivateRoomChatSubscribe: record('onPrivateRoomChatSubscribe'),
  onPrivateRoomChatUnsubscribe: record('onPrivateRoomChatUnsubscribe'),
  onPrivateRoomChatSend: record('onPrivateRoomChatSend'),
  onWatchBelotRoom: record('onWatchBelotRoom'),
  onUnwatchBelotRoom: record('onUnwatchBelotRoom'),
  onGetTopicsVipGateStatus: async () => {
    record('onGetTopicsVipGateStatus')()
    return vipGateStatusResponse
  },
  onClaimTopicsLaunchGift: async () => {
    record('onClaimTopicsLaunchGift')()
    return claimLaunchGiftResponse
  },
})

function q<T extends Element>(selector: string): T | null {
  return document.querySelector<T>(selector)
}

;(window as any).__privateGamesLobbyHarness = {
  controller,
  navigateToPrivateRooms: () => controller.navigateToPrivateRooms(),
  pushRoomsList: (rooms: unknown[]) => {
    controller.handleServerMessage({ type: 'private_rooms_list', rooms } as any)
  },
  pushGamesList: (playing: unknown[], finished: unknown[], belotSpectatingEnabled = false) => {
    controller.handleServerMessage({ type: 'private_games_list', playing, finished, belotSpectatingEnabled } as any)
  },
  pushGameScoreUpdate: (roomId: string, teamAScore: number, teamBScore: number) => {
    controller.handleServerMessage({ type: 'private_game_score_updated', roomId, teamAScore, teamBScore } as any)
  },
  clickLifecycleTab: (tab: 'waiting' | 'playing' | 'finished') => {
    q<HTMLButtonElement>(`[data-private-rooms-lifecycle-tab="${tab}"]`)?.click()
  },
  getActiveLifecycleTab: (): string | null => {
    const activeBtn = q<HTMLButtonElement>('[data-private-rooms-lifecycle-tab][data-active="true"]')
    return activeBtn?.dataset.privateRoomsLifecycleTab ?? null
  },
  getTabButtonText: (tab: 'waiting' | 'playing' | 'finished'): string | null => {
    return q<HTMLButtonElement>(`[data-private-rooms-lifecycle-tab="${tab}"]`)?.textContent?.trim() ?? null
  },
  // Резултатът е под всеки отбор поотделно (два отделни елемента, "a"/"b" —
  // виж matchTeamScoreRowHtml в renderLobbyScreen.ts), не един комбиниран
  // "X : Y" текст.
  getTeamScoreText: (roomId: string, team: 'a' | 'b'): string | null => {
    const els = document.querySelectorAll<HTMLElement>(`[data-private-game-score="${roomId}"]`)
    for (const el of els) {
      if (el.dataset.privateGameScoreTeam === team) return el.textContent?.trim() ?? null
    }
    return null
  },
  getCurrentScreen: () => controller.getCurrentScreen(),
  getVisibleEmptyStateText: (): string | null => {
    // Empty state text is a plain centered leaf div — must match its OWN
    // textContent exactly (not merely "contains", which would match every
    // ancestor div up to the root too, since textContent concatenates all
    // descendants).
    const candidates = Array.from(root.querySelectorAll<HTMLElement>('div'))
    const match = candidates.find((el) => {
      const text = (el.textContent ?? '').trim()
      return (
        text === 'В момента няма чакащи частни маси.' ||
        text === 'В момента няма играещи частни маси.' ||
        text === 'Няма приключили частни игри през последните 2 часа.'
      )
    })
    return match?.textContent?.trim() ?? null
  },
  getScrollTop: (): number => root.scrollTop,
  setScrollTop: (value: number) => { root.scrollTop = value },
  getCalls: () => calls,
  clearCalls: () => { calls.length = 0 },
  destroy: () => controller.destroy(),

  // ─── Belot Spectator Mode ("Гледай", Phase 3A) ────────────────────────
  hasWatchButton: (roomId: string): boolean => q(`[data-watch-belot-room="${roomId}"]`) !== null,
  clickWatchBelotRoom: (roomId: string) => {
    q<HTMLButtonElement>(`[data-watch-belot-room="${roomId}"]`)?.click()
  },
  setVipGateStatusResponse: (response: typeof vipGateStatusResponse) => { vipGateStatusResponse = response },
  setClaimLaunchGiftResponse: (response: typeof claimLaunchGiftResponse) => { claimLaunchGiftResponse = response },
  isBelotSpectatorVipPopupOpen: (): boolean => q('[data-belot-spectator-vip-popup-backdrop="1"]') !== null,
  getBelotSpectatorVipPopupCardText: (): string | null =>
    q<HTMLElement>('[data-belot-spectator-vip-popup-card="1"]')?.textContent?.trim() ?? null,
  clickBelotSpectatorVipPopupClaim: () => {
    q<HTMLButtonElement>('[data-belot-spectator-vip-popup-claim="1"]')?.click()
  },
  clickBelotSpectatorVipPopupGoToShop: () => {
    q<HTMLButtonElement>('[data-belot-spectator-vip-popup-go-to-shop="1"]')?.click()
  },
  clickBelotSpectatorVipPopupClose: () => {
    q<HTMLButtonElement>('[data-belot-spectator-vip-popup-close="1"]')?.click()
  },
  pushBelotSpectateStarted: (roomId: string) => {
    controller.handleServerMessage({ type: 'belot_spectate_started', roomId } as any)
  },
  pushBelotSpectateDenied: (roomId: string, code: string, message: string) => {
    controller.handleServerMessage({ type: 'belot_spectate_denied', roomId, code, message } as any)
  },
  pushBelotSpectateEnded: (roomId: string, reason: string) => {
    controller.handleServerMessage({ type: 'belot_spectate_ended', roomId, reason } as any)
  },
  pushBelotSpectatorSnapshot: (roomId: string) => {
    controller.handleServerMessage({
      type: 'belot_spectator_snapshot',
      viewerRole: 'spectator',
      roomId,
      roomStatus: 'playing',
      yourSeat: null,
      reconnectToken: null,
      seats: [],
      game: null,
      stakeAmount: null,
      isGuestTrial: false,
      isPrivateTableOrigin: true,
      isTournamentMatchOrigin: false,
      activeTableGifts: [],
    } as any)
  },
  pushConnected: () => {
    controller.handleServerMessage({ type: 'connected', clientId: 'c1', message: 'ok' } as any)
  },
  getSpectatingBelotRoomId: (): string | null => controller.getSpectatingBelotRoomId(),
  getPendingBelotSpectatorRoomId: (): string | null => controller.getPendingBelotSpectatorRoomId(),
  getBelotSpectatorSnapshotRoomId: (): string | null => controller.getBelotSpectatorSnapshotRoomId(),
  unwatchBelotSpectatorRoom: () => controller.unwatchBelotSpectatorRoom(),
  getShopActiveTab: (): string => controller.getShopActiveTab(),
}
