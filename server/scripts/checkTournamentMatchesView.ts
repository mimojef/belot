// "Турнирни срещи" (Виж игрите) — регресионен тест.
//
// Покрива:
//   [B]  видимост на "Виж игрите" по реалния статус на турнира
//   [R]  live viewer registry + токен за subscribe_tournament_matches
//   [E]  spectator eligibility за турнирни маси (точна маса, участници,
//        активни участници, неактивни/приключили маси, регресия за частни/
//        matchmaking/guest маси)
//   [F]  resolveTournamentMatchSpectatorFacts — асоциация среща <-> маса
//   [V]  view model: активни срещи, история, победител, липсващи данни,
//        live score patch, преминаване от активна към приключила среща
//   [L]  HTML: адаптивна подредба (без хоризонтален overflow), "Гледай" само
//        за активна среща, бутонът е зелен
//   [I]  интеграция с реален coordinator + SQLite: lifecycle сигнали (старт,
//        край, нов кръг), live резултат от authoritative room state,
//        история след restart (нов store/coordinator върху същата база)

import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import type { PlayerPublicProfileSnapshot, Seat, ServerRoom, Team } from '../src/core/serverTypes.js'
import { evaluateBelotSpectatorWatchEligibility } from '../src/core/evaluateBelotSpectatorWatchEligibility.js'
import { createTournamentEconomyStore } from '../src/db/tournamentEconomyStore.js'
import { createTournamentStore } from '../src/db/tournamentStore.js'
import { initializeRoomAuthoritativeGameState } from '../src/game/initializeRoomAuthoritativeGameState.js'
import type { ServerAuthoritativeGameState } from '../src/game/serverGameTypes.js'
import { createTournamentCoordinator } from '../src/tournament/tournamentCoordinator.js'
import { createTournamentScheduler } from '../src/tournament/tournamentScheduler.js'
import {
  buildTeamDtos,
  buildTournamentRoundDtos,
  getTournamentStatusLabel,
  resolveActiveTournamentRoundType,
  toTournamentDetailDto,
} from '../src/tournament/tournamentDto.js'
import {
  DEFAULT_SPECTATOR_TEAM_LABELS,
  forgetTournamentSpectatorTeamLabels,
  getActiveSpectatorTeamLabels,
  rememberTournamentSpectatorTeamLabels,
  syncActiveSpectatorTeamLabels,
} from '../../src/app/activeRoom/spectatorTeamLabels.js'
import {
  createTournamentMatchesLiveTokenSigner,
  createTournamentMatchesViewerRegistry,
} from '../src/tournament/tournamentMatchesViewerRegistry.js'
import { resolveTournamentMatchSpectatorFacts } from '../src/tournament/tournamentMatchSpectatorFacts.js'
import type { TournamentEntryRecord, TournamentMatchRecord, TournamentRecord } from '../src/tournament/tournamentTypes.js'
import {
  applyTournamentMatchLiveScore,
  buildTournamentMatchesViewModel,
  renderTournamentGamesButton,
  renderTournamentMatchesView,
  resolveTournamentMatchTeamLetters,
  shouldShowTournamentGamesButton,
} from '../../src/app/tournaments/renderTournamentMatchesView.js'

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

console.log('\ncheckTournamentMatchesView')

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SEATS: Seat[] = ['bottom', 'right', 'top', 'left']

function connectionFixture(id: string, profileId: string | null): any {
  return {
    id, status: 'connected', connectedAt: 1, lastSeenAt: 1, remoteAddress: null, userAgent: null,
    currentRoomId: null, currentSeat: null, playerId: null, profileId, sessionId: null,
  }
}

function humanFixture(seat: Seat, profileId: string): any {
  return {
    kind: 'human', playerId: `player-${seat}`, connectionId: `conn-${seat}`, isConnected: true, joinedAt: 1,
    lastSeenAt: 1, reconnectToken: `token-${seat}`, permanentlyLeftAt: null,
    identity: { accountId: null, profileId, username: null, displayName: `P ${seat}`, avatarUrl: null, level: 1, rankTitle: null, skillRating: null, gender: null },
  }
}

function playingRoomFixture(id: string, configOverrides: Record<string, unknown> = {}): any {
  return {
    id, status: 'playing', createdAt: 1, updatedAt: 1, hostPlayerId: null,
    config: {
      maxPlayers: 4, allowBots: true, isPrivate: true, joinCode: null, stakeAmount: 0, targetScore: 151,
      turnTimeMs: 15000, reconnectGraceMs: 60000, ...configOverrides,
    },
    seats: Object.fromEntries(SEATS.map((seat) => [seat, {
      seat, team: seat === 'bottom' || seat === 'top' ? 'A' : 'B', participant: humanFixture(seat, `profile-${seat}`),
    }])),
    game: {
      phase: 'bidding', stateVersion: 1, startedAt: 1, updatedAt: 1, activeTimerId: null, timerDeadlineAt: null,
      authoritativeState: { phase: 'bidding', matchEnded: null, score: { round: {}, match: { teamA: 10, teamB: 4 }, carryOver: { teamA: 0, teamB: 0 } } },
    },
    replayVotes: [], leaveVotes: [],
  }
}

function tournamentRoomFixture(id: string): any {
  return playingRoomFixture(id, {
    isPrivate: false, isPrivateTableOrigin: false, isTournamentMatchOrigin: true,
    tournamentId: 'tournament-1', tournamentMatchId: 'match-1', tournamentRoundType: 'semifinal',
  })
}

function eligibilityInput(overrides: Record<string, unknown> = {}): any {
  return {
    featureEnabled: true,
    connection: connectionFixture('conn-viewer', 'profile-viewer'),
    room: tournamentRoomFixture('room-t1'),
    vipStatus: { isActive: true },
    profileHasActiveGameCommitment: false,
    profileIsLudoSpectating: false,
    profileWatchedRoomIds: [],
    tournamentMatch: { matchInProgress: true, profileAssignedToMatch: false, profileHasActiveTournamentParticipation: false },
    ...overrides,
  }
}

function tournamentRecordFixture(status: TournamentRecord['status']): TournamentRecord {
  return {
    tournamentId: 'tournament-1', kind: 'community', name: 'Турнирът на Мишони', creatorProfileId: 'creator',
    visibility: 'public', passwordHash: null, entryFee: 1000, playerCapacity: 8, startMode: 'fill',
    scheduledStartAt: null, fillExpiresAt: null, shuffleEnabled: false, teamsShuffledAt: null, status,
    cancelReason: null, createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z',
    startedAt: null, finishedAt: null, championTeamId: null, runnerUpTeamId: null, settlementState: 'pending',
    settledAt: null, totalEntryAmount: null, systemFeePercent: null, systemFeeAmount: null, prizePoolAmount: null,
    winnerSharePercent: null, runnerUpSharePercent: null, winnerTeamPrizeAmount: null, runnerUpTeamPrizeAmount: null,
    winnerPlayerPrizeAmount: null, runnerUpPlayerPrizeAmount: null, financialRulesVersion: null,
  }
}

function matchRecordFixture(overrides: Partial<TournamentMatchRecord>): TournamentMatchRecord {
  return {
    matchId: 'match-1', tournamentId: 'tournament-1', roundId: 'round-1', roomId: 'room-t1', teamAId: 'team-a',
    teamBId: 'team-b', status: 'in_progress', noShowDeadlineAt: null, attendanceStartedAt: null,
    attendanceDeadlineAt: null, attendanceResolvedAt: null, attendanceResolutionKind: 'all_present',
    deadlineKind: 'first_match', gameStartAt: null, attendanceRevision: 0, winnerTeamId: null, resultKind: null,
    walkoverReason: null, missingProfileIds: null, finalScoreTeamA: null, finalScoreTeamB: null, finalStartAt: null,
    nextMatchStartAt: null, createdAt: '2026-10-01T10:00:00.000Z', startedAt: '2026-10-01T10:05:00.000Z', completedAt: null,
    ...overrides,
  }
}

function entryFixture(profileId: string, teamId: string | null, status: TournamentEntryRecord['status']): TournamentEntryRecord {
  return {
    entryId: `entry-${profileId}`, tournamentId: 'tournament-1', profileId, teamId, joinedAs: 'solo', status,
    createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z', withdrawnAt: null, refundedAt: null,
  }
}

// Минимален client-shaped detail snapshot за view model тестовете.
function detailFixture(overrides: Record<string, unknown> = {}): any {
  const team = (teamId: string, names: string[]) => ({
    teamId, status: 'locked',
    members: names.map((displayName, index) => ({
      entryId: `${teamId}-${index}`, profileId: `${teamId}-p${index}`, displayName, avatarUrl: null,
      joinedAt: '2026-10-01T10:00:00.000Z', joinedAs: 'solo',
    })),
  })
  const match = (matchId: string, teamAId: string, teamBId: string, extra: Record<string, unknown>) => ({
    matchId, roundId: `round-${matchId}`, roomId: `room-${matchId}`, teamAId, teamBId, status: 'in_progress',
    winnerTeamId: null, resultKind: 'played', roomReady: true, finalScoreTeamA: null, finalScoreTeamB: null,
    liveScoreTeamA: null, liveScoreTeamB: null, startedAt: null, completedAt: null, ...extra,
  })
  return {
    tournamentId: 'tournament-1', name: 'Турнирът на Мишони', status: 'final_in_progress',
    viewer: { isParticipant: false },
    belotSpectatingEnabled: true,
    matchesLiveToken: 'token',
    teams: [
      team('team-a', ['Мимо', 'Надя']), team('team-b', ['Иван', 'Тодор']),
      team('team-c', ['Гошо', 'Пешо']), team('team-d', ['Мария', 'Елена']),
      team('team-e', ['Алекс', 'Боби']), team('team-f', ['Ники', 'Стефи']),
      team('team-g', ['Влади', 'Дани']), team('team-h', ['Краси', 'Митко']),
    ],
    rounds: [
      { roundId: 'r-qf1', roundType: 'quarterfinal', roundIndex: 1, matches: [match('qf1', 'team-a', 'team-b', { status: 'completed', winnerTeamId: 'team-a', finalScoreTeamA: 152, finalScoreTeamB: 98, completedAt: '2026-10-01T11:00:00.000Z' })] },
      { roundId: 'r-qf2', roundType: 'quarterfinal', roundIndex: 2, matches: [match('qf2', 'team-c', 'team-d', { status: 'completed', winnerTeamId: 'team-d', resultKind: 'walkover', completedAt: '2026-10-01T11:00:00.000Z' })] },
      { roundId: 'r-qf3', roundType: 'quarterfinal', roundIndex: 3, matches: [match('qf3', 'team-e', 'team-f', { status: 'completed', winnerTeamId: 'team-f', finalScoreTeamA: null, finalScoreTeamB: null })] },
      { roundId: 'r-qf4', roundType: 'quarterfinal', roundIndex: 4, matches: [match('qf4', 'team-g', 'team-h', { status: 'completed', winnerTeamId: 'team-g', resultKind: 'played_with_bots', finalScoreTeamA: 151, finalScoreTeamB: 140 })] },
      { roundId: 'r-sf1', roundType: 'semifinal', roundIndex: 1, matches: [match('sf1', 'team-a', 'team-d', { liveScoreTeamA: 82, liveScoreTeamB: 64 })] },
      { roundId: 'r-sf2', roundType: 'semifinal', roundIndex: 2, matches: [match('sf2', 'team-f', 'team-g', { status: 'awaiting_players', liveScoreTeamA: null })] },
    ],
    ...overrides,
  }
}

// ─── [B] Button visibility ───────────────────────────────────────────────────

await check('[B1] "Виж игрите" е скрит при записване/изчакване и видим при започнал/завършил турнир', () => {
  const expected: Record<string, boolean> = {
    open: false, starting: false, semifinal_in_progress: true, final_in_progress: true, finished: true,
    cancelled: false, admin_cancelled: false, auto_cancelled: false, failed: false,
  }
  for (const [status, visible] of Object.entries(expected)) {
    assert(shouldShowTournamentGamesButton(status as any) === visible, `status=${status}`)
    const html = renderTournamentGamesButton(detailFixture({ status }))
    assert((html.includes('data-tournament-matches-open="1"')) === visible, `button html status=${status}`)
  }
})

await check('[B2] видимостта не зависи от наличието на активни маси', () => {
  assert(renderTournamentGamesButton(detailFixture({ status: 'finished', rounds: [] })).includes('Виж игрите'), 'finished with no rounds')
  assert(renderTournamentGamesButton(detailFixture({ status: 'open' })).trim() === '', 'open with rounds data')
})

// ─── [R] Registry + token ────────────────────────────────────────────────────

await check('[R1] subscribe/unsubscribe поддържат reverse index-а синхронизиран; една connection — един турнир', () => {
  const registry = createTournamentMatchesViewerRegistry()
  registry.subscribe('c1', 't1')
  registry.subscribe('c2', 't1')
  registry.subscribe('c1', 't1')
  assert(registry.listSubscriberConnectionIds('t1').sort().join(',') === 'c1,c2', 'both on t1')
  registry.subscribe('c1', 't2')
  assert(registry.listSubscriberConnectionIds('t1').join(',') === 'c2', 'c1 moved off t1')
  assert(registry.getSubscribedTournamentId('c1') === 't2', 'c1 on t2')
  assert(registry.unsubscribe('c1', 't1') === false, 'mismatched tournament unsubscribe is a no-op')
  assert(registry.unsubscribe('c1') === true && registry.unsubscribe('c1') === false, 'idempotent unsubscribe')
  registry.unsubscribe('c2', 't1')
  assert(registry.size() === 0 && !registry.hasSubscribers('t1') && !registry.hasSubscribers('t2'), 'fully empty')
})

await check('[R2] токенът е валиден само за своя турнир и само за процеса, който го е издал', () => {
  const signer = createTournamentMatchesLiveTokenSigner()
  const token = signer.sign('t1')
  assert(signer.verify('t1', token), 'valid token')
  assert(!signer.verify('t2', token), 'other tournament')
  assert(!signer.verify('t1', `${token}x`), 'tampered token')
  assert(!signer.verify('t1', ''), 'empty token')
  assert(!createTournamentMatchesLiveTokenSigner().verify('t1', token), 'token from previous process (restart) is rejected')
})

// ─── [E] Spectator eligibility ───────────────────────────────────────────────

await check('[E1] активна турнирна маса + страничен VIP зрител -> ok', () => {
  const result = evaluateBelotSpectatorWatchEligibility(eligibilityInput())
  assert(result.ok, JSON.stringify(result))
})

await check('[E2] неактивна / неасоциирана среща или липсващи факти -> room_not_watchable (fail-closed)', () => {
  for (const tournamentMatch of [null, undefined, { matchInProgress: false, profileAssignedToMatch: false, profileHasActiveTournamentParticipation: false }]) {
    const result = evaluateBelotSpectatorWatchEligibility(eligibilityInput({ tournamentMatch }))
    assert(!result.ok && result.code === 'room_not_watchable', JSON.stringify(result))
  }
})

await check('[E3] член на отборите в срещата (вкл. заменен от бот) -> participant', () => {
  const result = evaluateBelotSpectatorWatchEligibility(eligibilityInput({
    tournamentMatch: { matchInProgress: true, profileAssignedToMatch: true, profileHasActiveTournamentParticipation: true },
  }))
  assert(!result.ok && result.code === 'participant', JSON.stringify(result))
})

await check('[E4] активен участник в течащ турнир -> active_game_commitment', () => {
  const result = evaluateBelotSpectatorWatchEligibility(eligibilityInput({
    tournamentMatch: { matchInProgress: true, profileAssignedToMatch: false, profileHasActiveTournamentParticipation: true },
  }))
  assert(!result.ok && result.code === 'active_game_commitment', JSON.stringify(result))
})

await check('[E5] приключила турнирна маса (matchEnded) -> room_not_watchable', () => {
  const room = tournamentRoomFixture('room-t1')
  room.game.authoritativeState.matchEnded = { winnerTeam: 'A', targetScore: 151, finalScore: { teamA: 151, teamB: 80 }, endedAt: 1 }
  const result = evaluateBelotSpectatorWatchEligibility(eligibilityInput({ room }))
  assert(!result.ok && result.code === 'room_not_watchable', JSON.stringify(result))
})

await check('[E6] съществуващите проверки остават: VIP, участник на седалка, matchmaking, guest trial, частна маса', () => {
  const noVip = evaluateBelotSpectatorWatchEligibility(eligibilityInput({ vipStatus: { isActive: false } }))
  assert(!noVip.ok && noVip.code === 'vip_required', `vip ${JSON.stringify(noVip)}`)
  const seated = evaluateBelotSpectatorWatchEligibility(eligibilityInput({ connection: connectionFixture('c', 'profile-top') }))
  assert(!seated.ok && seated.code === 'participant', `seated ${JSON.stringify(seated)}`)
  const matchmaking = evaluateBelotSpectatorWatchEligibility(eligibilityInput({ room: playingRoomFixture('mm', { isPrivateTableOrigin: false }), tournamentMatch: null }))
  assert(!matchmaking.ok && matchmaking.code === 'room_not_watchable', `matchmaking ${JSON.stringify(matchmaking)}`)
  const guest = evaluateBelotSpectatorWatchEligibility(eligibilityInput({ room: playingRoomFixture('g', { isPrivateTableOrigin: true, isGuestTrial: true }), tournamentMatch: null }))
  assert(!guest.ok && guest.code === 'room_not_watchable', `guest ${JSON.stringify(guest)}`)
  const tournamentWithoutIds = evaluateBelotSpectatorWatchEligibility(eligibilityInput({ room: playingRoomFixture('t', { isTournamentMatchOrigin: true, isPrivateTableOrigin: true }), tournamentMatch: null }))
  assert(!tournamentWithoutIds.ok && tournamentWithoutIds.code === 'room_not_watchable', `tournament w/o ids ${JSON.stringify(tournamentWithoutIds)}`)
  const privateTable = evaluateBelotSpectatorWatchEligibility(eligibilityInput({ room: playingRoomFixture('p', { isPrivateTableOrigin: true }), tournamentMatch: null }))
  assert(privateTable.ok, `private table ${JSON.stringify(privateTable)}`)
})

// ─── [F] Facts resolver ──────────────────────────────────────────────────────

await check('[F1] асоциация среща <-> маса: само текущата in_progress маса на срещата е гледаема', () => {
  const base = {
    room: tournamentRoomFixture('room-t1'), profileId: 'outsider', tournament: tournamentRecordFixture('semifinal_in_progress'),
    entries: [entryFixture('a1', 'team-a', 'confirmed')], otherActiveTournamentStatus: null,
  }
  const live = resolveTournamentMatchSpectatorFacts({ ...base, matches: [matchRecordFixture({})] })
  assert(live?.matchInProgress === true && !live.profileAssignedToMatch && !live.profileHasActiveTournamentParticipation, JSON.stringify(live))
  const otherRoom = resolveTournamentMatchSpectatorFacts({ ...base, matches: [matchRecordFixture({ roomId: 'room-other' })] })
  assert(otherRoom?.matchInProgress === false, 'room_id mismatch must not be watchable')
  const completed = resolveTournamentMatchSpectatorFacts({ ...base, matches: [matchRecordFixture({ status: 'completed' })] })
  assert(completed?.matchInProgress === false, 'completed match must not be watchable')
  const countdown = resolveTournamentMatchSpectatorFacts({ ...base, matches: [matchRecordFixture({ status: 'countdown' })] })
  assert(countdown?.matchInProgress === false, 'not-yet-started match must not be watchable')
  assert(resolveTournamentMatchSpectatorFacts({ ...base, matches: [] }) === null, 'unknown match -> null')
  assert(resolveTournamentMatchSpectatorFacts({ ...base, tournament: null, matches: [matchRecordFixture({})] }) === null, 'unknown tournament -> null')
})

await check('[F2] членове на срещата и активни участници се разпознават; отпаднали могат да гледат', () => {
  const base = {
    room: tournamentRoomFixture('room-t1'), tournament: tournamentRecordFixture('semifinal_in_progress'),
    matches: [matchRecordFixture({})], otherActiveTournamentStatus: null,
  }
  const entries = [
    entryFixture('member', 'team-b', 'confirmed'),
    entryFixture('waiting', 'team-c', 'confirmed'),
    entryFixture('eliminated', 'team-d', 'eliminated'),
  ]
  const member = resolveTournamentMatchSpectatorFacts({ ...base, entries, profileId: 'member' })
  assert(member?.profileAssignedToMatch === true, 'member')
  const waiting = resolveTournamentMatchSpectatorFacts({ ...base, entries, profileId: 'waiting' })
  assert(waiting?.profileAssignedToMatch === false && waiting.profileHasActiveTournamentParticipation === true, 'waiting team')
  const eliminated = resolveTournamentMatchSpectatorFacts({ ...base, entries, profileId: 'eliminated' })
  assert(eliminated?.profileAssignedToMatch === false && eliminated.profileHasActiveTournamentParticipation === false, 'eliminated')
  const otherRunning = resolveTournamentMatchSpectatorFacts({ ...base, entries, profileId: 'x', otherActiveTournamentStatus: 'final_in_progress' })
  assert(otherRunning?.profileHasActiveTournamentParticipation === true, 'active in another running tournament')
  const otherOpen = resolveTournamentMatchSpectatorFacts({ ...base, entries, profileId: 'x', otherActiveTournamentStatus: 'open' })
  assert(otherOpen?.profileHasActiveTournamentParticipation === false, 'registered in an open tournament only')
})

// ─── [V] View model ──────────────────────────────────────────────────────────

await check('[V1] активни срещи: етап, букви, имена, live резултат, "Гледай" само за играеща маса', () => {
  const model = buildTournamentMatchesViewModel(detailFixture())
  assert(model.live.length === 2, `live=${model.live.length}`)
  const [sf1, sf2] = model.live
  assert(sf1!.stageLabel === 'Полуфинал 1' && sf1!.phase === 'playing', JSON.stringify(sf1))
  assert(sf1!.teamA.letter === 'A' && sf1!.teamA.playerNames.join(',') === 'Мимо,Надя', 'team A')
  assert(sf1!.teamB.letter === 'D' && sf1!.teamB.playerNames.join(',') === 'Мария,Елена', 'team D')
  assert(sf1!.scoreA === 82 && sf1!.scoreB === 64, 'live score from server snapshot')
  assert(sf1!.watch === 'available', 'watch available')
  assert(sf2!.phase === 'upcoming' && sf2!.watch === 'disabled' && sf2!.scoreA === null, JSON.stringify(sf2))
})

await check('[V2] история: подредена по кръгове, победител, бадж, без измислени резултати', () => {
  const model = buildTournamentMatchesViewModel(detailFixture())
  assert(model.history.length === 1 && model.history[0]!.title === 'Четвъртфинал', JSON.stringify(model.history.map((g) => g.title)))
  const [qf1, qf2, qf3, qf4] = model.history[0]!.matches
  assert(qf1!.stageLabel === 'Четвъртфинал 1' && qf1!.scoreA === 152 && qf1!.scoreB === 98 && qf1!.winnerSide === 'A' && qf1!.resultNote === null, JSON.stringify(qf1))
  assert(qf2!.winnerSide === 'B' && qf2!.resultNote === 'Служебна победа' && qf2!.scoreA === null, JSON.stringify(qf2))
  assert(qf3!.winnerSide === 'B' && qf3!.resultNote === 'Резултатът не е запазен' && qf3!.scoreA === null, JSON.stringify(qf3))
  assert(qf4!.resultNote === 'Изиграна с участие на бот', JSON.stringify(qf4))
})

await check('[V3] участник в течащия турнир не получава "Гледай"; feature OFF -> няма "Гледай"', () => {
  const participant = buildTournamentMatchesViewModel(detailFixture({ viewer: { isParticipant: true } }))
  assert(participant.live[0]!.watch === 'participant', 'participant')
  const disabled = buildTournamentMatchesViewModel(detailFixture({ belotSpectatingEnabled: false }))
  assert(disabled.live[0]!.watch === 'disabled', 'feature off')
  const oldServer = buildTournamentMatchesViewModel(detailFixture({ belotSpectatingEnabled: undefined }))
  assert(oldServer.live[0]!.watch === 'disabled', 'missing field -> disabled')
})

await check('[V4] live score patch само за активна среща на същата маса; иначе refetch (null)', () => {
  const detail = detailFixture()
  const patched = applyTournamentMatchLiveScore(detail, { matchId: 'sf1', roomId: 'room-sf1', scoreTeamA: 100, scoreTeamB: 70 })
  assert(patched !== null, 'patched')
  const sf1 = buildTournamentMatchesViewModel(patched!).live.find((card) => card.matchId === 'sf1')!
  assert(sf1.scoreA === 100 && sf1.scoreB === 70, 'patched score')
  assert(applyTournamentMatchLiveScore(detail, { matchId: 'sf2', roomId: 'room-sf2', scoreTeamA: 1, scoreTeamB: 1 }) === null, 'not in_progress')
  assert(applyTournamentMatchLiveScore(detail, { matchId: 'sf1', roomId: 'room-x', scoreTeamA: 1, scoreTeamB: 1 }) === null, 'wrong room')
  assert(applyTournamentMatchLiveScore(detail, { matchId: 'qf1', roomId: 'room-qf1', scoreTeamA: 1, scoreTeamB: 1 }) === null, 'completed match')
  const original = buildTournamentMatchesViewModel(detail).live.find((card) => card.matchId === 'sf1')!
  assert(original.scoreA === 82, 'input snapshot not mutated')
})

await check('[V5] преминаване активна -> приключила: картата отива в историята без "Гледай"', () => {
  const detail = detailFixture()
  detail.rounds[4].matches[0] = { ...detail.rounds[4].matches[0], status: 'completed', winnerTeamId: 'team-d', finalScoreTeamA: 120, finalScoreTeamB: 151, liveScoreTeamA: null, liveScoreTeamB: null }
  const model = buildTournamentMatchesViewModel(detail)
  assert(!model.live.some((card) => card.matchId === 'sf1'), 'sf1 left live section')
  const semis = model.history.find((group) => group.roundType === 'semifinal')
  assert(semis !== undefined && semis.matches[0]!.winnerSide === 'B' && semis.matches[0]!.scoreB === 151, JSON.stringify(semis))
  const html = renderTournamentMatchesView(detail)
  assert(!html.includes('data-watch-tournament-match="room-sf1"'), 'no Гледай for completed match')
})

await check('[V6] завършил/прекратен турнир: историята остава, няма "Играят в момента" карти', () => {
  const finished = buildTournamentMatchesViewModel(detailFixture({ status: 'finished' }))
  assert(finished.live.length === 0 && finished.history.length === 1, JSON.stringify(finished.live))
  const cancelled = buildTournamentMatchesViewModel(detailFixture({ status: 'admin_cancelled' }))
  assert(cancelled.live.length === 0, 'cancelled tournament has no live cards')
})

await check('[V7] стар турнир без отбори/срещи: празни секции, без грешка', () => {
  const model = buildTournamentMatchesViewModel(detailFixture({ status: 'finished', teams: [], rounds: [] }))
  assert(model.live.length === 0 && model.history.length === 0, 'empty')
  const html = renderTournamentMatchesView(detailFixture({ status: 'finished', teams: [], rounds: [] }))
  assert(html.includes('Все още няма приключили срещи.'), 'empty history message')
  const missingTeams = buildTournamentMatchesViewModel(detailFixture({ teams: [] }))
  assert(missingTeams.history[0]!.matches[0]!.teamA.letter === null && missingTeams.history[0]!.matches[0]!.teamA.playerNames.length === 0, 'missing team data stays missing')
})

// ─── [L] Layout HTML ─────────────────────────────────────────────────────────

await check('[L1] адаптивна подредба: grid без фиксирана минимална ширина, без хоризонтален overflow', () => {
  const longName = 'Изключително-дълго-име-на-играч-без-интервали-което-не-бива-да-чупи-подредбата'
  const detail = detailFixture()
  detail.teams[0].members[0].displayName = longName
  const html = renderTournamentMatchesView(detail)
  assert(html.includes('grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))'), 'responsive grid that collapses to one column on phones')
  assert(html.includes('overflow-x:hidden'), 'no horizontal page overflow')
  assert(html.includes('overflow-wrap:anywhere') && html.includes('-webkit-line-clamp:2'), 'long names wrap/clamp')
  assert(html.includes('min-width:0'), 'flex/grid children can shrink')
  assert(html.includes(longName), 'long name rendered (escaped) in full text')
  assert(html.includes('min-height:42px'), 'touch-friendly Гледай button')
})

await check('[L2] HTML: секции, "Гледай" за активната маса, "Приключила" бадж, escape на имената', () => {
  const detail = detailFixture()
  detail.teams[1].members[0].displayName = '<script>x</script>'
  const html = renderTournamentMatchesView(detail)
  assert(html.includes('Играят в момента') && html.includes('История на срещите'), 'sections')
  assert(html.includes('data-watch-tournament-match="room-sf1"'), 'Гледай bound to the exact room')
  assert(!html.includes('data-watch-tournament-match="room-sf2"'), 'no Гледай for upcoming match')
  assert((html.match(/Приключила/g) ?? []).length === 4, 'four finished badges')
  assert(html.includes('data-tournament-live-score="sf1" data-tournament-live-score-team="a"'), 'live score DOM hook')
  assert(!html.includes('<script>x</script>') && html.includes('&lt;script&gt;'), 'names escaped')
  const button = renderTournamentGamesButton(detail)
  assert(button.includes('#22c55e') && button.includes('Виж игрите'), 'green button')
})

// ─── [T] Надпис на етапа по реалния кръг ─────────────────────────────────────

await check('[T1] надписът следва реалния активен кръг, не вътрешния статус', () => {
  const round = (roundId: string, roundType: any) => ({ roundId, tournamentId: 'tournament-1', roundType, roundIndex: 1, createdAt: '' })
  const qfRounds = [1, 2, 3, 4].map((i) => round(`qf${i}`, 'quarterfinal'))
  const qfMatches = qfRounds.map((r) => matchRecordFixture({ matchId: r.roundId, roundId: r.roundId, status: 'in_progress' }))
  assert(resolveActiveTournamentRoundType(qfRounds, qfMatches) === 'quarterfinal', 'all QF live')
  assert(getTournamentStatusLabel('semifinal_in_progress', 'quarterfinal') === 'Четвъртфинали', 'QF label')
  // Per-pair progression: SF1 вече съществува, но QF3 още се играе -> още четвъртфинали.
  const mixed = [
    ...qfMatches.map((m, i) => ({ ...m, status: (i === 2 ? 'in_progress' : 'completed') as any })),
    matchRecordFixture({ matchId: 'sf1', roundId: 'sf1', status: 'in_progress' }),
  ]
  assert(resolveActiveTournamentRoundType([...qfRounds, round('sf1', 'semifinal')], mixed) === 'quarterfinal', 'mixed QF/SF')
  const semis = [...qfMatches.map((m) => ({ ...m, status: 'completed' as const })), matchRecordFixture({ matchId: 'sf1', roundId: 'sf1', status: 'awaiting_players' })]
  assert(resolveActiveTournamentRoundType([...qfRounds, round('sf1', 'semifinal')], semis) === 'semifinal', 'SF')
  assert(getTournamentStatusLabel('semifinal_in_progress', 'semifinal') === 'Полуфинали', 'SF label')
  assert(getTournamentStatusLabel('final_in_progress', 'final') === 'Финал', 'final label')
  assert(getTournamentStatusLabel('semifinal_in_progress', 'round_of_16') === 'Осминафинали', 'R16 label')
  assert(resolveActiveTournamentRoundType([], []) === null, 'no matches')
  assert(getTournamentStatusLabel('semifinal_in_progress', null) === 'Полуфинали', 'fallback without rounds unchanged')
  assert(getTournamentStatusLabel('open', 'quarterfinal') === 'Записване' && getTournamentStatusLabel('finished', 'final') === 'Завършен', 'non-running statuses unchanged')
})

// ─── [Z] Турнирни букви за зрителя ───────────────────────────────────────────

await check('[Z1] буквите на активната среща по маса запазват реда teamA/teamB', () => {
  const detail = detailFixture()
  const letters = resolveTournamentMatchTeamLetters(detail, 'room-sf1')
  assert(letters?.teamA === 'A' && letters.teamB === 'D', JSON.stringify(letters))
  assert(resolveTournamentMatchTeamLetters(detail, 'room-qf1') === null, 'completed match -> null')
  assert(resolveTournamentMatchTeamLetters(detail, 'room-sf2') === null, 'not started -> null')
  assert(resolveTournamentMatchTeamLetters(detail, 'room-unknown') === null, 'unknown room -> null')
})

await check('[Z2] етикетите важат само за същата турнирна маса; обикновените маси остават ОТБОР А/Б', () => {
  rememberTournamentSpectatorTeamLabels('room-sf1', 'A', 'H')
  syncActiveSpectatorTeamLabels({ roomId: 'room-sf1', isTournamentMatchOrigin: true })
  assert(getActiveSpectatorTeamLabels().teamA === 'ОТБОР A' && getActiveSpectatorTeamLabels().teamB === 'ОТБОР H', 'tournament labels')
  syncActiveSpectatorTeamLabels({ roomId: 'private-room', isTournamentMatchOrigin: false })
  assert(getActiveSpectatorTeamLabels() === DEFAULT_SPECTATOR_TEAM_LABELS, 'private table keeps defaults')
  syncActiveSpectatorTeamLabels({ roomId: 'room-other', isTournamentMatchOrigin: true })
  assert(getActiveSpectatorTeamLabels() === DEFAULT_SPECTATOR_TEAM_LABELS, 'other tournament room keeps defaults')
  syncActiveSpectatorTeamLabels(null)
  assert(getActiveSpectatorTeamLabels().teamA === 'ОТБОР А' && getActiveSpectatorTeamLabels().teamB === 'ОТБОР Б', 'exit resets')
  forgetTournamentSpectatorTeamLabels()
  syncActiveSpectatorTeamLabels({ roomId: 'room-sf1', isTournamentMatchOrigin: true })
  assert(getActiveSpectatorTeamLabels() === DEFAULT_SPECTATOR_TEAM_LABELS, 'forgotten labels not reused')
})

// ─── [I] Integration: real coordinator + SQLite ─────────────────────────────

const currentFilePath = fileURLToPath(import.meta.url)
const serverRootPath = join(dirname(currentFilePath), '..')
const migrationsDirectoryPath = join(serverRootPath, 'database', 'migrations')
const manualTransactionMarker = '-- MANUAL_TRANSACTION_MIGRATION'

async function applyMigrations(database: DatabaseSync): Promise<void> {
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec(`CREATE TABLE IF NOT EXISTS server_migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`)
  const getApplied = database.prepare(`SELECT filename FROM server_migrations WHERE filename = ? LIMIT 1;`)
  const insertApplied = database.prepare(`INSERT INTO server_migrations (filename) VALUES (?);`)
  const fileNames = (await readdir(migrationsDirectoryPath, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
  for (const filename of fileNames) {
    if (getApplied.get(filename) !== undefined) continue
    const sql = (await readFile(join(migrationsDirectoryPath, filename), 'utf8')).trim()
    if (sql.length === 0) continue
    if (sql.startsWith(manualTransactionMarker)) {
      database.exec(sql)
      continue
    }
    database.exec('BEGIN;')
    try {
      database.exec(sql)
      insertApplied.run(filename)
      database.exec('COMMIT;')
    } catch (error) {
      try { database.exec('ROLLBACK;') } catch {}
      throw new Error(`Failed to apply migration ${filename}: ${String(error)}`)
    }
  }
}

function publicProfile(profileId: string, index: number): PlayerPublicProfileSnapshot {
  return {
    profileId, displayName: `Играч ${index + 1}`, avatarUrl: null, level: 1, rankTitle: 'Test', skillRating: 1000,
    completedGamesCount: 0, wonGamesCount: 0, currentRankGames: 0, nextRankGames: 10, gamesUntilNextRank: 10,
    rankProgressRatio: 0, averageRating: null, totalRatingsCount: null, yellowCoinsBalance: 100_000, galleryImages: [],
    gender: null, likesCount: null, hasLikedByMe: null, isBlockedByMe: null,
  }
}

function insertProfile(database: DatabaseSync, profileId: string, index: number): void {
  database.prepare(`INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?);`)
    .run(profileId, `Играч ${index + 1}`, `играч ${index + 1}`)
  database.prepare(`INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 100000);`).run(profileId)
}

function connectAllSeats(room: ServerRoom, prefix: string, attached: Set<string>): ServerRoom {
  let next = room
  for (const seat of SEATS) {
    const participant = next.seats[seat].participant
    if (participant?.kind !== 'human' || participant.identity.profileId === null) continue
    const connectionId = `${prefix}-${seat}`
    attached.add(`${participant.identity.profileId}:${connectionId}:${next.id}:${seat}`)
    next = {
      ...next,
      seats: { ...next.seats, [seat]: { ...next.seats[seat], participant: { ...participant, connectionId, isConnected: true, lastSeenAt: Date.now() } } },
    }
  }
  return next
}

function withMatchScore(room: ServerRoom, score: { teamA: number; teamB: number }, winnerTeam: Team | null): ServerRoom {
  const initialized = room.game.authoritativeState !== null ? room : initializeRoomAuthoritativeGameState(room)
  const state = initialized.game.authoritativeState as ServerAuthoritativeGameState
  const nextState: ServerAuthoritativeGameState = winnerTeam === null
    ? { ...state, score: { ...state.score, match: score } }
    : {
        ...state,
        phase: 'match-ended',
        matchEnded: { winnerTeam, targetScore: initialized.config.targetScore, finalScore: score, endedAt: Date.now() },
        score: { ...state.score, match: score },
      }
  return {
    ...initialized,
    status: winnerTeam === null ? initialized.status : 'finished',
    game: {
      ...initialized.game,
      phase: winnerTeam === null ? initialized.game.phase : 'finished',
      stateVersion: initialized.game.stateVersion + 1,
      updatedAt: Date.now(),
      authoritativeState: nextState,
    },
  }
}

const tempDir = await mkdtemp(join(tmpdir(), 'belot-tournament-matches-view-'))
const dbPath = join(tempDir, 'test.sqlite')
let db: DatabaseSync | null = null
let tournamentStore: Awaited<ReturnType<typeof createTournamentStore>> | null = null
let economyStore: Awaited<ReturnType<typeof createTournamentEconomyStore>> | null = null
let scheduler: Awaited<ReturnType<typeof createTournamentScheduler>> | null = null
let coordinator: Awaited<ReturnType<typeof createTournamentCoordinator>> | null = null

try {
  db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  await applyMigrations(db)
  tournamentStore = await createTournamentStore(dbPath)
  economyStore = await createTournamentEconomyStore(dbPath)

  const profileIds = Array.from({ length: 8 }, () => randomUUID())
  profileIds.forEach((profileId, index) => insertProfile(db!, profileId, index))
  const profiles = new Map(profileIds.map((profileId, index) => [profileId, publicProfile(profileId, index)]))
  const rooms = new Map<string, ServerRoom>()
  const attached = new Set<string>()
  const matchesChangedSignals: string[] = []

  const created = tournamentStore.createTournament({
    kind: 'community', name: 'Турнирът на Мишони', creatorProfileId: profileIds[0]!, visibility: 'public',
    entryFee: 10_000, playerCapacity: 8, startMode: 'fill',
  })
  if (!created.ok) throw new Error(`create failed: ${JSON.stringify(created)}`)
  const tournamentId = created.tournament.tournamentId
  for (const profileId of profileIds) {
    const result = economyStore.joinTournamentSoloAtomically(tournamentId, profileId)
    if (!result.ok) throw new Error(`join failed: ${JSON.stringify(result)}`)
  }

  scheduler = await createTournamentScheduler({
    databaseFilePath: dbPath, economyStore, now: () => new Date('2026-07-30T10:00:00.000Z'),
    setInterval: () => ({ unref() {} }) as ReturnType<typeof globalThis.setInterval>, clearInterval: () => {},
  })
  scheduler.tickNow()

  const createCoordinator = () => createTournamentCoordinator({
    databaseFilePath: dbPath,
    getPublicProfile: (profileId) => profiles.get(profileId) ?? null,
    getRoom: (roomId) => rooms.get(roomId) ?? null,
    commitRoom: (room) => { rooms.set(room.id, room) },
    closeCompletedRoom: (room) => { rooms.delete(room.id) },
    ensureRoomRuntime: () => ({ ok: true }),
    settleTournamentPrizes: (id) => {
      const result = economyStore!.settleTournamentPrizesAtomically(id, new Date('2026-07-30T12:00:00.000Z'))
      return result.ok ? { ok: true, alreadySettled: result.alreadySettled } : { ok: false, reason: result.reason }
    },
    notifyAssignment: () => {},
    notifyFeederMatchCompleted: () => {},
    notifyFeederScoreProgress: () => {},
    onMatchesChanged: (id) => { matchesChangedSignals.push(id) },
    isConnectionAttached: ({ profileId, connectionId, roomId, seat }) => attached.has(`${profileId}:${connectionId}:${roomId}:${seat}`),
    isProfileOnline: (profileId) => [...attached].some((key) => key.startsWith(`${profileId}:`)),
    setInterval: () => ({ unref() {} }) as ReturnType<typeof globalThis.setInterval>,
    clearInterval: () => {},
  })

  // Сглобява client-shaped detail точно както buildTournamentDetailDto в
  // index.ts (същите DTO builders + live score от authoritative room state).
  const buildDetail = (store: NonNullable<typeof tournamentStore>): any => {
    const tournament = store.getTournamentById(tournamentId)!
    const entries = store.getEntriesForTournament(tournamentId)
    const base = toTournamentDetailDto({
      tournament, creatorPublicProfile: null, confirmedEntriesCount: entries.length, completedTeamsCount: 4,
      viewerProfileId: null, viewerEntryStatus: null,
    })
    return {
      ...base,
      teams: buildTeamDtos({ teams: store.getTeamsForTournament(tournamentId), entries, getPublicProfile: (id) => profiles.get(id) ?? null }),
      rounds: buildTournamentRoundDtos({
        rounds: store.getRoundsForTournament(tournamentId),
        matches: store.getMatchesForTournament(tournamentId),
        getLiveScoreForRoom: (roomId) => {
          const authState = rooms.get(roomId)?.game.authoritativeState ?? null
          if (authState === null || 'kind' in authState || authState.matchEnded !== null) return null
          return { teamA: authState.score.match.teamA, teamB: authState.score.match.teamB }
        },
      }),
      belotSpectatingEnabled: true,
      matchesLiveToken: 'token',
    }
  }
  const semifinalIds = () => tournamentStore!.getMatchesForTournament(tournamentId)
    .filter((match) => tournamentStore!.getRoundsForTournament(tournamentId).find((round) => round.roundId === match.roundId)?.roundType === 'semifinal')
  const forceCountdownElapsed = (matchId: string) => {
    db!.prepare(`UPDATE tournament_matches SET game_start_at = '2026-07-30T09:59:00.000Z' WHERE match_id = ?;`).run(matchId)
  }

  coordinator = await createCoordinator()
  coordinator.tickNow()

  await check('[I1] започнал турнир: бутонът е видим, срещите са "предстоящи", няма история', () => {
    const detail = buildDetail(tournamentStore!)
    assert(shouldShowTournamentGamesButton(detail.status), `status=${detail.status}`)
    const model = buildTournamentMatchesViewModel(detail)
    assert(model.live.length === 2 && model.live.every((card) => card.phase === 'upcoming' && card.watch === 'disabled'), JSON.stringify(model.live))
    assert(model.history.length === 0, 'no history yet')
    assert(model.live.every((card) => card.teamA.playerNames.length === 2 && card.teamB.playerNames.length === 2), 'team members resolved')
  })

  const [sf1Initial, sf2Initial] = semifinalIds()
  const sf1Id = sf1Initial!.matchId
  rooms.set(sf1Initial!.roomId!, connectAllSeats(rooms.get(sf1Initial!.roomId!)!, 'sf1', attached))
  rooms.set(sf2Initial!.roomId!, connectAllSeats(rooms.get(sf2Initial!.roomId!)!, 'sf2', attached))
  coordinator.tickNow()
  for (const match of semifinalIds()) forceCountdownElapsed(match.matchId)
  matchesChangedSignals.length = 0
  coordinator.tickNow()

  await check('[I2] старт на срещите -> onMatchesChanged; срещата е "На живо" с "Гледай" към точната маса', () => {
    assert(matchesChangedSignals.filter((id) => id === tournamentId).length >= 2, `signals=${matchesChangedSignals.length}`)
    const model = buildTournamentMatchesViewModel(buildDetail(tournamentStore!))
    const sf1 = model.live.find((card) => card.matchId === sf1Id)!
    const sf1Row = semifinalIds().find((match) => match.matchId === sf1Id)!
    assert(sf1.phase === 'playing' && sf1.watch === 'available', JSON.stringify(sf1))
    assert(sf1.roomId === sf1Row.roomId && rooms.get(sf1.roomId!)?.config.tournamentMatchId === sf1Id, 'room <-> match association')
    assert(sf1.scoreA === 0 && sf1.scoreB === 0, `initial live score ${sf1.scoreA}:${sf1.scoreB}`)
  })

  const sf1RoomId = semifinalIds().find((match) => match.matchId === sf1Id)!.roomId!
  rooms.set(sf1RoomId, withMatchScore(rooms.get(sf1RoomId)!, { teamA: 82, teamB: 64 }, null))

  await check('[I3] live резултатът идва от authoritative room state', () => {
    const sf1 = buildTournamentMatchesViewModel(buildDetail(tournamentStore!)).live.find((card) => card.matchId === sf1Id)!
    assert(sf1.scoreA === 82 && sf1.scoreB === 64, `${sf1.scoreA}:${sf1.scoreB}`)
  })

  await check('[I4] watch facts: страничен зрител може, член на срещата и чакащ участник — не', () => {
    const room = rooms.get(sf1RoomId)!
    const tournament = tournamentStore!.getTournamentById(tournamentId)
    const matches = tournamentStore!.getMatchesForTournament(tournamentId)
    const entries = tournamentStore!.getEntriesForTournament(tournamentId)
    const sf1Row = matches.find((match) => match.matchId === sf1Id)!
    const memberId = entries.find((entry) => entry.teamId === sf1Row.teamAId)!.profileId
    const otherId = entries.find((entry) => entry.teamId !== sf1Row.teamAId && entry.teamId !== sf1Row.teamBId)!.profileId
    const facts = (profileId: string) => resolveTournamentMatchSpectatorFacts({ room, profileId, tournament, matches, entries, otherActiveTournamentStatus: null })
    const outsider = facts(randomUUID())
    assert(outsider?.matchInProgress === true && !outsider.profileAssignedToMatch && !outsider.profileHasActiveTournamentParticipation, JSON.stringify(outsider))
    assert(facts(memberId)?.profileAssignedToMatch === true, 'match member')
    assert(facts(otherId)?.profileHasActiveTournamentParticipation === true, 'other active participant')
  })

  matchesChangedSignals.length = 0
  const finishedSf1 = withMatchScore(rooms.get(sf1RoomId)!, { teamA: 152, teamB: 98 }, 'A')
  rooms.set(sf1RoomId, finishedSf1)
  coordinator.onTournamentRoomCompleted(finishedSf1)

  await check('[I5] край на срещата -> onMatchesChanged; срещата е в историята с краен резултат и победител, масата е затворена', () => {
    assert(matchesChangedSignals.includes(tournamentId), 'completion signal')
    assert(!rooms.has(sf1RoomId), 'room closed (spectators get belot_spectate_ended via room removal)')
    const model = buildTournamentMatchesViewModel(buildDetail(tournamentStore!))
    assert(!model.live.some((card) => card.matchId === sf1Id), 'not live anymore')
    const card = model.history.flatMap((group) => group.matches).find((item) => item.matchId === sf1Id)!
    assert(card.scoreA === 152 && card.scoreB === 98 && card.winnerSide === 'A', JSON.stringify(card))
  })

  const sf2RoomId = semifinalIds().find((match) => match.matchId !== sf1Id)!.roomId!
  matchesChangedSignals.length = 0
  const finishedSf2 = withMatchScore(rooms.get(sf2RoomId)!, { teamA: 110, teamB: 151 }, 'B')
  rooms.set(sf2RoomId, finishedSf2)
  coordinator.onTournamentRoomCompleted(finishedSf2)

  await check('[I6] нов кръг (финал) се появява като предстояща среща; историята пази двата полуфинала', () => {
    assert(matchesChangedSignals.includes(tournamentId), 'signal after second semifinal')
    const detail = buildDetail(tournamentStore!)
    const model = buildTournamentMatchesViewModel(detail)
    const final = model.live.find((card) => card.roundType === 'final')
    assert(final !== undefined && final.stageLabel === 'Финал' && final.phase === 'upcoming', JSON.stringify(model.live))
    const semis = model.history.find((group) => group.roundType === 'semifinal')
    assert(semis !== undefined && semis.matches.length === 2, 'two semifinal results')
  })

  const historyBeforeRestart = JSON.stringify(buildTournamentMatchesViewModel(buildDetail(tournamentStore!)).history)
  coordinator.close()
  tournamentStore.close()
  tournamentStore = await createTournamentStore(dbPath)
  coordinator = await createCoordinator()
  coordinator.tickNow()

  await check('[I7] историята е идентична след restart (нов store + coordinator върху същата база)', () => {
    const historyAfterRestart = JSON.stringify(buildTournamentMatchesViewModel(buildDetail(tournamentStore!)).history)
    assert(historyAfterRestart === historyBeforeRestart, 'history changed after restart')
    assert(historyAfterRestart.includes('"scoreA":152') && historyAfterRestart.includes('"scoreB":151'), 'scores persisted')
  })

  const finalMatch = tournamentStore.getMatchesForTournament(tournamentId).find((match) => match.status !== 'completed')!
  rooms.set(finalMatch.roomId!, connectAllSeats(rooms.get(finalMatch.roomId!)!, 'final', attached))
  coordinator.tickNow()
  forceCountdownElapsed(finalMatch.matchId)
  coordinator.tickNow()
  const finishedFinal = withMatchScore(rooms.get(finalMatch.roomId!)!, { teamA: 151, teamB: 133 }, 'A')
  rooms.set(finalMatch.roomId!, finishedFinal)
  matchesChangedSignals.length = 0
  coordinator.onTournamentRoomCompleted(finishedFinal)
  coordinator.tickNow()

  await check('[I8] завършен турнир: бутонът остава, няма активни срещи, пълна история по кръгове', () => {
    const detail = buildDetail(tournamentStore!)
    assert(detail.status === 'finished', `status=${detail.status}`)
    assert(shouldShowTournamentGamesButton(detail.status), 'button visible after finish')
    const model = buildTournamentMatchesViewModel(detail)
    assert(model.live.length === 0, 'no live matches')
    assert(model.history.map((group) => group.roundType).join(',') === 'semifinal,final', model.history.map((group) => group.roundType).join(','))
    assert(model.history[1]!.matches[0]!.winnerSide === 'A' && model.history[1]!.matches[0]!.scoreA === 151, 'final result')
    assert(matchesChangedSignals.includes(tournamentId), 'final completion signal')
  })

  await check('[I9] схемата не е променяна — нужните колони вече съществуват (без нова миграция)', () => {
    const columns = (db!.prepare(`PRAGMA table_info(tournament_matches);`).all() as Array<{ name: string }>).map((column) => column.name)
    for (const name of ['room_id', 'team_a_id', 'team_b_id', 'winner_team_id', 'final_score_team_a', 'final_score_team_b', 'result_kind', 'completed_at']) {
      assert(columns.includes(name), `missing column ${name}`)
    }
    const teamColumns = (db!.prepare(`PRAGMA table_info(tournament_teams);`).all() as Array<{ name: string }>).map((column) => column.name)
    assert(teamColumns.includes('seed_slot'), 'seed_slot (team letters) persisted')
  })
} finally {
  try { coordinator?.close() } catch {}
  try { scheduler?.close() } catch {}
  try { economyStore?.close() } catch {}
  try { tournamentStore?.close() } catch {}
  try { db?.close() } catch {}
  await rm(tempDir, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`checkTournamentMatchesView failed: ${failed} failed, ${passed} passed.`)
  process.exit(1)
}
console.log(`checkTournamentMatchesView passed: ${passed} checks.`)
