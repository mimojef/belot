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

async function readProjectFile(relativePath: string): Promise<string> {
  return readFile(resolve(join(process.cwd(), '..', relativePath)), 'utf8')
}

const coordinator = await readProjectFile('server/src/tournament/tournamentCoordinator.ts')
const serverIndex = await readProjectFile('server/src/index.ts')
const serverTypes = await readProjectFile('server/src/core/serverTypes.ts')
const serverMessages = await readProjectFile('server/src/protocol/messageTypes.ts')
const roomSnapshot = await readProjectFile('server/src/protocol/createRoomSnapshotMessage.ts')
const tournamentDto = await readProjectFile('server/src/tournament/tournamentDto.ts')
const clientNetwork = await readProjectFile('src/app/network/createGameServerClient.ts')
const tournamentsScreen = await readProjectFile('src/app/lobby/renderTournamentsScreen.ts')
const activeRoomController = await readProjectFile('src/app/activeRoom/createActiveRoomFlowController.ts')

check('ServerRoomConfig has tournament room markers', [
  'isTournamentMatchOrigin?: boolean',
  'tournamentId?: TournamentId',
  'tournamentMatchId?: TournamentMatchId',
  'tournamentRoundType?: TournamentRoundType',
].every((needle) => serverTypes.includes(needle)))

check('coordinator claims room_id before room creation', coordinator.includes('claimRoomIdStatement.run(candidateRoomId, match.match_id)'))
check('coordinator creates rooms with fixed tournament config', [
  'allowBots: false',
  'isPrivate: true',
  'stakeAmount: 0',
  'targetScore: 151',
  'isTournamentMatchOrigin: true',
].every((needle) => coordinator.includes(needle)))
check('coordinator uses fixed team seats', [
  'SERVER_TEAM_A_SEATS[0]',
  'SERVER_TEAM_A_SEATS[1]',
  'SERVER_TEAM_B_SEATS[0]',
  'SERVER_TEAM_B_SEATS[1]',
].every((needle) => coordinator.includes(needle)))
check('coordinator persists terminal winners and final skeleton', [
  'played_with_bots',
  "'walkover'",
  "INSERT INTO tournament_rounds (round_id, tournament_id, round_type, round_index)",
  "VALUES (?, ?, 'final', 1)",
  'tournament_final_completed',
].every((needle) => coordinator.includes(needle)))
check('coordinator has Stage 8 attendance resolution flow', [
  'ATTENDANCE_WAIT_MS = 180_000',
  'START_COUNTDOWN_MS = 5_000',
  'ensureAttendanceStartedStatement',
  'resolveWalkoverStatement',
  'resolveBotsStatement',
  'tryTakeoverNoShowBot',
].every((needle) => coordinator.includes(needle)))

check('server starts and exposes coordinator health', [
  'createTournamentCoordinator',
  'tournamentCoordinator.start()',
  'tournamentCoordinator?.getHealth()',
  'tournamentCoordinator?.close()',
].every((needle) => serverIndex.includes(needle)))
check('server skips normal tournament room economy and replay', [
  '!isTournamentMatchRoom(room)',
  'Турнирните мачове не поддържат преиграване.',
  'record-tournament-match-completion',
  'abandonResult = isTournamentMatchRoom(room)',
].every((needle) => serverIndex.includes(needle)))

check('protocol and snapshots expose assignment and tournament room flags', [
  'TournamentMatchAssignedMessage',
  "type: 'tournament_match_assigned'",
  'isTournamentMatchOrigin: boolean',
].every((needle) => serverMessages.includes(needle) || clientNetwork.includes(needle)))
check('room snapshots include tournament origin flag', roomSnapshot.includes('isTournamentMatchOrigin: room.config.isTournamentMatchOrigin === true'))
check('room snapshots include safe tournament attendance state', [
  'tournamentAttendance',
  'tournamentBotReplacements',
  'tournamentBanners',
].every((needle) => roomSnapshot.includes(needle) && serverMessages.includes(needle) && clientNetwork.includes(needle)))
check('detail DTO includes rounds and myActiveMatch', [
  'TournamentRoundDto',
  'rounds: TournamentRoundDto[]',
  'myActiveMatch: TournamentMatchAssignment | null',
  'buildTournamentRoundDtos',
].every((needle) => tournamentDto.includes(needle)))
check('tournament detail UI has ready callout and enter button', [
  'Полуфиналната ти маса е готова.',
  'Влез в масата',
  'data-tournament-enter-active-match',
  'renderTournamentRounds',
].every((needle) => tournamentsScreen.includes(needle)))
check('active room UI hides replay/new game for tournament rooms', [
  'activeRoomState.isPrivateTableOrigin || activeRoomState.isTournamentMatchOrigin',
  'activeRoomState.isTournamentMatchOrigin = message.isTournamentMatchOrigin',
].every((needle) => activeRoomController.includes(needle)))
check('active room UI renders attendance overlay and tournament banners', [
  'tournamentAttendance',
  'appendTournamentBanners',
  'data-tournament-banner-dismiss',
].every((needle) => activeRoomController.includes(needle)))

if (failed > 0) {
  console.error(`Tournament coordinator source check failed: ${failed} failed, ${passed} passed.`)
  process.exit(1)
}

console.log(`Tournament coordinator source check passed: ${passed} checks.`)
