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
  pushGamesList: (playing: unknown[], finished: unknown[]) => {
    controller.handleServerMessage({ type: 'private_games_list', playing, finished } as any)
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
}
