/**
 * checkLocalTournamentRoomBotDelay.ts
 *
 * Regression за per-room bot action delay в local tournament test mode
 * (resolveServerBotActionDelayMs, server/src/game/serverTimerStateHelpers.ts)
 * — позволява на one_human тестов турнир човекът да завърши своя semifinal
 * бързо (ботовете на неговата маса реагират за
 * BELOT_LOCAL_TOURNAMENT_HUMAN_ROOM_BOT_MS), докато sibling bot-vs-bot
 * semifinal-ът остава наблюдаемо in_progress по-дълго (реагира за
 * BELOT_LOCAL_TOURNAMENT_SIBLING_BOT_MS), за да може unified STATE A/STATE B
 * inter-round екранът да се наблюдава реално в браузъра.
 *
 * Покрива:
 *  [1] human-containing room -> humanRoomBotDelayMs (500ms default).
 *  [2] bot-only room -> siblingBotOnlyRoomBotDelayMs (1500ms default).
 *  [3] извън local tournament test mode -> productionDelayMs непроменен,
 *      независимо от players състава (никакво local-test поведение изтича).
 *  [4] няма зависимост от room/tournament UUID — resolveServerBotActionDelayMs
 *      приема само (ServerAuthoritativeGameState, productionDelayMs), няма
 *      id параметър; и трите createServerXTimerState wrapper-а стигат до
 *      идентичен резултат за идентичен players състав, независимо какъв
 *      match/room ги е извикал.
 *  [5] env override-и (BELOT_LOCAL_TOURNAMENT_HUMAN_ROOM_BOT_MS/
 *      _SIBLING_BOT_MS) реално се четат.
 *  [6] submitServerPlayCard's winnerTimerStartedAt пресмятане ползва СЪЩИЯ
 *      resolver (без него start/duration biha били несъвместими за bot
 *      победител на trick — виж коментара при извикването там).
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ok ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('\n═══ checkLocalTournamentRoomBotDelay ═══')

// Env трябва да е сетнат ПРЕДИ модулния import само за
// isLocalTournamentTestModeEnabled() (guard-ва цялото test mode) — самата
// resolveServerBotActionDelayMs/getLocalTournamentTestRoomBotDelayOverrides
// четат process.env при ВСЯКО извикване (не кешират при module load, за
// разлика от старото SERVER_TIMING_CONFIG), затова може безопасно да се
// toggle-ва между отделните test case-ове по-долу без re-import.
delete process.env.BELOT_LOCAL_TOURNAMENT_TEST_MODE
process.env.NODE_ENV = 'test'

const { resolveServerBotActionDelayMs } = await import('../src/game/serverTimerStateHelpers.js')
const {
  createServerCuttingTimerState,
  createServerBiddingTimerState,
  createServerPlayingTimerState,
} = await import('../src/game/serverTimerStateHelpers.js')

type MinimalState = { players: Record<string, { mode: 'human' | 'bot' }> }

function humanContainingState(): MinimalState {
  return {
    players: {
      bottom: { mode: 'human' },
      right: { mode: 'bot' },
      top: { mode: 'bot' },
      left: { mode: 'bot' },
    },
  }
}

function botOnlyState(): MinimalState {
  return {
    players: {
      bottom: { mode: 'bot' },
      right: { mode: 'bot' },
      top: { mode: 'bot' },
      left: { mode: 'bot' },
    },
  }
}

const PRODUCTION_FALLBACK_MS = 800

await check('[3] outside local tournament test mode: production fallback is returned unchanged, regardless of players composition', () => {
  delete process.env.BELOT_LOCAL_TOURNAMENT_TEST_MODE
  process.env.NODE_ENV = 'test'
  const humanResult = resolveServerBotActionDelayMs(humanContainingState() as any, PRODUCTION_FALLBACK_MS)
  const botOnlyResult = resolveServerBotActionDelayMs(botOnlyState() as any, PRODUCTION_FALLBACK_MS)
  assert(humanResult === PRODUCTION_FALLBACK_MS, `expected production fallback ${PRODUCTION_FALLBACK_MS} for human-containing room outside local test mode, got ${humanResult}`)
  assert(botOnlyResult === PRODUCTION_FALLBACK_MS, `expected production fallback ${PRODUCTION_FALLBACK_MS} for bot-only room outside local test mode, got ${botOnlyResult}`)
})

await check('[3b] local test mode flag set but NODE_ENV=production: still production fallback (guard requires BOTH conditions)', () => {
  process.env.BELOT_LOCAL_TOURNAMENT_TEST_MODE = '1'
  process.env.NODE_ENV = 'production'
  const result = resolveServerBotActionDelayMs(humanContainingState() as any, PRODUCTION_FALLBACK_MS)
  assert(result === PRODUCTION_FALLBACK_MS, `expected production fallback ${PRODUCTION_FALLBACK_MS} when NODE_ENV=production despite the flag, got ${result}`)
  process.env.NODE_ENV = 'test'
})

await check('[1] local tournament test mode + human-containing room -> humanRoomBotDelayMs default (500ms)', () => {
  process.env.BELOT_LOCAL_TOURNAMENT_TEST_MODE = '1'
  process.env.NODE_ENV = 'test'
  delete process.env.BELOT_LOCAL_TOURNAMENT_HUMAN_ROOM_BOT_MS
  delete process.env.BELOT_LOCAL_TOURNAMENT_SIBLING_BOT_MS
  const result = resolveServerBotActionDelayMs(humanContainingState() as any, PRODUCTION_FALLBACK_MS)
  assert(result === 500, `expected default humanRoomBotDelayMs 500, got ${result}`)
})

await check('[2] local tournament test mode + bot-only room -> siblingBotOnlyRoomBotDelayMs default (1500ms)', () => {
  process.env.BELOT_LOCAL_TOURNAMENT_TEST_MODE = '1'
  process.env.NODE_ENV = 'test'
  delete process.env.BELOT_LOCAL_TOURNAMENT_HUMAN_ROOM_BOT_MS
  delete process.env.BELOT_LOCAL_TOURNAMENT_SIBLING_BOT_MS
  const result = resolveServerBotActionDelayMs(botOnlyState() as any, PRODUCTION_FALLBACK_MS)
  assert(result === 1500, `expected default siblingBotOnlyRoomBotDelayMs 1500, got ${result}`)
})

await check('[5] env overrides are actually read (not just the hardcoded defaults)', () => {
  process.env.BELOT_LOCAL_TOURNAMENT_TEST_MODE = '1'
  process.env.NODE_ENV = 'test'
  process.env.BELOT_LOCAL_TOURNAMENT_HUMAN_ROOM_BOT_MS = '111'
  process.env.BELOT_LOCAL_TOURNAMENT_SIBLING_BOT_MS = '2222'
  const humanResult = resolveServerBotActionDelayMs(humanContainingState() as any, PRODUCTION_FALLBACK_MS)
  const siblingResult = resolveServerBotActionDelayMs(botOnlyState() as any, PRODUCTION_FALLBACK_MS)
  assert(humanResult === 111, `expected env-overridden humanRoomBotDelayMs 111, got ${humanResult}`)
  assert(siblingResult === 2222, `expected env-overridden siblingBotOnlyRoomBotDelayMs 2222, got ${siblingResult}`)
  delete process.env.BELOT_LOCAL_TOURNAMENT_HUMAN_ROOM_BOT_MS
  delete process.env.BELOT_LOCAL_TOURNAMENT_SIBLING_BOT_MS
})

await check('[4] no room/tournament UUID dependency: identical players composition -> identical result, regardless of which "match" called it', () => {
  process.env.BELOT_LOCAL_TOURNAMENT_TEST_MODE = '1'
  process.env.NODE_ENV = 'test'
  // Two structurally-identical human-containing states, standing in for two
  // completely different rooms/matches (no id field exists on
  // ServerAuthoritativeGameState for the resolver to key off of at all) —
  // must resolve to the same delay.
  const roomA = resolveServerBotActionDelayMs(humanContainingState() as any, PRODUCTION_FALLBACK_MS)
  const roomB = resolveServerBotActionDelayMs(humanContainingState() as any, PRODUCTION_FALLBACK_MS)
  assert(roomA === roomB, 'two structurally-identical human-containing states resolved to different delays — suggests hidden non-deterministic or id-based state')
})

await check('[integration] createServerCuttingTimerState/createServerBiddingTimerState/createServerPlayingTimerState route bot seats through the room-aware resolver', () => {
  process.env.BELOT_LOCAL_TOURNAMENT_TEST_MODE = '1'
  process.env.NODE_ENV = 'test'
  delete process.env.BELOT_LOCAL_TOURNAMENT_HUMAN_ROOM_BOT_MS
  delete process.env.BELOT_LOCAL_TOURNAMENT_SIBLING_BOT_MS

  const humanState = humanContainingState() as any
  const cuttingTimer = createServerCuttingTimerState(humanState, 'right') // bot seat
  const biddingTimer = createServerBiddingTimerState(humanState, 'top') // bot seat
  const playingTimer = createServerPlayingTimerState(humanState, 'left') // bot seat
  assert(cuttingTimer.durationMs === 500, `expected cutting timer 500ms for bot seat in human-containing room, got ${cuttingTimer.durationMs}`)
  assert(biddingTimer.durationMs === 500, `expected bidding timer 500ms for bot seat in human-containing room, got ${biddingTimer.durationMs}`)
  assert(playingTimer.durationMs === 500, `expected playing timer 500ms for bot seat in human-containing room, got ${playingTimer.durationMs}`)

  const botOnly = botOnlyState() as any
  const siblingCuttingTimer = createServerCuttingTimerState(botOnly, 'bottom')
  assert(siblingCuttingTimer.durationMs === 1500, `expected cutting timer 1500ms for bot-only room, got ${siblingCuttingTimer.durationMs}`)

  // The human seat's OWN timer must stay on the unrelated *HumanTimeoutMs
  // constants (20000ms) — this change only touches bot-controlled seats.
  const humanSeatTimer = createServerCuttingTimerState(humanState, 'bottom')
  assert(humanSeatTimer.durationMs === 20000, `human seat's own timer should stay at the human timeout (20000ms), got ${humanSeatTimer.durationMs}`)
})

await check('source: resolveServerBotActionDelayMs has no room/tournament id parameter or reference', async () => {
  const projectRoot = join(process.cwd(), '..')
  const source = await readFile(join(projectRoot, 'server', 'src', 'game', 'serverTimerStateHelpers.ts'), 'utf8')
  const fnStart = source.indexOf('export function resolveServerBotActionDelayMs(')
  assert(fnStart !== -1, 'resolveServerBotActionDelayMs not found/not exported')
  const fnEnd = source.indexOf('\n}', fnStart)
  const fnBody = source.slice(fnStart, fnEnd)
  assert(!/roomId|tournamentId|matchId|\broom:/i.test(fnBody), 'resolveServerBotActionDelayMs references a room/tournament id — should be derived purely from state.players')
  assert(fnBody.includes('state.players'), 'resolveServerBotActionDelayMs does not inspect state.players at all')
  assert(fnBody.includes('isLocalTournamentTestModeEnabled()'), 'resolveServerBotActionDelayMs does not gate on local test mode')
})

await check('[6] submitServerPlayCard reuses the same resolver for the bot-winner trick-collection timing offset', async () => {
  const projectRoot = join(process.cwd(), '..')
  const source = await readFile(join(projectRoot, 'server', 'src', 'game', 'submitServerPlayCard.ts'), 'utf8')
  assert(source.includes('resolveServerBotActionDelayMs'), 'submitServerPlayCard does not import/use resolveServerBotActionDelayMs')
  assert(
    source.includes('timerStartsAt - resolveServerBotActionDelayMs(nextState, SERVER_TIMING_CONFIG.playBotDelayMs)'),
    'submitServerPlayCard still subtracts the raw (non-room-aware) SERVER_TIMING_CONFIG.playBotDelayMs — would desync from the room-aware duration added back inside createServerPlayingTimerState',
  )
})

await check('source: production SERVER_TIMING_CONFIG constants are untouched (cutBotDelayMs/bidBotDelayMs/playBotDelayMs still exist as the fallback path)', async () => {
  const projectRoot = join(process.cwd(), '..')
  const source = await readFile(join(projectRoot, 'server', 'src', 'game', 'serverTimingConfig.ts'), 'utf8')
  assert(source.includes('cutBotDelayMs: localBotActionDelayMs ?? 800'), 'production cutBotDelayMs fallback (800ms) changed')
  assert(source.includes('bidBotDelayMs: localBotActionDelayMs ?? 800'), 'production bidBotDelayMs fallback (800ms) changed')
  assert(source.includes('playBotDelayMs: localBotActionDelayMs ?? 800'), 'production playBotDelayMs fallback (800ms) changed')
})

console.log('\n' + '═'.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
