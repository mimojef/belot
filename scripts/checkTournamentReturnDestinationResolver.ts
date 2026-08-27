/**
 * checkTournamentReturnDestinationResolver.ts
 *
 * Regression за критичните поправки на blocking "Поеми играта" modal
 * логиката (§ допълненията "КРИТИЧНО ДОПЪЛНЕНИЕ ПРЕДИ BROWSER QA", x2):
 *
 * ROOT CAUSE #1 (fixed in the first amendment): modal-ът се затваряше
 * директно при пристигане на `tournament_feeder_match_completed` —
 * приемайки match completion за elimination доказателство. Грешно: ако
 * bot-controlled team-ът СПЕЧЕЛИ, участието продължава (STATE A -> STATE B).
 *
 * ROOT CAUSE #2 (fixed in this second amendment): "active tournament
 * participation" (destination !== null от myActiveMatch/myInterRoundWaiting)
 * се третираше КАТО ДОКАЗАТЕЛСТВО за bot-replacement. Грешно: нормален
 * participant, който лично е играл semifinal-а си, ТЕЖДО се вижда в STATE
 * A/B — active participation показва КЪДЕ е играчът, не ДАЛИ е бил заместен.
 * Правилният authoritative predicate е `viewerHasUnresolvedBotReplacement`
 * (computed server-side от `tournament_match_no_show_replacements` — виж
 * `hasUnresolvedBotReplacement` в tournamentCoordinator.ts), проверен ПЪРВО,
 * ПРЕДИ каквото и да е destination computation.
 *
 * Част 1 [unit]: `isTournamentForceReturnRequired` / `resolveTournamentReturnDestination`
 * (src/app/lobby/resolveTournamentReturnDestination.ts) — двете отделни,
 * независими проверки, точно каквото поиска допълнението.
 *
 * Част 2 [source wiring]: main.ts гейтва blocking modal-а ИЗКЛЮЧИТЕЛНО на
 * isTournamentForceReturnRequired — never on raw active-participation
 * presence, never on the tournament_match_assigned push alone.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isTournamentForceReturnRequired, resolveTournamentReturnDestination } from '../src/app/lobby/resolveTournamentReturnDestination.ts'
import type { TournamentDetailSnapshot, TournamentMatchAssignmentSnapshot } from '../src/app/network/createGameServerClient.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
function check(label: string, fn: () => void): void {
  try {
    fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function baseAssignment(overrides: Partial<TournamentMatchAssignmentSnapshot> = {}): TournamentMatchAssignmentSnapshot {
  return {
    tournamentId: 't1',
    tournamentName: 'Test Tournament',
    matchId: 'm1',
    roomId: 'r1',
    roundType: 'semifinal',
    seat: 'bottom',
    teamId: 'teamA',
    partnerProfileId: 'partner1',
    opponentTeamId: 'teamB',
    reconnectToken: 'token-1',
    deadlineKind: 'first_match',
    attendanceDeadlineAt: null,
    gameStartAt: null,
    matchStatus: 'awaiting_players',
    ...overrides,
  }
}

function baseDetail(overrides: Partial<TournamentDetailSnapshot> = {}): TournamentDetailSnapshot {
  return {
    tournamentId: 't1',
    name: 'Test Tournament',
    myActiveMatch: null,
    myInterRoundWaiting: null,
    viewerHasUnresolvedBotReplacement: false,
    // The rest of TournamentDetailSnapshot's fields are irrelevant to the
    // resolver (it only reads myActiveMatch/myInterRoundWaiting/tournamentId/
    // name/viewerHasUnresolvedBotReplacement) — cast covers the remaining
    // required fields for the test.
    ...overrides,
  } as TournamentDetailSnapshot
}

function interRoundWaiting(nextMatchId: string | null): TournamentDetailSnapshot['myInterRoundWaiting'] {
  return {
    tournamentId: 't1',
    currentRoundType: 'semifinal',
    nextRoundType: 'final',
    completedMatchId: 'sf1',
    sibling: {
      matchId: 'sf2',
      roundIndex: 1,
      teamA: { teamId: 'teamC', status: 'locked', members: [] },
      teamB: { teamId: 'teamD', status: 'locked', members: [] },
      scoreA: null,
      scoreB: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    ownResultAcknowledged: true,
    otherFinalistReady: true,
    nextMatchId,
    nextRoomId: nextMatchId !== null ? 'final-room' : null,
    nextMatchStartAt: null,
    serverNow: new Date().toISOString(),
    completedSemifinalMatchId: 'sf1',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    siblingSemifinal: {} as any,
    finalMatchId: nextMatchId,
    finalRoomId: nextMatchId !== null ? 'final-room' : null,
    finalStartAt: null,
  }
}

console.log('\n═══ checkTournamentReturnDestinationResolver ═══\n')

// --- Part 1a: isTournamentForceReturnRequired — the CRITICAL gate ---

check('[1] Normal participant personally played, now in STATE A: viewerHasUnresolvedBotReplacement=false -> forceReturnRequired=false (NO blocking modal for a normal participant)', () => {
  const detail = baseDetail({ myInterRoundWaiting: interRoundWaiting(null), viewerHasUnresolvedBotReplacement: false })
  assert(!isTournamentForceReturnRequired(detail), 'a normal STATE A participant who was never bot-replaced must NOT be force-return-required')
})

check('[2] Normal participant in STATE B: viewerHasUnresolvedBotReplacement=false -> forceReturnRequired=false', () => {
  const detail = baseDetail({ myInterRoundWaiting: interRoundWaiting('next-match-1'), viewerHasUnresolvedBotReplacement: false })
  assert(!isTournamentForceReturnRequired(detail), 'a normal STATE B participant must NOT be force-return-required')
})

check('[3] Active match but no replacement yet (attendance before bot insertion): forceReturnRequired=false', () => {
  const assignment = baseAssignment({ matchStatus: 'awaiting_players' })
  const detail = baseDetail({ myActiveMatch: assignment, viewerHasUnresolvedBotReplacement: false })
  assert(!isTournamentForceReturnRequired(detail), 'attendance state alone (no replacement row yet) must NOT force a blocking modal')
})

check('[4] Active match, countdown, no replacement (all-present early transition or normal countdown): forceReturnRequired=false', () => {
  const assignment = baseAssignment({ matchStatus: 'countdown' })
  const detail = baseDetail({ myActiveMatch: assignment, viewerHasUnresolvedBotReplacement: false })
  assert(!isTournamentForceReturnRequired(detail), 'a normal countdown (no replacement row) must NOT force a blocking modal')
})

check('[5] Human missed attendance, replacement row exists, still gameplay: forceReturnRequired=true', () => {
  const assignment = baseAssignment({ matchStatus: 'in_progress' })
  const detail = baseDetail({ myActiveMatch: assignment, viewerHasUnresolvedBotReplacement: true })
  assert(isTournamentForceReturnRequired(detail), 'an unresolved replacement during live gameplay MUST force a blocking modal')
})

check('[6] ROOT CAUSE #2 regression: bot-controlled team WINS and moves to STATE A — forceReturnRequired REMAINS true (unresolved replacement persists across match boundary)', () => {
  const detail = baseDetail({ myInterRoundWaiting: interRoundWaiting(null), viewerHasUnresolvedBotReplacement: true })
  assert(isTournamentForceReturnRequired(detail), 'an unresolved replacement must persist through a bot-won match into STATE A — it is scoped to the whole tournament, not one match_id')
})

check('[7] STATE A -> STATE B while unresolved: forceReturnRequired remains true', () => {
  const detail = baseDetail({ myInterRoundWaiting: interRoundWaiting('next-match-1'), viewerHasUnresolvedBotReplacement: true })
  assert(isTournamentForceReturnRequired(detail), 'the requirement must remain true across the STATE A -> STATE B transition')
})

check('[8] Successful reclaim clears the requirement (viewerHasUnresolvedBotReplacement flips to false server-side) even while still in gameplay', () => {
  const assignment = baseAssignment({ matchStatus: 'in_progress' })
  const detail = baseDetail({ myActiveMatch: assignment, viewerHasUnresolvedBotReplacement: false })
  assert(!isTournamentForceReturnRequired(detail), 'after a successful reclaim (replacement row marked completed server-side) the requirement must be false')
})

check('[9] Team eliminated while a replacement was never reclaimed: no active destination left at all (both myActiveMatch/myInterRoundWaiting null) — the caller (resolveAndRouteTournamentReturn) must treat destination===null as an independent auto-close condition even if some stale replacement flag lingered', () => {
  const detail = baseDetail({ viewerHasUnresolvedBotReplacement: true })
  const destination = resolveTournamentReturnDestination(detail)
  assert(destination === null, 'an eliminated/finished participant must resolve to a null destination regardless of viewerHasUnresolvedBotReplacement, so resolveAndRouteTournamentReturn still closes the modal')
})

// --- Part 1b: resolveTournamentReturnDestination — pure destination mapping (unchanged contract, re-verified) ---

check('[10] myActiveMatch awaiting_players -> attendance destination', () => {
  const assignment = baseAssignment({ matchStatus: 'awaiting_players' })
  const destination = resolveTournamentReturnDestination(baseDetail({ myActiveMatch: assignment }))
  assert(destination?.kind === 'attendance', `expected attendance, got ${JSON.stringify(destination)}`)
})

check('[11] myActiveMatch countdown -> countdown destination', () => {
  const assignment = baseAssignment({ matchStatus: 'countdown' })
  const destination = resolveTournamentReturnDestination(baseDetail({ myActiveMatch: assignment }))
  assert(destination?.kind === 'countdown', `expected countdown, got ${JSON.stringify(destination)}`)
})

check('[12] myActiveMatch in_progress -> gameplay destination (reclaim-eligible)', () => {
  const assignment = baseAssignment({ matchStatus: 'in_progress' })
  const destination = resolveTournamentReturnDestination(baseDetail({ myActiveMatch: assignment }))
  assert(destination?.kind === 'gameplay', `expected gameplay, got ${JSON.stringify(destination)}`)
})

check('[13] myInterRoundWaiting with nextMatchId=null -> STATE A (sibling still playing)', () => {
  const destination = resolveTournamentReturnDestination(baseDetail({ myInterRoundWaiting: interRoundWaiting(null) }))
  assert(destination?.kind === 'state-a', `expected state-a, got ${JSON.stringify(destination)}`)
})

check('[14] myInterRoundWaiting with nextMatchId!=null -> STATE B (opponent known)', () => {
  const destination = resolveTournamentReturnDestination(baseDetail({ myInterRoundWaiting: interRoundWaiting('next-match-1') }))
  assert(destination?.kind === 'state-b', `expected state-b, got ${JSON.stringify(destination)}`)
})

check('[15] no active participation (both null) -> null destination', () => {
  const destination = resolveTournamentReturnDestination(baseDetail())
  assert(destination === null, `expected null, got ${JSON.stringify(destination)}`)
})

// --- Part 2: source-wiring checks on main.ts ---

const mainSrc = readFileSync(join(REPO_ROOT, 'src', 'main.ts'), 'utf8')

check('[16] resolveAndRouteTournamentReturn checks isTournamentForceReturnRequired FIRST, before computing/using any destination (§"КРИТИЧНО РАЗГРАНИЧЕНИЕ")', () => {
  const fnStart = mainSrc.indexOf('async function resolveAndRouteTournamentReturn(')
  assert(fnStart !== -1, 'resolveAndRouteTournamentReturn not found')
  const fnBody = mainSrc.slice(fnStart, fnStart + 3200)
  const forceCheckIdx = fnBody.indexOf('isTournamentForceReturnRequired(result.tournament)')
  const destinationIdx = fnBody.indexOf('resolveTournamentReturnDestination(result.tournament)')
  assert(forceCheckIdx !== -1, 'must call isTournamentForceReturnRequired')
  assert(destinationIdx !== -1, 'must call resolveTournamentReturnDestination')
  assert(forceCheckIdx < destinationIdx, 'isTournamentForceReturnRequired must be checked BEFORE resolveTournamentReturnDestination is used to show the modal')
})

check('[17] tournament_match_assigned handler no longer shows the blocking modal directly off raw "not attached" — it delegates to resolveAndRouteTournamentReturn (the old bug: activeRoom.getCurrentRoomId() mismatch alone used to trigger tournamentReclaimModal.show)', () => {
  const handlerStart = mainSrc.indexOf("message.type === 'tournament_match_assigned'")
  const handlerBody = mainSrc.slice(handlerStart, handlerStart + 6500)
  const notAttachedIdx = handlerBody.indexOf('activeRoom.getCurrentRoomId() !== message.assignment.roomId')
  assert(notAttachedIdx !== -1, 'not-attached branch not found')
  const branchBody = handlerBody.slice(notAttachedIdx, notAttachedIdx + 900)
  assert(
    !branchBody.includes('tournamentReclaimModal.show('),
    'the not-attached branch must NOT call tournamentReclaimModal.show() directly — it must delegate to resolveAndRouteTournamentReturn, which checks isTournamentForceReturnRequired first',
  )
  assert(
    branchBody.includes('resolveAndRouteTournamentReturn(message.assignment.tournamentId)'),
    'the not-attached branch must delegate to resolveAndRouteTournamentReturn',
  )
})

check('[18] attendance/countdown-before-replacement auto-routes via a normal (non-blocking) resumeRoom when the modal is not shown (§"ATTENDANCE LOGIN ПРЕДИ DEADLINE"/"COUNTDOWN LOGIN")', () => {
  const handlerStart = mainSrc.indexOf("message.type === 'tournament_match_assigned'")
  const handlerBody = mainSrc.slice(handlerStart, handlerStart + 6500)
  assert(
    handlerBody.includes('!tournamentReclaimModal.isVisible()') &&
      handlerBody.includes('client.resumeRoom(message.assignment.roomId, message.assignment.reconnectToken)'),
    'a normal (not force-return-required) not-attached assignment must auto-resume without the blocking modal',
  )
})

check('[19] tournament_feeder_match_completed handler does NOT call tournamentReclaimModal.hide() directly (still holds after this amendment)', () => {
  const handlerStart = mainSrc.indexOf("message.type === 'tournament_feeder_match_completed'")
  assert(handlerStart !== -1, 'tournament_feeder_match_completed handler not found')
  const handlerBody = mainSrc.slice(handlerStart, handlerStart + 1500)
  const closingBraceOfIf = handlerBody.indexOf("if (message.type === 'tournament_partner_invite_resolved'")
  const scopedBody = closingBraceOfIf !== -1 ? handlerBody.slice(0, closingBraceOfIf) : handlerBody
  assert(
    !scopedBody.includes('tournamentReclaimModal.hide()'),
    'tournament_feeder_match_completed must never call tournamentReclaimModal.hide() directly',
  )
  assert(
    handlerBody.includes('resolveAndRouteTournamentReturn(message.tournamentId)'),
    'tournament_feeder_match_completed must re-resolve via resolveAndRouteTournamentReturn',
  )
})

check('[20] tournament_active_participation message alone never directly shows the modal — it only triggers a fresh authoritative resolve (§"tournament_active_participation MESSAGE")', () => {
  const handlerStart = mainSrc.indexOf("message.type === 'tournament_active_participation'")
  assert(handlerStart !== -1, 'tournament_active_participation handler not found')
  const handlerBody = mainSrc.slice(handlerStart, handlerStart + 300)
  assert(
    !handlerBody.includes('tournamentReclaimModal.show('),
    'tournament_active_participation must not directly call tournamentReclaimModal.show() — only resolveAndRouteTournamentReturn (which checks force-return) may show it',
  )
  assert(handlerBody.includes('resolveAndRouteTournamentReturn(message.tournamentId)'), 'must delegate to resolveAndRouteTournamentReturn')
})

check('[21] the reclaim modal button handler (onReclaimClick) always re-resolves current state at click time (fresh fetch), never a cached destination', () => {
  assert(
    mainSrc.includes('onReclaimClick: () => {') &&
      mainSrc.includes('resolveAndRouteTournamentReturn(currentTournamentReclaimTournamentId, { fromButtonClick: true })'),
    'onReclaimClick must call resolveAndRouteTournamentReturn fresh',
  )
})

check('[22] STATE A/B route via lobby.navigateToTournamentDetail, not a room resume (no seat swap for a completed match)', () => {
  const fnStart = mainSrc.indexOf('async function resolveAndRouteTournamentReturn(')
  const fnBody = mainSrc.slice(fnStart, fnStart + 3200)
  assert(
    fnBody.includes("case 'state-a':") &&
      fnBody.includes("case 'state-b':") &&
      fnBody.includes('lobby.navigateToTournamentDetail(destination.tournamentId)'),
    'STATE A/B destinations must route via navigateToTournamentDetail, not resumeRoom',
  )
})

check('[23] ROOT CAUSE #3 regression (2nd amendment): STATE A/B click calls the authoritative acknowledgeTournamentBotReturn action BEFORE navigating — navigateToTournamentDetail alone (the OLD bug) never clears the persisted replacement', () => {
  const fnStart = mainSrc.indexOf('async function resolveAndRouteTournamentReturn(')
  const fnBody = mainSrc.slice(fnStart, fnStart + 3200)
  const stateCaseIdx = fnBody.indexOf("case 'state-a':")
  assert(stateCaseIdx !== -1, 'state-a/state-b case not found')
  const stateCaseBody = fnBody.slice(stateCaseIdx, stateCaseIdx + 1000)
  const ackIdx = stateCaseBody.indexOf('await acknowledgeTournamentBotReturn(tournamentId)')
  const navIdx = stateCaseBody.indexOf('lobby.navigateToTournamentDetail(destination.tournamentId)')
  assert(ackIdx !== -1, 'STATE A/B must call acknowledgeTournamentBotReturn')
  assert(navIdx !== -1, 'STATE A/B must still navigate after acknowledging')
  assert(ackIdx < navIdx, 'acknowledgeTournamentBotReturn must be called BEFORE navigateToTournamentDetail, not after')
})

check('[24] the acknowledge action does not navigate/hide the modal if the server call fails (requirement legitimately remains, no false-positive clear)', () => {
  const fnStart = mainSrc.indexOf('async function resolveAndRouteTournamentReturn(')
  const fnBody = mainSrc.slice(fnStart, fnStart + 3200)
  const stateCaseIdx = fnBody.indexOf("case 'state-a':")
  const stateCaseBody = fnBody.slice(stateCaseIdx, stateCaseIdx + 1000)
  assert(
    stateCaseBody.includes('if (!ack.ok) return'),
    'a failed acknowledge call must abort before hiding the modal or navigating',
  )
})

check('[25] acknowledgeTournamentBotReturn calls the dedicated server endpoint (POST .../acknowledge-bot-return), not a reused/unrelated endpoint', () => {
  const fnStart = mainSrc.indexOf('async function acknowledgeTournamentBotReturn(')
  assert(fnStart !== -1, 'acknowledgeTournamentBotReturn client function not found')
  const fnBody = mainSrc.slice(fnStart, fnStart + 600)
  assert(
    fnBody.includes('/acknowledge-bot-return') && fnBody.includes("method: 'POST'"),
    'must POST to the dedicated acknowledge-bot-return endpoint',
  )
})

// --- Part 3: server-side authoritative persistence wiring ---

const serverIndexSrc = readFileSync(join(REPO_ROOT, 'server', 'src', 'index.ts'), 'utf8')
const coordinatorSrc = readFileSync(join(REPO_ROOT, 'server', 'src', 'tournament', 'tournamentCoordinator.ts'), 'utf8')
const tournamentDtoSrc = readFileSync(join(REPO_ROOT, 'server', 'src', 'tournament', 'tournamentDto.ts'), 'utf8')

check('[26] hasUnresolvedBotReplacement queries tournament_match_no_show_replacements scoped to the WHOLE tournament (not one match_id) — the exact fix for surviving bot-win -> STATE A/B', () => {
  const stmtIdx = coordinatorSrc.indexOf('selectUnresolvedReplacementForProfileStatement = database.prepare(')
  assert(stmtIdx !== -1, 'selectUnresolvedReplacementForProfileStatement not found')
  const stmtBody = coordinatorSrc.slice(stmtIdx, stmtIdx + 400)
  assert(
    stmtBody.includes('FROM tournament_match_no_show_replacements') &&
      stmtBody.includes('WHERE tournament_id = ?') &&
      !stmtBody.includes('match_id = ?'),
    'the lookup must be scoped by tournament_id + profile_id, not match_id, so it survives across matches',
  )
  assert(
    stmtBody.includes("status IN ('active', 'takeover_pending')"),
    "the lookup must check for status IN ('active','takeover_pending') — completed rows (successful reclaim) must not match",
  )
})

check('[27] closeAllUnresolvedReplacementsForProfileStatement (the only status->completed transition) fires ONLY inside tryTakeoverNoShowBot and acknowledgeTournamentBotReplacementReturn, never automatically on match completion', () => {
  const onCompletedIdx = coordinatorSrc.indexOf('function onTournamentRoomCompleted(')
  assert(onCompletedIdx !== -1, 'onTournamentRoomCompleted not found')
  const onCompletedBody = coordinatorSrc.slice(onCompletedIdx, onCompletedIdx + 2500)
  assert(
    !onCompletedBody.includes('closeAllUnresolvedReplacementsForProfileStatement.run('),
    'match completion must NEVER auto-mark a replacement as completed — only a genuine human reclaim/acknowledge may do that, otherwise the requirement would wrongly clear on a bot win',
  )
})

check('[33] MODEL A regression: both tryTakeoverNoShowBot AND acknowledgeTournamentBotReplacementReturn close ALL unresolved rows for the profile in the tournament (not just the single row found by a match/room-scoped lookup) — the exact fix for a stale older-round row surviving a successful reclaim', () => {
  const stmtIdx = coordinatorSrc.indexOf('closeAllUnresolvedReplacementsForProfileStatement = database.prepare(')
  assert(stmtIdx !== -1, 'closeAllUnresolvedReplacementsForProfileStatement not found')
  const stmtBody = coordinatorSrc.slice(stmtIdx, stmtIdx + 400)
  assert(
    stmtBody.includes('WHERE tournament_id = ?') &&
      stmtBody.includes('AND assigned_profile_id = ?') &&
      !stmtBody.includes('match_id = ?') &&
      !stmtBody.includes('room_id = ?'),
    'the bulk-close statement must be scoped by tournament_id + assigned_profile_id only, not match_id/room_id, so it closes every unresolved row for the profile regardless of which match created it',
  )
  const takeoverIdx = coordinatorSrc.indexOf('function tryTakeoverNoShowBot(')
  const takeoverBody = coordinatorSrc.slice(takeoverIdx, takeoverIdx + 3600)
  assert(
    takeoverBody.includes('closeAllUnresolvedReplacementsForProfileStatement.run('),
    'tryTakeoverNoShowBot must call the bulk-close statement, not a single-row completion',
  )
  const ackIdx = coordinatorSrc.indexOf('function acknowledgeTournamentBotReplacementReturn(')
  const ackBody = coordinatorSrc.slice(ackIdx, ackIdx + 1500)
  assert(
    ackBody.includes('closeAllUnresolvedReplacementsForProfileStatement.run('),
    'acknowledgeTournamentBotReplacementReturn must also call the bulk-close statement',
  )
})

check('[34] the exact-seat reclaim lookup (selectReplacementForTakeoverStatement) stays strictly room-scoped — the tournament-wide bulk-close is a SEPARATE concern applied only after a successful match-specific reclaim, never conflated with "which seat do I reclaim now"', () => {
  const stmtIdx = coordinatorSrc.indexOf('selectReplacementForTakeoverStatement = database.prepare(')
  assert(stmtIdx !== -1, 'selectReplacementForTakeoverStatement not found')
  const stmtBody = coordinatorSrc.slice(stmtIdx, stmtIdx + 400)
  assert(
    stmtBody.includes('WHERE room_id = ?'),
    'the exact-seat takeover lookup must remain scoped by room_id — it answers "which seat do I reclaim right now", a different question from the tournament-level force-return check',
  )
})

check('[28] the tournament detail DTO exposes viewerHasUnresolvedBotReplacement computed from hasUnresolvedBotReplacement, not derived from myActiveMatch/myInterRoundWaiting', () => {
  assert(
    serverIndexSrc.includes('tournamentCoordinator?.hasUnresolvedBotReplacement(tournament.tournamentId, viewerProfileId)'),
    'the detail response must call hasUnresolvedBotReplacement separately from myActiveMatch/myInterRoundWaiting derivation',
  )
  assert(
    tournamentDtoSrc.includes('viewerHasUnresolvedBotReplacement: boolean'),
    'TournamentDetailDto must declare viewerHasUnresolvedBotReplacement as its own field',
  )
})

check('[29] getActiveTournamentIdForProfile (drives tournament_active_participation) only matches confirmed/finalist entries, never eliminated/champion', () => {
  const stmtIdx = coordinatorSrc.indexOf('selectActiveEntryTournamentIdStatement = database.prepare(')
  assert(stmtIdx !== -1, 'selectActiveEntryTournamentIdStatement not found')
  const stmtBody = coordinatorSrc.slice(stmtIdx, stmtIdx + 400)
  assert(
    stmtBody.includes("IN ('confirmed', 'finalist')") && !stmtBody.includes('eliminated'),
    'the active-entry lookup must exclude eliminated/champion statuses',
  )
})

check('[30] ROOT CAUSE #3 regression: getPresentSeats (attendance presence) excludes profiles with an unresolved bot replacement — online alone is NOT sufficient (§"ONLINE !== RECLAIMED")', () => {
  const fnIdx = coordinatorSrc.indexOf('function getPresentSeats(')
  assert(fnIdx !== -1, 'getPresentSeats not found')
  const fnBody = coordinatorSrc.slice(fnIdx, fnIdx + 700)
  assert(
    fnBody.includes('deps.isProfileOnline(assignment.profileId)') &&
      fnBody.includes('!hasUnresolvedBotReplacement('),
    'getPresentSeats must require BOTH isProfileOnline AND the absence of an unresolved replacement — online alone must not grant presence for a not-yet-reclaimed profile',
  )
})

check('[31] the acknowledge-bot-return HTTP endpoint is registered in the request dispatch chain', () => {
  assert(
    serverIndexSrc.includes('await handleTournamentAcknowledgeBotReturnRequest(req, res, requestUrl.pathname)'),
    'handleTournamentAcknowledgeBotReturnRequest must be wired into the main request dispatcher',
  )
  assert(
    serverIndexSrc.includes("/^\\/api\\/tournaments\\/([^/]+)\\/acknowledge-bot-return$/"),
    'the endpoint must match POST /api/tournaments/:id/acknowledge-bot-return',
  )
})

check('[32] acknowledgeTournamentBotReplacementReturn treats "no unresolved replacement found" as an idempotent success (alreadyResolved:true), not a hard failure — a double-click/repeat request must stay safe', () => {
  const fnIdx = coordinatorSrc.indexOf('function acknowledgeTournamentBotReplacementReturn(')
  assert(fnIdx !== -1, 'acknowledgeTournamentBotReplacementReturn not found')
  const fnBody = coordinatorSrc.slice(fnIdx, fnIdx + 1200)
  const rowUndefinedIdx = fnBody.indexOf('if (row === undefined) {')
  assert(rowUndefinedIdx !== -1, 'the no-row branch not found')
  const branchBody = fnBody.slice(rowUndefinedIdx, rowUndefinedIdx + 100)
  assert(
    branchBody.includes('{ ok: true, alreadyResolved: true }'),
    'a missing unresolved replacement row must be treated as an idempotent already-resolved success, not ok:false',
  )
})

console.log(`\nPassed: ${passed} Failed: ${failed}`)
if (failed > 0) process.exit(1)
