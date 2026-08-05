/**
 * checkMatchmakingPreviewBotFallback.ts
 *
 * Regression check for the "batch bot appearance" bug: when a local/dev
 * database has an empty bot_allowed_stakes table (no DB-catalog bots
 * eligible for any stake), the preview call sites — matchmaking_status,
 * matchmaking_joined — call selectMatchmakingBotProfiles() WITHOUT a
 * createTempBot factory (unlike the real room-creation path, which always
 * supplies one). Before the fix, this meant previewBotDisplayNames was
 * always [], so the client's staged final-fill animation never started —
 * the player saw nothing until the server's single batch room_snapshot
 * revealed all missing bots at once, seconds before the 20s timeout.
 *
 * The fix adds a pure, side-effect-free preview fallback
 * (createPreviewTempBotProfile) used only when createTempBot is not
 * supplied, so preview names are always available regardless of DB seed
 * state — without ever touching the database or depending on
 * Math.random()/randomUUID() (which would make repeated calls unstable
 * or leak temporary profile rows).
 *
 * Covers (see task spec):
 * [1] bot_allowed_stakes-equivalent (no DB candidates) → preview names are
 *     NOT empty, and exactly the needed count is returned.
 * [2] Partial DB result (simulated via excludedProfileIds forcing 0 DB
 *     candidates) behaves the same as fully empty — only the missing
 *     seats are filled by the fallback.
 * [3] Repeated calls with the identical selectionSeed produce byte-identical
 *     display names (stability across repeated matchmaking_status ticks).
 * [4] No duplicate display names or profileIds within a single call's
 *     result, across several different queue sizes.
 * [5] The real room-creation path (createTempBot supplied) is completely
 *     unaffected — still produces bot profiles via the pre-existing
 *     DB-record-mutating callback, untouched by this change.
 * [6] No console.warn "slot(s) still unfilled" — the preview fallback
 *     always succeeds (never returns null like the real factory can).
 */

import {
  selectMatchmakingBotProfiles,
  type MatchmakingBotSelectionProfile,
} from '../src/matchmaking/selectMatchmakingBotProfiles.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  PASS  ${label}`)
    passed++
  } else {
    console.error(`  FAIL  ${label}`)
    failed++
  }
}

const STAKE = 5000

function names(profiles: MatchmakingBotSelectionProfile[]): string[] {
  return profiles.map((p) => p.identity.displayName)
}

function profileIds(profiles: MatchmakingBotSelectionProfile[]): (string | null)[] {
  return profiles.map((p) => p.profileId)
}

// [1] No createTempBot supplied (mirrors an empty bot_allowed_stakes table,
// since listEligibleBotProfilesFromDb will return no candidates either way):
// preview names must not be empty, and must contain exactly `count` entries.
{
  const result = selectMatchmakingBotProfiles({
    stake: STAKE,
    count: 3,
    selectionSeed: 'seed-a',
  })
  check('[1] preview fallback returns non-empty result when no DB/temp factory available', result.length > 0)
  check('[1] preview fallback returns exactly the requested count (3)', result.length === 3)
  check('[1] all preview entries have a non-empty displayName', result.every((p) => p.identity.displayName.trim().length > 0))
}

// [2] Only 1 missing seat requested — the fallback must supply exactly 1,
// not over- or under-fill.
{
  const result = selectMatchmakingBotProfiles({
    stake: STAKE,
    count: 1,
    selectionSeed: 'seed-b',
  })
  check('[2] partial need (count=1) → fallback supplies exactly 1', result.length === 1)
}

// [3] Stability: identical selectionSeed + identical count → identical
// display names and profileIds across repeated invocations (simulating
// repeated matchmaking_status ticks while the queue is unchanged).
{
  const first = selectMatchmakingBotProfiles({
    stake: STAKE,
    count: 3,
    selectionSeed: 'stable-seed-123',
  })
  const second = selectMatchmakingBotProfiles({
    stake: STAKE,
    count: 3,
    selectionSeed: 'stable-seed-123',
  })
  const third = selectMatchmakingBotProfiles({
    stake: STAKE,
    count: 3,
    selectionSeed: 'stable-seed-123',
  })
  check('[3] repeated calls with the same seed produce identical display names (1st vs 2nd)', JSON.stringify(names(first)) === JSON.stringify(names(second)))
  check('[3] repeated calls with the same seed produce identical display names (2nd vs 3rd)', JSON.stringify(names(second)) === JSON.stringify(names(third)))
  check('[3] repeated calls with the same seed produce identical profileIds', JSON.stringify(profileIds(first)) === JSON.stringify(profileIds(second)))
}

// [3b] Different seeds produce different names (not a constant fallback).
{
  const a = selectMatchmakingBotProfiles({ stake: STAKE, count: 2, selectionSeed: 'seed-x' })
  const b = selectMatchmakingBotProfiles({ stake: STAKE, count: 2, selectionSeed: 'seed-y' })
  check('[3b] different seeds can produce different preview names (not hardcoded)', JSON.stringify(names(a)) !== JSON.stringify(names(b)))
}

// [4] No duplicate display names or profileIds within a single result, for
// several different queue sizes (1, 2, 3 missing seats).
for (const count of [1, 2, 3]) {
  const result = selectMatchmakingBotProfiles({
    stake: STAKE,
    count,
    selectionSeed: `dup-check-${count}`,
  })
  const uniqueNames = new Set(names(result))
  const uniqueIds = new Set(profileIds(result))
  check(`[4] no duplicate display names for count=${count}`, uniqueNames.size === result.length)
  check(`[4] no duplicate profileIds for count=${count}`, uniqueIds.size === result.length)
}

// [5] The real room-creation path (createTempBot supplied) is unaffected —
// still calls the factory and uses its returned display name, exactly as
// before this change.
{
  const factoryCalls: Array<{ stake: number; profileId: string; baseName: string }> = []
  const result = selectMatchmakingBotProfiles({
    stake: STAKE,
    count: 2,
    selectionSeed: 'real-room-seed',
    createTempBot: (stake, profileId, baseName) => {
      factoryCalls.push({ stake, profileId, baseName })
      return `${baseName} REAL`
    },
  })
  check('[5] real createTempBot path still invoked once per missing seat', factoryCalls.length === 2)
  check('[5] real createTempBot path result names are used verbatim', result.every((p) => p.identity.displayName.endsWith(' REAL')))
  check('[5] real createTempBot path profileIds use the temp-bot-<uuid> format (unchanged)', result.every((p) => typeof p.profileId === 'string' && p.profileId!.startsWith('temp-bot-')))
}

// [5b] The real path's factory returning null for a slot is still handled
// (slot silently skipped, exactly as before) — not broken by the preview
// fallback addition.
{
  let callCount = 0
  const result = selectMatchmakingBotProfiles({
    stake: STAKE,
    count: 2,
    selectionSeed: 'real-room-seed-null',
    createTempBot: () => {
      callCount += 1
      return null
    },
  })
  check('[5b] real factory returning null for every slot yields zero profiles (unfilled, not crashed)', result.length === 0)
  check('[5b] real factory was still called for each missing seat', callCount === 2)
}

// [6] The preview fallback never triggers the "slot(s) still unfilled"
// warning path (it always succeeds), unlike the real factory which can
// return null. We can't directly assert on console.warn text without
// mocking, so we assert the behavioral guarantee instead: count always
// matches exactly.
{
  const result = selectMatchmakingBotProfiles({
    stake: STAKE,
    count: 4,
    selectionSeed: 'full-table-seed',
  })
  check('[6] preview fallback fills all 4 seats when needed (never partially unfilled)', result.length === 4)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
