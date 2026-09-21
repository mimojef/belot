// Focused проверка на новия dependency-aware inter-round waiting UX (виж
// task-а: "Подобри UX-а на inter-round waiting popup/state" след
// dependency-based tournament progression) — конкретно STATE C: играч, чийто
// ДИРЕКТЕН sibling слот все още не съществува като match row, защото самият
// той е blocked от по-ранен кръг (напр. SF1 winner чака SF2, докато SF2 не
// може да се създаде, защото QF4 все още не е завършил).
//
// Покрива:
//   [resolver] findBlockingMatchForBracketSlot (tournamentDto.ts) — чист,
//   unit-testable recursive resolver, директно извикан със синтетични
//   roundDtos fixtures (не изисква реален HTTP/coordinator/registration flow
//   — самата функция е pure, приема roundDtos explicit):
//     D) SF1 winner, QF3 completed, QF4 still in_progress -> blocking match
//        e ТОЧНО QF4 (не QF3, който вече е completed);
//     D-variant) нито QF3, нито QF4 съществуват (R16-7/8 все още не са
//        завършили) -> resolver-ът walk-ва РЕКУРСИВНО едно ниво по-надолу;
//     E) QF3+QF4 вече резолвнати (SF2 slot вече readyPairs-eligible, edge
//        case точно преди coordinator-ът да създаде реда) -> null (нищо
//        смислено за показване, target-ът предстои да се появи);
//     R16->QF: сблъсък на самата sibling логика НЕ се случва на ladder база
//        0 (round_of_16 винаги е seed-нат наведнъж — виж
//        createFirstRoundBracket в tournamentEconomyStore.ts), затова
//        resolver-ът никога не участва за R16 winner-и — потвърдено тук
//        индиректно чрез ladderIndex<0 guard.
//   [client] renderTournamentInterRoundBlockedScreen (renderTournamentsScreen.ts)
//   — markup/copy проверка със синтетичен fixture:
//     STATE C headline/copy/roster/score, mutual exclusivity с STATE A,
//     defensive fallback без blockingMatch.

import { findBlockingMatchForBracketSlot, type TournamentMatchDto, type TournamentRoundDto } from '../src/tournament/tournamentDto.js'
import { getTournamentRoundLadder } from '../src/tournament/tournamentTypes.js'
import { renderTournamentDetailScreen } from '../../src/app/lobby/renderTournamentsScreen.js'
import type { LobbyScreenState } from '../../src/app/lobby/renderLobbyScreen.js'
import type { TournamentDetailSnapshot } from '../../src/app/network/createGameServerClient.js'

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

console.log('\ncheckTournamentInterRoundBlockedState')

// ════════════════════════════════════════════════════════════════
// RESOLVER: findBlockingMatchForBracketSlot (pure, unit-tested directly)
// ════════════════════════════════════════════════════════════════

function match(overrides: Partial<TournamentMatchDto> & Pick<TournamentMatchDto, 'matchId' | 'teamAId' | 'teamBId' | 'status'>): TournamentMatchDto {
  return {
    roundId: `round-${overrides.matchId}`,
    roomId: null,
    winnerTeamId: null,
    resultKind: null,
    roomReady: false,
    attendance: { state: 'waiting', deadlineAt: null, secondsRemaining: 0, resolutionKind: null, gameStartAt: null, startSecondsRemaining: 0 },
    finalScoreTeamA: null,
    finalScoreTeamB: null,
    liveScoreTeamA: null,
    liveScoreTeamB: null,
    progressLabel: '',
    finalStartAt: null,
    nextMatchStartAt: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  }
}

function round(roundType: TournamentRoundDto['roundType'], roundIndex: number, m: TournamentMatchDto): TournamentRoundDto {
  return { roundId: `round-${roundType}-${roundIndex}`, roundType, roundIndex, matches: [m] }
}

const ladder8 = getTournamentRoundLadder(8) // ['quarterfinal', 'semifinal', 'final']
const ladder16 = getTournamentRoundLadder(16) // ['round_of_16', 'quarterfinal', 'semifinal', 'final']

await check('[resolver D] SF1 winner: QF3 completed, QF4 in_progress -> blocking match is QF4 (not QF3, which is already done)', () => {
  const roundDtos: TournamentRoundDto[] = [
    round('quarterfinal', 3, match({ matchId: 'qf3', teamAId: 'team-b', teamBId: 'team-c', status: 'completed', winnerTeamId: 'team-b', finalScoreTeamA: 151, finalScoreTeamB: 100 })),
    round('quarterfinal', 4, match({ matchId: 'qf4', teamAId: 'team-d', teamBId: 'team-y', status: 'in_progress', liveScoreTeamA: 62, liveScoreTeamB: 48, progressLabel: 'Играе се' })),
  ]
  // semifinal is ladder index 1; its feeders (quarterfinal) are ladder index 0.
  const blocking = findBlockingMatchForBracketSlot(roundDtos, ladder8, 0, 2)
  assert(blocking !== null, 'expected a blocking match, got null')
  assert(blocking!.roundType === 'quarterfinal' && blocking!.roundIndex === 4, `expected quarterfinal #4, got ${blocking!.roundType} #${blocking!.roundIndex}`)
  assert(blocking!.match.matchId === 'qf4', 'expected qf4 as the blocking match')
  assert(blocking!.match.status === 'in_progress', 'blocking match status mismatch')
})

await check('[resolver D-symmetric] SF1 winner: QF4 completed, QF3 in_progress -> blocking match is QF3 (deterministic, not the completed one)', () => {
  const roundDtos: TournamentRoundDto[] = [
    round('quarterfinal', 3, match({ matchId: 'qf3', teamAId: 'team-b', teamBId: 'team-c', status: 'in_progress', liveScoreTeamA: 30, liveScoreTeamB: 20 })),
    round('quarterfinal', 4, match({ matchId: 'qf4', teamAId: 'team-d', teamBId: 'team-y', status: 'completed', winnerTeamId: 'team-d', finalScoreTeamA: 151, finalScoreTeamB: 80 })),
  ]
  const blocking = findBlockingMatchForBracketSlot(roundDtos, ladder8, 0, 2)
  assert(blocking !== null, 'expected a blocking match, got null')
  assert(blocking!.roundIndex === 3, `expected quarterfinal #3 (the still-playing one), got #${blocking!.roundIndex}`)
  assert(blocking!.match.matchId === 'qf3', 'expected qf3 as the blocking match')
})

await check('[resolver D-recursive] neither QF3 nor QF4 exists yet (their own R16 feeders unresolved) -> resolver recurses one level down to R16', () => {
  const roundDtos: TournamentRoundDto[] = [
    round('round_of_16', 5, match({ matchId: 'r16-5', teamAId: 'team-b', teamBId: 'team-e', status: 'completed', winnerTeamId: 'team-b', finalScoreTeamA: 151, finalScoreTeamB: 70 })),
    round('round_of_16', 6, match({ matchId: 'r16-6', teamAId: 'team-c', teamBId: 'team-f', status: 'in_progress', liveScoreTeamA: 40, liveScoreTeamB: 35 })),
    // r16-7/r16-8 (QF4's own feeders) intentionally absent too — but QF4's
    // immediate feeders are r16-7/r16-8, not r16-5/r16-6 (those feed QF3).
    // Since QF3 (round_index 3) is missing, the resolver should recurse into
    // round_of_16 slots 5/6 (2*3-1, 2*3) looking for QF3's blocker.
  ]
  const blocking = findBlockingMatchForBracketSlot(roundDtos, ladder16, 1, 2)
  // ladder16 = [round_of_16, quarterfinal, semifinal, final]; semifinal is
  // ladder index 2, its feeders (quarterfinal) are ladder index 1. Neither
  // QF3 nor QF4 exist -> recurse into ladder index 0 (round_of_16) for QF3's
  // feeders (round_index 5, 6).
  assert(blocking !== null, 'expected a blocking match after recursing into round_of_16, got null')
  assert(blocking!.roundType === 'round_of_16', `expected recursion into round_of_16, got ${blocking!.roundType}`)
  assert(blocking!.roundIndex === 6, `expected round_of_16 #6 (still in_progress), got #${blocking!.roundIndex}`)
  assert(blocking!.match.matchId === 'r16-6', 'expected r16-6 as the blocking match')
})

await check('[resolver E-edge] both feeders already completed (one-tick race right before target row is created) -> null, nothing misleading to show', () => {
  const roundDtos: TournamentRoundDto[] = [
    round('quarterfinal', 3, match({ matchId: 'qf3', teamAId: 'team-b', teamBId: 'team-c', status: 'completed', winnerTeamId: 'team-b', finalScoreTeamA: 151, finalScoreTeamB: 100 })),
    round('quarterfinal', 4, match({ matchId: 'qf4', teamAId: 'team-d', teamBId: 'team-y', status: 'completed', winnerTeamId: 'team-d', finalScoreTeamA: 151, finalScoreTeamB: 90 })),
  ]
  const blocking = findBlockingMatchForBracketSlot(roundDtos, ladder8, 0, 2)
  assert(blocking === null, `expected null (transient race, target about to be created), got ${JSON.stringify(blocking)}`)
})

await check('[resolver] recursion terminates cleanly at ladder base (defensive, should not normally be reachable)', () => {
  const blocking = findBlockingMatchForBracketSlot([], ladder8, -1, 1)
  assert(blocking === null, 'expected null when ladderIndex < 0')
})

// ════════════════════════════════════════════════════════════════
// CLIENT RENDER: STATE C markup/copy (synthetic fixture)
// ════════════════════════════════════════════════════════════════

function matchFixture(input: {
  matchId: string
  roundId: string
  teamAId: string
  teamBId: string
  status: 'awaiting_players' | 'countdown' | 'in_progress' | 'completed' | 'walkover' | 'cancelled'
  winnerTeamId?: string | null
  finalScoreTeamA?: number | null
  finalScoreTeamB?: number | null
  liveScoreTeamA?: number | null
  liveScoreTeamB?: number | null
  progressLabel?: string
}): TournamentDetailSnapshot['rounds'][number]['matches'][number] {
  return {
    matchId: input.matchId,
    roundId: input.roundId,
    roomId: null,
    teamAId: input.teamAId,
    teamBId: input.teamBId,
    status: input.status,
    winnerTeamId: input.winnerTeamId ?? null,
    resultKind: null,
    roomReady: false,
    finalScoreTeamA: input.finalScoreTeamA ?? null,
    finalScoreTeamB: input.finalScoreTeamB ?? null,
    liveScoreTeamA: input.liveScoreTeamA ?? null,
    liveScoreTeamB: input.liveScoreTeamB ?? null,
    progressLabel: input.progressLabel ?? '',
    startedAt: null,
    completedAt: null,
  }
}

function detailFixture(overrides: Partial<TournamentDetailSnapshot> = {}): TournamentDetailSnapshot {
  const baseTeam = (teamId: string, a: string, b: string) => ({
    teamId,
    status: 'locked' as const,
    members: [
      { profileId: `${teamId}-1`, displayName: a, avatarUrl: null, joinedAt: '2026-08-01T10:00:00.000Z', joinedAs: 'solo' as const },
      { profileId: `${teamId}-2`, displayName: b, avatarUrl: null, joinedAt: '2026-08-01T10:00:00.000Z', joinedAs: 'solo' as const },
    ],
  })
  const teamA = baseTeam('team-a', 'A1', 'A2')
  const teamB = baseTeam('team-b', 'B1', 'B2')
  const teamC = baseTeam('team-c', 'C1', 'C2')
  const teamD = baseTeam('team-d', 'D1', 'D2')
  return {
    tournamentId: 'tournament-blocked',
    name: 'Blocked State Test',
    creator: { profileId: 'creator', displayName: 'Creator', avatarUrl: null },
    visibility: 'public',
    requiresPassword: false,
    status: 'semifinal_in_progress',
    statusLabel: 'Полуфинали',
    championTeamId: null,
    runnerUpTeamId: null,
    settlementState: 'pending',
    settledAt: null,
    entryFee: 5000,
    playerCapacity: 16,
    confirmedEntriesCount: 16,
    reservedPlacesCount: 0,
    occupiedPlacesCount: 16,
    completedTeamsCount: 8,
    formingTeamsCount: 0,
    availablePlaces: 0,
    isFull: true,
    startMode: 'fill',
    scheduledStartAt: null,
    fillExpiresAt: null,
    createdAt: '2026-08-01T10:00:00.000Z',
    prizePreview: { totalEntryFees: 80000, systemFee: 16000, prizePool: 64000, firstTeamPrize: 41600, secondTeamPrize: 22400, firstPlayerPrize: 20800, secondPlayerPrize: 11200 },
    isMine: false,
    viewer: { isParticipant: true, entryStatus: 'confirmed', joinedAs: 'solo', canJoinSolo: false, canInvitePartner: false, canLeave: false, canCancel: false, myPlacement: null, myPrizeAmount: null },
    cancelReason: null,
    startedAt: '2026-08-01T10:00:00.000Z',
    finishedAt: null,
    myTeam: teamA,
    teams: [teamA, teamB, teamC, teamD],
    rounds: [
      {
        roundId: 'sf1-round',
        roundType: 'semifinal',
        roundIndex: 1,
        matches: [matchFixture({ matchId: 'sf1', roundId: 'sf1-round', teamAId: 'team-a', teamBId: 'team-x', status: 'completed', winnerTeamId: 'team-a', finalScoreTeamA: 151, finalScoreTeamB: 90, progressLabel: 'Завършен' })],
      },
      {
        roundId: 'qf3-round',
        roundType: 'quarterfinal',
        roundIndex: 3,
        matches: [matchFixture({ matchId: 'qf3', roundId: 'qf3-round', teamAId: 'team-b', teamBId: 'team-c', status: 'completed', winnerTeamId: 'team-b', finalScoreTeamA: 151, finalScoreTeamB: 100, progressLabel: 'Завършен' })],
      },
      {
        roundId: 'qf4-round',
        roundType: 'quarterfinal',
        roundIndex: 4,
        matches: [matchFixture({ matchId: 'qf4', roundId: 'qf4-round', teamAId: 'team-d', teamBId: 'team-y', status: 'in_progress', liveScoreTeamA: 62, liveScoreTeamB: 48, progressLabel: 'Играе се' })],
      },
    ],
    myActiveMatch: null,
    myInterRoundWaiting: {
      tournamentId: 'tournament-blocked',
      currentRoundType: 'semifinal',
      nextRoundType: 'final',
      completedMatchId: 'sf1',
      sibling: null,
      blockingMatch: {
        roundType: 'quarterfinal',
        roundIndex: 4,
        matchId: 'qf4',
        teamA: teamD,
        teamB: baseTeam('team-y', 'Y1', 'Y2'),
        scoreA: 62,
        scoreB: 48,
        status: 'in_progress',
        progressLabel: 'Играе се',
      },
      ownResultAcknowledged: true,
      otherFinalistReady: false,
      nextMatchId: null,
      nextRoomId: null,
      nextMatchStartAt: null,
      serverNow: '2026-08-01T10:05:00.000Z',
      completedSemifinalMatchId: 'sf1',
      siblingSemifinal: null,
      finalMatchId: null,
      finalRoomId: null,
      finalStartAt: null,
    },
    incomingPartnerInvite: null,
    outgoingPartnerInvite: null,
    ...overrides,
  }
}

function renderDetail(tournament: TournamentDetailSnapshot): string {
  return renderTournamentDetailScreen({
    currentScreen: 'tournament-detail',
    tournamentDetail: tournament,
    tournamentDetailId: tournament.tournamentId,
    tournamentDetailLoading: false,
    tournamentDetailErrorText: null,
    tournamentDetailUnlockBusy: false,
  } as Partial<LobbyScreenState> as LobbyScreenState)
}

await check('[client] STATE C: SF1 winner with SF2 not-yet-created shows the specific blocking QF4, not generic round-wide text', () => {
  const html = renderDetail(detailFixture())
  assert(html.includes('data-tournament-inter-round-blocked="1"'), 'STATE C marker missing')
  assert(html.includes('Класирахте се за финала!'), 'headline missing')
  assert(html.includes('Другият полуфинал още не е започнал'), 'sibling-round copy missing (should name the round the direct sibling belongs to)')
  assert(html.includes('четвъртфинал 4'), 'specific blocking match reference (четвъртфинал 4) missing')
  assert(html.includes('Четвъртфинал 4'), 'blocking match status-card title missing')
  assert(html.includes('D1') && html.includes('D2'), 'blocking match team roster missing')
  assert(html.includes('62 : 48'), 'blocking match live score missing')
  assert(html.includes('няколко минути'), 'reassuring "may take a few minutes" copy missing')
  assert(html.includes('автоматично'), 'reassuring "starts automatically" copy missing')
  assert(!html.includes('Другият финалист още разглежда резултата'), 'old misleading generic text leaked in')
  assert(!html.includes('Изчаква се другият финалист'), 'old misleading generic headline leaked in')
})

await check('[client] STATE C is mutually exclusive with STATE A: sibling !== null renders the direct-sibling screen, not the blocked one', () => {
  const withDirectSibling = detailFixture({
    myInterRoundWaiting: {
      ...detailFixture().myInterRoundWaiting!,
      sibling: { matchId: 'sf2', roundIndex: 2, teamA: { teamId: 'team-b', status: 'locked', members: [] }, teamB: { teamId: 'team-c', status: 'locked', members: [] }, scoreA: null, scoreB: null, status: 'in_progress', winnerTeamId: null, progressLabel: 'Играе се' },
      blockingMatch: null,
    },
  })
  const html = renderDetail(withDirectSibling)
  assert(html.includes('data-tournament-inter-round-waiting="1"'), 'STATE A marker missing')
  assert(!html.includes('data-tournament-inter-round-blocked="1"'), 'STATE C marker leaked into STATE A render')
})

await check('[client] STATE C without a resolvable blockingMatch (defensive one-tick race) shows reassuring text, not a crash or old misleading copy', () => {
  const noBlockerYet = detailFixture({
    myInterRoundWaiting: { ...detailFixture().myInterRoundWaiting!, blockingMatch: null },
  })
  const html = renderDetail(noBlockerYet)
  assert(html.includes('Класирахте се за финала!'), 'headline missing')
  assert(html.includes('скоро'), 'reassuring defensive copy missing')
  assert(!html.includes('Другият финалист още разглежда резултата'), 'old misleading generic text leaked in')
})

if (failed > 0) {
  console.error(`checkTournamentInterRoundBlockedState failed: ${failed} failed, ${passed} passed.`)
  process.exit(1)
}

console.log(`checkTournamentInterRoundBlockedState passed: ${passed} checks.`)
