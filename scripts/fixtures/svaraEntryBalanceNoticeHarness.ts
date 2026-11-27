// Fixture за checkSvaraEntryBalanceNotice.ts — РЕАЛНИЯТ createLobbyFlowController
// + renderLobbyScreen (през Vite), регистриран профил без backend. Сървърните
// съобщения идват през controller.handleServerMessage — същия път като в main.ts.
import '/src/style.css'
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'
import { __setLudoFeatureFlagOverrideForTests } from '/src/app/games/ludo/ludoFeatureFlag.ts'

__setLudoFeatureFlagOverrideForTests(true)

const root = document.getElementById('app') as HTMLElement
const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  getAuthSession: () => ({
    account: { role: 'player' },
    profile: { profileId: 'harness-player', displayName: 'Играч', level: 1, yellowCoinsBalance: 7000 },
    svaraTestAccess: true,
  }) as any,
  onMatchRoomsLoad: () => Promise.resolve({ ok: true as const, rooms: [{ stakeAmount: 5000, minLevel: 1, prizeAmount: 8000, isEnabled: true }] }),
  onSvaraTablesOpen: () => {},
  onShopPackagesLoad: () => Promise.resolve({ ok: true as const, packages: [] }),
} as any)

controller.setConnected(true)
controller.handleServerMessage({ type: 'connected', clientId: 'harness-client', message: 'ok' } as any)

;(window as any).__svaraNotice = {
  sendError: (code: string, message: string) => controller.handleServerMessage({ type: 'svara_lobby_error', code, message } as any),
  screen: () => controller.getCurrentScreen(),
  shopTab: () => controller.getShopActiveTab(),
}
