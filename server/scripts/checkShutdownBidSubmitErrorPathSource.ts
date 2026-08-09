/**
 * checkShutdownBidSubmitErrorPathSource.ts
 *
 * Static source-text regression за server-side частта на bid-submit freeze
 * fix-а (виж createActiveRoomFlowController.ts bid-response watchdog в
 * клиента, scripts/checkBidSubmitRecovery.ts за пълния client-side тест).
 *
 * Root cause: isShutdownGuardedClientMessage guard-ът в index.ts правеше
 * мълчалив `return` за 'submit_bid_action' по време на graceful shutdown
 * (SIGTERM) — без snapshot, без error — оставяйки клиента заклещен в
 * pending/faded popup state завинаги (markBiddingPopupPending() няма
 * self-recovery), докато не поеме client-side watchdog-ът (bounded
 * fallback, не заместител на този fix).
 *
 * ЗАЩО STATIC, НЕ dynamic spawn+SIGTERM тест: изпробвано е —
 * child.kill('SIGTERM') на Windows НЕ вика process.on('SIGTERM', ...)
 * handler-а в детето (Node.js/libuv на Windows превежда SIGTERM в
 * безусловно TerminateProcess, без grace период) — потвърдено емпирично с
 * минимален repro (chield процес с чист SIGTERM handler никога не го
 * извиква). Динамичен end-to-end тест на graceful shutdown затова не е
 * изпълним на Windows dev машина. Static source-text проверка остава
 * значима регресионна защита (в същия established pattern като
 * scripts/checkBiddingBoardLifecycle.ts в frontend-а) — пази точния fix,
 * без да претендира за runtime покритие, което тази среда не може да даде.
 *
 * Пази срещу връщане към този бъг:
 *  A) isShutdownGuardedClientMessage guard-ът, приложен преди submit_bid_action
 *     обработката, explicit-но праща error съобщение за 'submit_bid_action'.
 *  B) Error съобщението използва съществуващия sendJsonMessage/{type:'error'}
 *     contract — не изобретен нов WS message type.
 *  C) Fix-ът е скопиран само до submit_bid_action — не разширен blanket за
 *     всички isShutdownGuardedClientMessage типове (умишлено ограничен scope).
 *  D) submit_bid_action остава в isShutdownGuardedClientMessage switch-а
 *     (guard-ът все още важи за него, само отговорът се промени).
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const INDEX_PATH = join(REPO_ROOT, 'src', 'index.ts')

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: string): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err))
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

console.log('\ncheckShutdownBidSubmitErrorPathSource\n')

const indexSrc = await readFile(INDEX_PATH, 'utf8')

const shutdownGuardMatch = indexSrc.match(
  /if \(isServerShuttingDown && isShutdownGuardedClientMessage\(message\)\) \{([\s\S]*?)\n\s*return\s*\n\s*\}/,
)

await check('[1] isServerShuttingDown shutdown guard block still exists in the message handler', () => {
  assert(shutdownGuardMatch !== null, 'не намерих if (isServerShuttingDown && isShutdownGuardedClientMessage(message)) { ... return } блока в index.ts')
})

const guardBody = shutdownGuardMatch?.[1] ?? ''

await check("[2] guard блокът explicit-но проверява message.type === 'submit_bid_action'", () => {
  assert(
    /message\.type === 'submit_bid_action'/.test(guardBody),
    'guard блокът вече не съдържа explicit клон за submit_bid_action',
  )
})

await check('[3] submit_bid_action клонът праща error съобщение (не мълчалив return)', () => {
  const submitBidBlockMatch = guardBody.match(/if \(message\.type === 'submit_bid_action'\) \{([\s\S]*?)\}/)
  assert(submitBidBlockMatch !== null, 'не намерих if (message.type === \'submit_bid_action\') { ... } вътре в guard блока')
  const body = submitBidBlockMatch![1]
  assert(/type: 'error'/.test(body), 'submit_bid_action клонът трябва да праща {type:\'error\', ...} по съществуващия error contract')
  assert(/sendJsonMessage\(socket,/.test(body), 'submit_bid_action клонът трябва да ползва съществуващия sendJsonMessage(socket, ...) helper')
})

await check('[4] fix-ът е скопиран само до submit_bid_action — останалите shutdown-guarded типове нямат явен error клон', () => {
  const otherGuardedTypes = [
    'create_room', 'join_room', 'join_matchmaking', 'join_guest_trial',
    'leave_matchmaking', 'resume_room', 'leave_active_room',
    'submit_cut_index', 'submit_play_card', 'resume_human_control',
  ]
  for (const t of otherGuardedTypes) {
    assert(
      !new RegExp(`message\\.type === '${t}'`).test(guardBody),
      `guard блокът не биваше да има explicit клон за '${t}' — fix-ът е скопиран умишлено само до submit_bid_action`,
    )
  }
})

await check("[5] submit_bid_action остава в isShutdownGuardedClientMessage switch-а (guard-ът все още важи за него)", () => {
  const switchMatch = indexSrc.match(/function isShutdownGuardedClientMessage\(message: ClientMessage\): boolean \{([\s\S]*?)\n\}/)
  assert(switchMatch !== null, 'не намерих isShutdownGuardedClientMessage функцията')
  assert(
    /case 'submit_bid_action':/.test(switchMatch![1]),
    "submit_bid_action трябваше да остане в switch-а на isShutdownGuardedClientMessage",
  )
})

const broadcastPath = join(REPO_ROOT, 'src', 'core', 'broadcastRoomSnapshots.ts')
const broadcastSrc = await readFile(broadcastPath, 'utf8')

await check('[6] broadcastRoomSnapshots логва diagnostic warning при skip заради isConnected/connectionId', () => {
  assert(
    /console\.warn/.test(broadcastSrc) && /participant not marked connected/.test(broadcastSrc),
    'очаквах console.warn diagnostic при !participant.isConnected/липсващ connectionId skip',
  )
})

await check('[7] broadcastRoomSnapshots логва diagnostic warning при skip заради non-sendable socket', () => {
  assert(
    /socket not sendable/.test(broadcastSrc),
    'очаквах console.warn diagnostic при липсващ/не-OPEN socket skip',
  )
})

await check('[8] broadcastRoomSnapshots не логва profileId/displayName (без чувствителни данни)', () => {
  const warnLines = broadcastSrc.split('\n').filter((l) => l.includes('console.warn'))
  for (const line of warnLines) {
    assert(!/profileId|displayName/.test(line), `warn лог не биваше да съдържа profileId/displayName: ${line.trim()}`)
  }
})

await check('[9] broadcastRoomSnapshots семантиката (кои seats получават snapshot) не е променена — само добавени логове', () => {
  assert(
    /if \(!socket \|\| socket\.readyState !== WebSocket\.OPEN\) \{/.test(broadcastSrc),
    'socket-sendability проверката трябваше да остане непроменена',
  )
  assert(
    /if \(participant === null \|\| participant\.kind !== 'human'\) \{/.test(broadcastSrc),
    'null/bot participant проверката трябваше да остане непроменена',
  )
})

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
