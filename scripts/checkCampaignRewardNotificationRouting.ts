/**
 * checkCampaignRewardNotificationRouting.ts
 *
 * Регресия (Фаза 9): realtime push-ът `pending_campaign_reward_notifications`
 * пристига ТОЧНО при края на Белот мача, докато активната стая (End Game) още
 * съществува. Общият fallback в main.ts (`if (!activeRoom.hasActiveRoom())
 * lobby.handleServerMessage(message)`) го изпускаше -> опашката оставаше
 * празна и поздравлението не се показваше до следващ reconnect.
 *
 * Проверява, че в onMessage на createGameServerClient съобщението се подава
 * към lobby.handleServerMessage БЕЗУСЛОВНО и ПРЕДИ activeRoom fallback-а.
 * (Изчакването на безопасен момент е покрито от Q7 в
 * checkCampaignRewardCongratulationsCoinPurchase.ts.)
 *
 * Usage: npx tsx scripts/checkCampaignRewardNotificationRouting.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let passed = 0
let failed = 0
function check(label: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

console.log('\n═══ checkCampaignRewardNotificationRouting ═══\n')

const source = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8').replace(/\r\n/g, '\n')
const onMessageStart = source.indexOf('  onMessage: (message) => {')
const fallbackIndex = source.indexOf('    if (activeRoom.handleServerMessage(message)) {', onMessageStart)

check('onMessage и activeRoom fallback-ът са намерени', () => {
  assert(onMessageStart >= 0, 'onMessage handler not found in src/main.ts')
  assert(fallbackIndex > onMessageStart, 'activeRoom.handleServerMessage fallback not found inside onMessage')
})

check('pending_campaign_reward_notifications се подава към лобито безусловно, ПРЕДИ activeRoom fallback-а', () => {
  const branch = /\n    if \(message\.type === 'pending_campaign_reward_notifications'\) \{\n      lobby\.handleServerMessage\(message\)\n      return\n    \}/.exec(source.slice(onMessageStart))
  assert(branch !== null, 'expected an unconditional lobby.handleServerMessage branch for pending_campaign_reward_notifications')
  const branchIndex = onMessageStart + branch!.index
  assert(branchIndex < fallbackIndex, 'the branch must come BEFORE the activeRoom fallback (otherwise it is dropped while End Game is open)')
})

console.log(`\nPassed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
