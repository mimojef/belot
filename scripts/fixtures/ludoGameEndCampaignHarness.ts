// Фаза 7 — browser harness за Ludo финалния popup "спечелени тематични
// единици" visual regression (checkLudoGameEndCampaignCredit.ts). Mirror
// на established ludoAuthoritativeHarness.ts pattern (реалния
// createLudoFlowController + createLudoAuthoritativeInitialState от
// server/src/game/ludoEngine/, не mock engine) — доказва РЕАЛНИЯ production
// код, не reimplementation.
import { createLudoFlowController } from '/src/app/games/ludo/createLudoFlowController.ts'
import { createLudoAuthoritativeInitialState } from '/server/src/game/ludoEngine/ludoEngineState.ts'
import type { LudoGameStateSnapshot, CampaignMatchCreditSnapshot } from '/src/app/network/createGameServerClient.ts'

const root = document.createElement('div')
document.body.appendChild(root)

type Controller = ReturnType<typeof createLudoFlowController>
let controller: Controller | null = null
let campaignRequestCount = 0
let lastRequestedMatchId: string | null = null
let currentMatchId = ''
let matchCounter = 0

function buildSnapshot(matchId: string, finished: boolean, winnerColor: 'red' | 'blue' | null): LudoGameStateSnapshot {
  const state = createLudoAuthoritativeInitialState(['red', 'blue'])
  const finishedState = finished
    ? { ...state, status: 'finished' as const, winnerColor }
    : state
  return {
    matchId,
    ludoRoomId: `room-${matchId}`,
    stake: 100,
    revision: finished ? 1 : 0,
    serverNow: Date.now(),
    deadlineAt: null,
    players: [
      { profileId: 'p-red', displayName: 'Red', avatarUrl: null, color: 'red' },
      { profileId: 'p-blue', displayName: 'Blue', avatarUrl: null, color: 'blue' },
    ],
    state: finishedState as LudoGameStateSnapshot['state'],
    events: [],
    botControlledColors: [],
    winnerProfileId: null,
  }
}

// Mount-ва ФРЕШЕН controller instance с НЕ-приключила начална snapshot —
// mirror на production openLudoGameOverlay() (ВСЕКИ нов мач = нов
// controller instance, виж createLudoFlowController.ts matchEndedCampaignCredit
// doc коментара за пълния rationale).
function mount(localColor: 'red' | 'blue' = 'red'): void {
  controller?.destroy()
  campaignRequestCount = 0
  lastRequestedMatchId = null
  matchCounter += 1
  currentMatchId = `ludo-match-${matchCounter}`
  const initialSnapshot = buildSnapshot(currentMatchId, false, null)
  const players = {
    red: { color: 'red' as const, name: 'Red', avatarUrl: null, isBot: false },
    blue: { color: 'blue' as const, name: 'Blue', avatarUrl: null, isBot: false },
    green: { color: 'green' as const, name: 'Не участва', avatarUrl: null, isBot: true },
    yellow: { color: 'yellow' as const, name: 'Не участва', avatarUrl: null, isBot: true },
  }
  controller = createLudoFlowController({
    root,
    players,
    localColor,
    onExit: () => {},
    onGameEndAcknowledged: () => {},
    authoritative: {
      initialSnapshot,
      onRollRequest: () => {},
      onMoveRequest: () => {},
      onReclaimRequest: () => {},
      onCampaignMatchCreditRequest: (matchId) => {
        campaignRequestCount += 1
        lastRequestedMatchId = matchId
      },
    },
  })
}

// Mount-ва spectator controller (виж mountLudoSpectatorController в
// createLobbyFlowController.ts) — НИКОГА не би трябвало да извика
// onCampaignMatchCreditRequest (виж task spec §8 "губещ/spectator не вижда
// награда").
function mountSpectator(): void {
  controller?.destroy()
  campaignRequestCount = 0
  lastRequestedMatchId = null
  matchCounter += 1
  currentMatchId = `ludo-match-spectator-${matchCounter}`
  const initialSnapshot = buildSnapshot(currentMatchId, false, null)
  const players = {
    red: { color: 'red' as const, name: 'Red', avatarUrl: null, isBot: false },
    blue: { color: 'blue' as const, name: 'Blue', avatarUrl: null, isBot: false },
    green: { color: 'green' as const, name: 'Не участва', avatarUrl: null, isBot: true },
    yellow: { color: 'yellow' as const, name: 'Не участва', avatarUrl: null, isBot: true },
  }
  controller = createLudoFlowController({
    root,
    players,
    localColor: undefined,
    viewMode: 'spectator',
    onExit: () => {},
    onGameEndAcknowledged: () => {},
    authoritative: {
      initialSnapshot,
      onRollRequest: () => {},
      onMoveRequest: () => {},
      onReclaimRequest: () => {},
      onCampaignMatchCreditRequest: (matchId) => {
        campaignRequestCount += 1
        lastRequestedMatchId = matchId
      },
    },
  })
}

// Live win transition (mirror на production applyAuthoritativeSnapshot's
// "previous.status !== 'finished' && snapshot.state.status === 'finished'"
// пътя) — реалистично задвижва presentGameEndOnce(), не директен internal
// call. prizeAmount подаден отделно, mirror на LudoGameStateMessage's
// top-level поле.
function finishMatch(winnerColor: 'red' | 'blue', prizeAmount: number | null): void {
  if (!controller) return
  const finishedSnapshot = buildSnapshot(currentMatchId, true, winnerColor)
  controller.applyAuthoritativeSnapshot(finishedSnapshot, prizeAmount)
}

function simulateCampaignCreditResult(credit: CampaignMatchCreditSnapshot | null): void {
  if (!controller || lastRequestedMatchId === null) return
  controller.applyCampaignMatchCreditResult(lastRequestedMatchId, credit)
}

function dismissPopup(): void {
  document.querySelector<HTMLButtonElement>('[data-ludo-game-end-dismiss="1"]')?.click()
}

;(window as unknown as { __ludoGameEndCampaignHarness: unknown }).__ludoGameEndCampaignHarness = {
  mount,
  mountSpectator,
  finishMatch,
  simulateCampaignCreditResult,
  dismissPopup,
  getCampaignRequestCount: () => campaignRequestCount,
  getLastRequestedMatchId: () => lastRequestedMatchId,
}
