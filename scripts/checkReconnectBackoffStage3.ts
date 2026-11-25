/**
 * checkReconnectBackoffStage3.ts — Етап 3: прогресивната пауза между
 * свързванията не се нулира, докато тихото възстановяване на активна стая не
 * е завършило; 'online' не я заобикаля многократно; нулира се след успех.
 *
 *   [B1] отваряне на socket-а: нулиране само извън тихо възстановяване на активна стая
 *   [B2] бързо падащи връзки в активна стая: паузите растат 1, 2, 3, 4, 5, 5 s
 *        (досега: ~1 s всеки път)
 *   [B3] 'online': незабавно свързване веднъж на прекъсване; следващите —
 *        паузата остава; лоби — както досега; при отворен socket — нищо
 *   [B4] окабеляване в main.ts: onOpen, onRecovered, handleBrowserOnline, ново прекъсване
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkReconnectBackoffStage3.ts
 */
import { readFileSync } from 'node:fs'
import { decideBrowserOnlineReconnect, getReconnectDelayMs, shouldResetReconnectBackoffOnOpen } from '../src/app/network/socketReconnectPolicy'

let passed = 0
let failed = 0
function check(label: string, fn: () => void): void {
  try { fn(); passed += 1; console.log(`  PASS  ${label}`) } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

console.log('\ncheckReconnectBackoffStage3\n')

check('[B1] отваряне: нулиране само извън тихо възстановяване на активна стая', () => {
  assert(shouldResetReconnectBackoffOnOpen(null), 'без прекъсване')
  assert(shouldResetReconnectBackoffOnOpen('lobby'), 'лоби — както досега')
  assert(!shouldResetReconnectBackoffOnOpen('active_room'), 'активна стая — без нулиране')
})

check('[B2] бързо падащи връзки в активна стая: паузите растат (1, 2, 3, 4, 5, 5 s), не се връщат на 1 s', () => {
  // Повтаря main.ts: onOpen (нулиране по политиката) -> close -> scheduleServerReconnect.
  const simulate = (outage: 'active_room' | null): number[] => {
    let reconnectAttempt = 0
    const delays: number[] = []
    for (let i = 0; i < 6; i++) {
      if (shouldResetReconnectBackoffOnOpen(outage)) reconnectAttempt = 0 // onOpen
      delays.push(getReconnectDelayMs(reconnectAttempt, 1_000, 5_000, () => 0.5)) // onClose -> schedule
      reconnectAttempt += 1
    }
    return delays
  }
  assert(simulate('active_room').join(',') === '1000,2000,3000,4000,5000,5000', simulate('active_room').join(','))
  assert(simulate(null).join(',') === '1000,1000,1000,1000,1000,1000', `извън прекъсване: ${simulate(null).join(',')}`)
})

check("[B3] 'online': веднъж незабавно на прекъсване; после паузата остава; лоби — както досега", () => {
  assert(decideBrowserOnlineReconnect({ outageContext: 'active_room', socketConnected: false, fastReconnectUsed: false }) === 'connect_now', 'първо')
  assert(decideBrowserOnlineReconnect({ outageContext: 'active_room', socketConnected: false, fastReconnectUsed: true }) === 'keep_backoff', 'второ')
  assert(decideBrowserOnlineReconnect({ outageContext: 'active_room', socketConnected: true, fastReconnectUsed: false }) === 'none', 'отворен socket')
  assert(decideBrowserOnlineReconnect({ outageContext: 'lobby', socketConnected: false, fastReconnectUsed: true }) === 'connect_now', 'лоби')
})

check('[B4] окабеляване в main.ts', () => {
  const main = readFileSync('src/main.ts', 'utf8').replace(/\r\n/g, '\n')
  assert(main.includes('if (shouldResetReconnectBackoffOnOpen(lobbySoftReconnect.getOutageContext())) reconnectAttempt = 0'), 'onOpen не ползва политиката')
  assert(!/\n    reconnectAttempt = 0\n/.test(main), 'остава безусловно нулиране при onOpen')
  const recovered = main.slice(main.indexOf('  onRecovered: (context, info) => {'), main.indexOf('  onRecovered: (context, info) => {') + 900)
  assert(recovered.includes('reconnectAttempt = 0') && recovered.includes('onlineFastReconnectUsed = false'), 'onRecovered не нулира')
  const online = main.slice(main.indexOf('  function handleBrowserOnline(): void {'), main.indexOf('  function handleBrowserOnline(): void {') + 1200)
  assert(online.includes('decideBrowserOnlineReconnect(') && online.includes("if (outageContext === 'active_room') onlineFastReconnectUsed = true") && online.includes('scheduleServerReconnect()'), 'handleBrowserOnline')
  const newOutage = main.slice(main.indexOf('      activeRoomSoftReconnectMismatch = false\n      silentReconnectAttemptProofs = []'), main.indexOf('      activeRoomSoftReconnectMismatch = false\n      silentReconnectAttemptProofs = []') + 150)
  assert(newOutage.includes('onlineFastReconnectUsed = false'), 'ново прекъсване не нулира флага')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
