/**
 * checkTournamentStalePopupFix.ts
 *
 * Regression за клиентски бъг, открит при ръчно browser тестване на local
 * tournament test mode: след semifinal loss + "Към лобито" оставаше
 * tournamentMatchStartPopup със замръзнал 00:00 countdown, видим бутон
 * "Влез в турнира" (сочещ към вече force-затворена турнирна стая), и
 * toast "You are not attached to this room."
 *
 * Root cause (виж коментарите на съответните места в изходния код):
 *  - tournamentMatchStartPopup.setAssignment(null) съществуваше, но никой не
 *    го викаше — assignment-ът никога не се чистеше при leave/elimination.
 *  - "Към лобито" (returnToLobbyFromMatchEnded) оптимистично занулява
 *    activeRoomState и вика showLobby() ПРЕДИ сървърният отговор на
 *    leave_active_room, изпратен към ВЕЧЕ detach-ната от coordinator-а
 *    (closeCompletedTournamentRoom) стая — сървърът връщаше generic 'error'
 *    "You are not attached to this room.", а не идемпотентно потвърждение.
 *
 * Реалният server-side WS behavioral regression (leave_active_room е
 * идемпотентен за вече force-затворена турнирна стая) се проверява в
 * check:local-tournament-bot-flow ([17b]) — тук проверяваме source-fragment
 * wiring-а на browser-only клиентския код (не се изпълнява в Node/tsx
 * runtime, затова не може директно да се import-не/instantiate-не тук).
 */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok ${label}`)
    passed += 1
  } else {
    console.error(`  FAIL ${label}`)
    failed += 1
  }
}

const projectRootArg = process.argv.slice(2).find((a) => a.startsWith('--project-root='))?.slice('--project-root='.length) ?? '..'

async function readProjectFile(relativePath: string): Promise<string> {
  return readFile(resolve(join(process.cwd(), projectRootArg, relativePath)), 'utf8')
}

const popup = await readProjectFile('src/ui/notifications/tournamentMatchStartPopup.ts')
const activeRoomTypes = await readProjectFile('src/app/activeRoom/activeRoomTypes.ts')
const activeRoomController = await readProjectFile('src/app/activeRoom/createActiveRoomFlowController.ts')
const mainTs = await readProjectFile('src/main.ts')
const serverIndex = await readProjectFile('server/src/index.ts')

console.log('\n═══ checkTournamentStalePopupFix ═══')

check(
  'tournamentMatchStartPopup exposes clearAssignmentForRoom (roomId-scoped clear)',
  popup.includes('clearAssignmentForRoom: (roomId: string) => void')
    && popup.includes('clearAssignmentForRoom(roomId) {')
    && popup.includes('if (current === null || current.roomId !== roomId) return'),
)

check(
  'showLobby accepts an optional leftRoomId so callers can identify which room is being left',
  activeRoomTypes.includes('showLobby: (errorText?: string | null, leftRoomId?: string | null) => void'),
)

check(
  'returnToLobbyFromMatchEnded ("Към лобито" след match ended) passes the left roomId to showLobby',
  activeRoomController.includes('options.showLobby(null, roomId)'),
)

check(
  'left_active_room handler (penalty leave) also passes roomId to showLobby so stale state for that room is cleared',
  activeRoomController.includes('options.showLobby(') && activeRoomController.includes('message.roomId,')
    && (activeRoomController.match(/message\.roomId,/g)?.length ?? 0) >= 2,
)

check(
  'room_resume_failed handler passes roomId to showLobby (failed-resume path clears stale state too)',
  activeRoomController.includes('options.showLobby(message.message, message.roomId)'),
)

check(
  'main.ts wires showLobby(leftRoomId) to clear the tournament popup for that specific room',
  mainTs.includes('showLobby: (errorText = null, leftRoomId = null) => {')
    && mainTs.includes('tournamentMatchStartPopup.clearAssignmentForRoom(leftRoomId)'),
)

check(
  'main.ts also clears the popup on room_resume_failed as a global fallback (defense-in-depth за §3 в task spec-а)',
  mainTs.includes("if (message.type === 'room_resume_failed') {")
    && mainTs.includes('tournamentMatchStartPopup.clearAssignmentForRoom(message.roomId)'),
)

check(
  'non-final tournament round win has a dedicated 2500ms auto-transition timer owner',
  activeRoomController.includes('TOURNAMENT_ROUND_RESULT_AUTO_TRANSITION_MS = 2500')
    && activeRoomController.includes('tournamentRoundResultAutoTransitionTimerId')
    && activeRoomController.includes('ensureTournamentRoundResultAutoTransitionTimer()')
    && activeRoomController.includes('window.setTimeout(() =>')
    && activeRoomController.includes('TOURNAMENT_ROUND_RESULT_AUTO_TRANSITION_MS'),
)

check(
  'round-result click and timer share the same idempotent transition helper',
  activeRoomController.includes('function completeTournamentRoundResultTransition(expectedKey?: string): boolean')
    && activeRoomController.includes('tournamentRoundResultCompletedTransitionKey === context.key')
    && activeRoomController.includes('completeTournamentRoundResultTransition(context.key)')
    && activeRoomController.includes("querySelector('[data-tournament-round-result-lobby]')")
    && activeRoomController.includes('continueFromTournamentRoundResultButton()'),
)

check(
  'semifinal winner sees "Към турнира" manual fallback instead of "Към лобито"',
  activeRoomController.includes("${wonRound ? 'Към турнира' : 'Към лобито'}")
    && activeRoomController.includes('activeRoomState.tournamentRoundType !== \'final\'')
    && activeRoomController.includes('ensureTournamentRoundResultAutoTransitionTimer()'),
)

check(
  'semifinal loser still sees "Към лобито"',
  activeRoomController.includes("${wonRound ? 'Към турнира' : 'Към лобито'}")
    && activeRoomController.includes("${wonRound ? `")
    && activeRoomController.includes('Загубихте мача')
    && activeRoomController.includes('Отпадате от турнира.'),
)

check(
  'final result remains on the unchanged generic match-ended flow with lobby button',
  activeRoomController.includes('activeRoomState.tournamentRoundType !== \'final\'')
    && activeRoomController.includes('} else if (isShowingMatchEndedPhase && activeRoomState.game) {')
    && activeRoomController.includes('renderMatchEndedScreen(')
    && activeRoomController.includes('Към лобито'),
)

check(
  'auto-transition is scoped to non-final tournament match-ended wins only',
  activeRoomController.includes('!activeRoomState.isTournamentMatchOrigin')
    && activeRoomController.includes("activeRoomState.tournamentRoundType === 'final'")
    && activeRoomController.includes('activeRoomState.game?.matchEnded == null')
    && activeRoomController.includes('if (context === null || !context.wonRound)'),
)

check(
  'winning transition forwards feeder state before returning to lobby',
  activeRoomTypes.includes('result: { currentRoundType: TournamentRoundType; semifinalScoreA: number | null; semifinalScoreB: number | null }')
    && activeRoomController.includes('currentRoundType: context.currentRoundType')
    && activeRoomController.includes('semifinalScoreA: activeRoomState.game.matchEnded.finalScore.teamA')
    && activeRoomController.includes('semifinalScoreB: activeRoomState.game.matchEnded.finalScore.teamB')
    && activeRoomController.includes('options.onEnterWaitingForNextTournamentRound(context.feeder, context.tournamentId, {')
    && mainTs.includes('lobby?.showTournamentInterRoundPendingResult(tournamentId, result)'),
)

check(
  // Phase 2: generalized from the old final-only special case to every
  // round-transition assignment (R16->QF/QF->SF/SF->Final) — the unified
  // lobby STATE A/B overlay owns this UX for ANY round while the player is
  // looking at the tournament-detail screen, not just the final.
  'round-transition assignment on tournament detail is owned by inter-round STATE B, not popup/direct resume',
  mainTs.includes("if (message.assignment.deadlineKind === 'round_transition' && lobby?.getCurrentScreen() === 'tournament-detail') {")
    && mainTs.includes('tournamentMatchStartPopup.clearAssignmentForRoom(message.assignment.roomId)')
    && !mainTs.includes('client.resumeRoom(message.assignment.roomId, message.assignment.reconnectToken)'),
)

check(
  'semifinal loser is not auto-transitioned by a later tournament assignment push',
  activeRoomController.includes('if (!context.wonRound) return false')
    && activeRoomController.includes('function continueFromTournamentRoundResultButton(): boolean')
    && activeRoomController.includes('return completeTournamentRoundResultTransition(context.key)')
    && activeRoomController.includes('tournamentRoundResultCompletedTransitionKey = context.key')
    && activeRoomController.includes('returnToLobbyFromMatchEnded()'),
)

check(
  'main.ts completes any visible round-result transition before showing a new tournament assignment',
  activeRoomTypes.includes('completePendingTournamentRoundResultTransition: () => boolean')
    && activeRoomController.includes('completePendingTournamentRoundResultTransition: completeTournamentRoundResultTransition')
    && mainTs.includes("if (message.type === 'tournament_match_assigned') {")
    && mainTs.includes('activeRoom.completePendingTournamentRoundResultTransition()')
    && mainTs.indexOf('activeRoom.completePendingTournamentRoundResultTransition()') < mainTs.indexOf('tournamentMatchStartPopup.setAssignment(message.assignment)'),
)

check(
  'server leave_active_room handler is idempotent for an already-detached/closed room (no more scary generic error)',
  serverIndex.includes('if (latestConnection.currentRoomId === null || serverState.rooms[message.roomId] === undefined) {')
    && serverIndex.includes("type: 'left_active_room',")
    && serverIndex.includes('removed: false,'),
)

console.log('\n' + '═'.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
