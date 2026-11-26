// Fixture за checkSvaraMainLobbyEntry.ts — РЕАЛНИЯТ createLobbyFlowController
// + renderLobbyScreen (през Vite), регистриран профил без backend.
// ?access=1|0 — сървърният сигнал session.svaraTestAccess (true = флаг + роля
// или „Достъпна за всички“); ?role=player|admin. WS съобщенията идват през
// controller.handleServerMessage — същия път като в main.ts.
import '/src/style.css'
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'
import { __setLudoFeatureFlagOverrideForTests } from '/src/app/games/ludo/ludoFeatureFlag.ts'

const params = new URLSearchParams(window.location.search)
__setLudoFeatureFlagOverrideForTests(true)

const calls: string[] = []
const root = document.getElementById('app') as HTMLElement
const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  getAuthSession: () => ({
    account: { role: params.get('role') ?? 'player' },
    profile: { profileId: 'harness-player', displayName: 'Играч', level: 1, yellowCoinsBalance: 120000 },
    svaraTestAccess: params.get('access') === '1',
  }) as any,
  onMatchRoomsLoad: () => Promise.resolve({ ok: true as const, rooms: [{ stakeAmount: 5000, minLevel: 1, prizeAmount: 8000, isEnabled: true }] }),
  onSvaraTablesOpen: () => { calls.push('onSvaraTablesOpen') },
} as any)

controller.setConnected(true)
controller.handleServerMessage({ type: 'connected', clientId: 'harness-client', message: 'ok' } as any)

const table = (matchId: string, phase: 'lobby' | 'in-progress') => ({
  matchId, phase, capacity: 2, entryFee: 5000, startMode: 'auto', creatorId: 'other', players: [{ playerId: 'other', status: 'active' }],
})

;(window as any).__svaraMainLobby = {
  calls,
  sendTables: (phases: Array<'lobby' | 'in-progress'>) => {
    controller.handleServerMessage({ type: 'svara_tables_list', tables: phases.map((phase, i) => table(`m${i}`, phase)), finished: [] } as any)
  },
}
