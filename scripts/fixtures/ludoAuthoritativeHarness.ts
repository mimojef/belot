import { createLudoFlowController } from '/src/app/games/ludo/createLudoFlowController.ts'
import { createLudoAuthoritativeInitialState } from '/server/src/game/ludoEngine/ludoEngineState.ts'
import type { LudoGameStateSnapshot } from '/src/app/network/createGameServerClient.ts'

const sounds: Record<string, number> = {}
class AudioStub {
  constructor(public src: string) {}
  play(): Promise<void> { sounds[this.src] = (sounds[this.src] ?? 0) + 1; return Promise.resolve() }
}
;(globalThis as unknown as { Audio: typeof Audio }).Audio = AudioStub as unknown as typeof Audio

const params = new URLSearchParams(location.search)
const localColor = params.get('color') === 'blue' ? 'blue' : 'red'
const players = {
  red: { color: 'red' as const, name: 'Red', avatarUrl: null, isBot: false },
  blue: { color: 'blue' as const, name: 'Blue', avatarUrl: null, isBot: false },
  green: { color: 'green' as const, name: 'Не участва', avatarUrl: null, isBot: true },
  yellow: { color: 'yellow' as const, name: 'Не участва', avatarUrl: null, isBot: true },
}
const initialSnapshot: LudoGameStateSnapshot = {
  matchId: 'match-1', ludoRoomId: 'room-1', stake: 100, revision: 0,
  serverNow: Date.now(), deadlineAt: Date.now() + 10_000,
  players: [
    { profileId: 'p-red', displayName: 'Red', avatarUrl: null, color: 'red' },
    { profileId: 'p-blue', displayName: 'Blue', avatarUrl: null, color: 'blue' },
  ],
  state: createLudoAuthoritativeInitialState(['red', 'blue']), events: [], botControlledColors: [], winnerProfileId: null,
}
const calls: unknown[] = []
const controller = createLudoFlowController({
  root: document.querySelector('#root')!, players, localColor,
  onExit: () => {},
  authoritative: {
    initialSnapshot,
    onRollRequest: (...args) => calls.push(['roll', ...args]),
    onMoveRequest: (...args) => calls.push(['move', ...args]),
    onReclaimRequest: (...args) => calls.push(['reclaim', ...args]),
  },
})

;(window as unknown as { __ludoAuthHarness: unknown }).__ludoAuthHarness = {
  apply: (snapshot: LudoGameStateSnapshot) => controller.applyAuthoritativeSnapshot(snapshot),
  sounds: () => ({ ...sounds }),
  calls: () => [...calls],
  pieceCell: (pieceId: string) => document.querySelector(`[data-ludo-piece="${pieceId}"]`)?.closest<HTMLElement>('[data-ludo-cell-pieces]')?.dataset.ludoCellPieces ?? null,
  diceVisible: () => document.querySelector('[data-ludo-dice-flight="1"]') !== null,
  endText: () => document.querySelector('[data-ludo-game-end-backdrop="1"]')?.textContent ?? '',
}
