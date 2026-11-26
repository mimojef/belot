// Fixture за checkSvaraWalletRefresh.ts — РЕАЛНИЯТ createLobbyFlowController
// (през Vite), без backend. onSvaraWalletRefresh имитира main.ts
// (refreshAuthSessionInBackground → /api/auth/me → syncLobbyWithAuthSession):
// асинхронно взима „сървърния“ баланс и вика setDisplayName (render).
// ?profile=<id> — от чие име е сесията (победител / загубил).
import '/src/style.css'
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'

const params = new URLSearchParams(window.location.search)
const profileId = params.get('profile') ?? 'loser'
const session = {
  account: { role: 'player' },
  profile: { profileId, displayName: 'Играч', level: 1, yellowCoinsBalance: Number(params.get('balance') ?? 64000) },
  svaraTestAccess: true,
}
let serverBalance = session.profile.yellowCoinsBalance
const refreshCalls: number[] = []

const root = document.getElementById('app') as HTMLElement
const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  getAuthSession: () => session as any,
  onMatchRoomsLoad: () => Promise.resolve({ ok: true as const, rooms: [] }),
  onSvaraTablesOpen: () => {},
  onSvaraWalletRefresh: () => {
    refreshCalls.push(Date.now())
    setTimeout(() => {
      session.profile.yellowCoinsBalance = serverBalance
      controller.setDisplayName(session.profile.displayName)
    }, 0)
  },
} as any)

controller.setConnected(true)
controller.handleServerMessage({ type: 'connected', clientId: 'harness-client', message: 'ok' } as any)

const table = (matchId: string, phase: string, statuses: Record<string, string>) => ({
  matchId, phase, capacity: 2, entryFee: 15000, startMode: 'auto', creatorId: 'winner',
  players: Object.entries(statuses).map(([playerId, status]) => ({ playerId, status })),
})

;(window as any).__svaraWallet = {
  refreshCount: () => refreshCalls.length,
  setServerBalance: (value: number) => { serverBalance = value },
  tableUpdated: (matchId: string, phase: string, statuses: Record<string, string>) =>
    controller.handleServerMessage({ type: 'svara_table_updated', table: table(matchId, phase, statuses) } as any),
  tableLeft: (matchId: string) => controller.handleServerMessage({ type: 'svara_table_left', matchId } as any),
  shownBalance: () => session.profile.yellowCoinsBalance,
}
