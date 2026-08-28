import { randomUUID } from 'node:crypto'
import { dbDateToUtc } from '../db/dbDate.js'
import type { TournamentId, TournamentStatus } from './tournamentTypes.js'
import { getTournamentRoundLadder } from './tournamentTypes.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type TournamentIntegrityState = 'healthy' | 'warning' | 'error'

export type TournamentIntegrityCode =
  | 'missing_financial_snapshot'
  | 'invalid_financial_snapshot'
  | 'invalid_entry_debit_count'
  | 'invalid_entry_debit_sum'
  | 'duplicate_entry_profile'
  | 'missing_system_fee_ledger'
  | 'conflicting_system_fee_ledger'
  | 'missing_team_member'
  | 'duplicate_team_member'
  | 'invalid_team_count'
  | 'missing_semifinal'
  | 'duplicate_semifinal'
  | 'missing_final'
  | 'duplicate_final'
  | 'invalid_match_teams'
  | 'completed_match_without_winner'
  | 'room_assignment_missing'
  | 'room_snapshot_missing'
  | 'attendance_state_conflict'
  | 'replacement_state_conflict'
  | 'finished_without_settlement'
  | 'settled_without_finished'
  | 'incomplete_prize_payouts'
  | 'conflicting_prize_payout'
  | 'invalid_champion'
  | 'invalid_runner_up'
  | 'finished_timestamp_missing'
  | 'unexpected_wallet_related_ledger'
  | 'missing_fill_expiry'
  | 'invalid_fill_expiry'
  | 'incomplete_fill_timeout_refunds'
  | 'fill_timeout_after_start'
  | 'system_fee_on_fill_timeout_cancel'

export type TournamentIntegrityIssue = {
  code: TournamentIntegrityCode
  severity: 'warning' | 'error'
  recoverable: boolean
  summary: string
}

export type TournamentIntegrityReport = {
  state: TournamentIntegrityState
  issues: TournamentIntegrityIssue[]
}

export type AdminTournamentListFilter = {
  page: number
  limit: number
  status?: TournamentStatus | null
  settlementState?: 'pending' | 'settled' | null
  visibility?: 'public' | 'password' | null
  startMode?: 'fill' | 'scheduled' | null
  integrityState?: TournamentIntegrityState | null
  createdFrom?: string | null
  createdTo?: string | null
  finishedFrom?: string | null
  finishedTo?: string | null
  search?: string | null
}

export type AdminTournamentSummary = {
  tournamentId: string
  name: string
  creator: { profileId: string; displayName: string; avatarUrl: string | null }
  visibility: 'public' | 'password'
  entryFee: number
  participantsCount: number
  currentStage: string
  status: string
  settlementState: 'pending' | 'settled'
  createdAt: string
  scheduledStartAt: string | null
  fillExpiresAt: string | null
  finishedAt: string | null
  integrity: TournamentIntegrityReport
}

export type AdminTournamentDetail = AdminTournamentSummary & {
  startedAt: string | null
  rulesVersion: string | null
  teams: Array<{
    teamId: string
    seedSlot: number | null
    status: string
    members: Array<{
      profileId: string
      displayName: string
      avatarUrl: string | null
      joinedAs: string
      entryStatus: string
      paidEntry: boolean
    }>
  }>
  bracket: Array<{
    matchId: string
    roundType: 'semifinal' | 'final'
    roundIndex: number
    teamAId: string
    teamBId: string
    status: string
    roomReady: boolean
    resultKind: string | null
    winnerTeamId: string | null
    loserTeamId: string | null
    played: boolean
    playedWithBots: boolean
    walkover: boolean
    attendanceResolution: string | null
    replacementCount: number
    takeoverCount: number
    roomSnapshotRecoverable: boolean
  }>
  finance: {
    totalEntry: number | null
    systemFee: number | null
    prizePool: number | null
    winnerTeamPrize: number | null
    winnerPlayerPrize: number | null
    runnerUpTeamPrize: number | null
    runnerUpPlayerPrize: number | null
    entryDebitCount: number
    entryDebitSum: number
    refundCount: number
    refundSum: number
    systemFeeLedgerPresent: boolean
    prizePayoutCount: number
    prizePayoutSum: number
    settlementIntegrity: TournamentIntegrityState
  }
  events: {
    page: number
    limit: number
    totalCount: number
    rows: Array<{ eventType: string; summary: string; createdAt: string }>
  }
  operations: {
    coordinatorState: string | null
    schedulerState: string | null
    roomAssignmentsRecoverable: boolean
  }
  actions: {
    canReconcile: boolean
    canCancelOpen: boolean
    cancelRefundTotal: number
  }
}

export type AdminCancelOpenResult =
  | { ok: true; alreadyCancelled: boolean; refundedEntries: number; totalRefunded: number }
  | { ok: false; reason: 'not_found' | 'not_open' | 'unsafe_state' | 'integrity_error' }

export type AdminReconcileResult =
  | { ok: true; status: 'accepted' | 'already_consistent' | 'no_safe_action' }
  | { ok: false; status: 'blocked_by_integrity_error' | 'not_found' }

export type TournamentAdminStore = {
  listAdminTournaments: (filter: AdminTournamentListFilter) => { rows: AdminTournamentSummary[]; totalCount: number }
  getAdminTournamentDetail: (tournamentId: TournamentId, eventPage: number, eventLimit: number) => AdminTournamentDetail | null
  analyzeTournamentIntegrity: (tournamentId: TournamentId) => TournamentIntegrityReport
  getHealthSnapshot: () => {
    activeTournamentCount: number
    pendingSettlementCount: number
    integrityErrorCount: number
    recoverableWarningCount: number
    lastSuccessfulReconciliation: string | null
    lastFailedReconciliationCode: string | null
  }
  reconcileTournament: (tournamentId: TournamentId, actorProfileId: string | null) => AdminReconcileResult
  cancelOpenTournament: (tournamentId: TournamentId, actorProfileId: string | null) => AdminCancelOpenResult
  close: () => void
}

type PublicProfile = { profileId: string | null; displayName: string; avatarUrl: string | null }

type TournamentRow = {
  tournament_id: string
  name: string
  creator_profile_id: string
  visibility: 'public' | 'password'
  entry_fee: number
  player_capacity: number
  start_mode: 'fill' | 'scheduled'
  scheduled_start_at: string | null
  fill_expires_at: string | null
  status: string
  cancel_reason: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  finished_at: string | null
  champion_team_id: string | null
  runner_up_team_id: string | null
  settlement_state: 'pending' | 'settled'
  settled_at: string | null
  total_entry_amount: number | null
  system_fee_amount: number | null
  prize_pool_amount: number | null
  winner_team_prize_amount: number | null
  runner_up_team_prize_amount: number | null
  winner_player_prize_amount: number | null
  runner_up_player_prize_amount: number | null
  financial_rules_version: string | null
}

type AdminDeps = {
  databaseFilePath: string
  getPublicProfile: (profileId: string) => PublicProfile | null
  getCoordinatorHealth?: () => { state: string; lastSuccessAt: string | null; lastError: string | null } | null
  getSchedulerHealth?: () => { state: string; lastSuccessAt: string | null; lastError: string | null } | null
  runCoordinatorTick?: () => void
}

const ACTIVE_STATUSES = ['open', 'starting', 'semifinal_in_progress', 'final_in_progress']
const TERMINAL_STATUSES = ['finished', 'cancelled', 'admin_cancelled', 'auto_cancelled', 'failed']
const MAX_SEARCH_LENGTH = 80

function asUtc(value: string | null): string | null {
  return value === null ? null : dbDateToUtc(value)
}

function coerceCount(row: unknown): number {
  return Number((row as { count?: number } | undefined)?.count ?? 0)
}

function coerceSum(row: unknown): number {
  return Number((row as { sum?: number | null } | undefined)?.sum ?? 0)
}

function profileDto(profileId: string, getPublicProfile: (profileId: string) => PublicProfile | null) {
  const profile = getPublicProfile(profileId)
  return {
    profileId,
    displayName: profile?.displayName ?? 'Играч',
    avatarUrl: profile?.avatarUrl ?? null,
  }
}

function safeEventSummary(payload: string | null): string {
  if (payload === null) return ''
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>
    const keys = Object.keys(parsed)
      .filter((key) => !/password|token|balance|session|stack|connection/i.test(key))
      .slice(0, 4)
    return keys.map((key) => `${key}: ${String(parsed[key]).slice(0, 80)}`).join(', ')
  } catch {
    return ''
  }
}

function addIssue(
  issues: TournamentIntegrityIssue[],
  code: TournamentIntegrityCode,
  severity: 'warning' | 'error',
  summary: string,
  recoverable = severity === 'warning',
): void {
  issues.push({ code, severity, recoverable, summary })
}

function reportFromIssues(issues: TournamentIntegrityIssue[]): TournamentIntegrityReport {
  if (issues.some((issue) => issue.severity === 'error')) return { state: 'error', issues }
  if (issues.length > 0) return { state: 'warning', issues }
  return { state: 'healthy', issues: [] }
}

export async function createTournamentAdminStore(deps: AdminDeps): Promise<TournamentAdminStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(deps.databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')

  const tournamentColumns = `
    tournament_id, name, creator_profile_id, visibility, entry_fee, player_capacity,
    start_mode, scheduled_start_at, fill_expires_at, status, cancel_reason, created_at, updated_at,
    started_at, finished_at, champion_team_id, runner_up_team_id, settlement_state,
    settled_at, total_entry_amount, system_fee_amount, prize_pool_amount,
    winner_team_prize_amount, runner_up_team_prize_amount, winner_player_prize_amount,
    runner_up_player_prize_amount, financial_rules_version
  `

  const getTournamentStatement = database.prepare(`
    SELECT ${tournamentColumns}
    FROM tournaments
    WHERE tournament_id = ?
    LIMIT 1;
  `)

  const countEntriesStatement = database.prepare(`
    SELECT COUNT(*) AS count
    FROM tournament_entries
    WHERE tournament_id = ? AND status IN ('confirmed', 'finalist', 'champion', 'eliminated');
  `)

  const countCompletedTeamsStatement = database.prepare(`
    SELECT COUNT(*) AS count
    FROM tournament_teams
    WHERE tournament_id = ? AND status <> 'forming';
  `)

  const ledgerCountSumStatement = database.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS sum
    FROM tournament_economy_ledger
    WHERE tournament_id = ? AND entry_type = ?;
  `)

  // Net-per-profile entry economy за integrity анализ — огледално на
  // selectActiveEntriesWithLatestDebitLedgerStatement в tournamentEconomyStore.ts
  // (settlement fix за debit→refund→re-entry, commit 8d537cf). Global
  // ledgerCountSumStatement('entry_fee_debit') брои ВСИЧКИ исторически debit
  // редове — след валиден debit→refund→re-entry, gross count/sum естествено
  // надвишава current paid participation, което invalid_entry_debit_count/
  // invalid_entry_debit_sum по-долу погрешно flag-ваше като integrity грешка.
  // Тук вместо това join-ваме directly paid tournament_entries (confirmed/
  // finalist/champion/eliminated) към ПОСЛЕДНИЯ entry_fee_debit ред per
  // profile — refund-нат-без-re-entry профил вече не е paid entry (изключен
  // от JOIN-а чрез самия WHERE te.status IN (...) филтър), а re-entered
  // профил коректно взима най-новия си debit, не по-стария refund-нат.
  // COUNT(tel.ledger_id) — НЕ COUNT(*) — е задължително тук: с LEFT JOIN,
  // COUNT(*) би броил всеки te ред дори когато tel е NULL (профил без нито
  // един entry_fee_debit ledger запис изобщо), скривайки реална missing-debit
  // корупция зад привидно вярна бройка. COUNT(tel.ledger_id) брои само
  // редовете, за които действително е намерен debit ledger запис.
  const netPaidEntryDebitsStatement = database.prepare(`
    SELECT COUNT(tel.ledger_id) AS count, COALESCE(SUM(tel.amount), 0) AS sum
    FROM tournament_entries te
    LEFT JOIN tournament_economy_ledger tel
      ON tel.ledger_id = (
        SELECT latest_tel.ledger_id
        FROM tournament_economy_ledger latest_tel
        WHERE latest_tel.tournament_id = te.tournament_id
          AND latest_tel.profile_id = te.profile_id
          AND latest_tel.entry_type = 'entry_fee_debit'
        ORDER BY latest_tel.created_at DESC, latest_tel.ledger_id DESC
        LIMIT 1
      )
    WHERE te.tournament_id = ?
      AND te.status IN ('confirmed', 'finalist', 'champion', 'eliminated');
  `)

  const countEventsStatement = database.prepare(`
    SELECT COUNT(*) AS count
    FROM tournament_events
    WHERE tournament_id = ?;
  `)

  const listEventsStatement = database.prepare(`
    SELECT event_type, payload_json, created_at
    FROM tournament_events
    WHERE tournament_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?;
  `)

  const insertEventStatement = database.prepare(`
    INSERT INTO tournament_events (
      event_id, tournament_id, event_type, actor_profile_id, actor_role, payload_json
    ) VALUES (?, ?, ?, ?, 'admin', ?);
  `)

  function buildWhere(filter: AdminTournamentListFilter): { where: string; params: Array<string | number> } {
    const conditions: string[] = []
    const params: Array<string | number> = []

    if (filter.status) {
      conditions.push('t.status = ?')
      params.push(filter.status)
    }
    if (filter.settlementState) {
      conditions.push('t.settlement_state = ?')
      params.push(filter.settlementState)
    }
    if (filter.visibility) {
      conditions.push('t.visibility = ?')
      params.push(filter.visibility)
    }
    if (filter.startMode) {
      conditions.push('t.start_mode = ?')
      params.push(filter.startMode)
    }
    if (filter.createdFrom) {
      conditions.push('t.created_at >= ?')
      params.push(filter.createdFrom)
    }
    if (filter.createdTo) {
      conditions.push('t.created_at <= ?')
      params.push(filter.createdTo)
    }
    if (filter.finishedFrom) {
      conditions.push('t.finished_at >= ?')
      params.push(filter.finishedFrom)
    }
    if (filter.finishedTo) {
      conditions.push('t.finished_at <= ?')
      params.push(filter.finishedTo)
    }

    const search = (filter.search ?? '').trim().slice(0, MAX_SEARCH_LENGTH)
    if (search !== '') {
      conditions.push(`(
        t.tournament_id = ?
        OR t.name LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM profiles p
          WHERE p.profile_id = t.creator_profile_id
            AND p.display_name LIKE ? ESCAPE '\\'
        )
      )`)
      const like = `%${search.replace(/[\\%_]/g, '\\$&')}%`
      params.push(search, like, like)
    }

    return {
      where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
      params,
    }
  }

  function analyzeTournamentIntegrity(tournamentId: TournamentId): TournamentIntegrityReport {
    const tournament = getTournamentStatement.get(tournamentId) as TournamentRow | undefined
    if (tournament === undefined) {
      return reportFromIssues([
        {
          code: 'invalid_team_count',
          severity: 'error',
          recoverable: false,
          summary: 'Tournament record was not found.',
        },
      ])
    }

    const issues: TournamentIntegrityIssue[] = []
    const teams = database.prepare(`
      SELECT team_id, status, seed_slot
      FROM tournament_teams
      WHERE tournament_id = ?;
    `).all(tournamentId) as Array<{ team_id: string; status: string; seed_slot: number | null }>
    const rounds = database.prepare(`
      SELECT round_id, round_type, round_index
      FROM tournament_rounds
      WHERE tournament_id = ?;
    `).all(tournamentId) as Array<{ round_id: string; round_type: 'semifinal' | 'final'; round_index: number }>
    const matches = database.prepare(`
      SELECT tm.match_id, tm.round_id, tm.room_id, tm.team_a_id, tm.team_b_id, tm.status,
             tm.winner_team_id, tm.result_kind, tm.attendance_resolution_kind
      FROM tournament_matches tm
      WHERE tm.tournament_id = ?;
    `).all(tournamentId) as Array<{
      match_id: string
      round_id: string
      room_id: string | null
      team_a_id: string
      team_b_id: string
      status: string
      winner_team_id: string | null
      result_kind: string | null
      attendance_resolution_kind: string | null
    }>
    const entries = database.prepare(`
      SELECT profile_id, team_id, status
      FROM tournament_entries
      WHERE tournament_id = ?;
    `).all(tournamentId) as Array<{ profile_id: string; team_id: string | null; status: string }>
    const paidParticipantEntries = entries.filter((entry) => (
      entry.status === 'confirmed'
      || entry.status === 'finalist'
      || entry.status === 'champion'
      || entry.status === 'eliminated'
    ))

    if (tournament.status !== 'open' && tournament.status !== 'cancelled' && tournament.status !== 'admin_cancelled') {
      if (tournament.total_entry_amount === null || tournament.system_fee_amount === null || tournament.prize_pool_amount === null) {
        addIssue(issues, 'missing_financial_snapshot', 'error', 'Started tournament is missing its financial snapshot.', false)
      } else if (tournament.total_entry_amount !== tournament.entry_fee * paidParticipantEntries.length) {
        addIssue(issues, 'invalid_financial_snapshot', 'error', 'Financial snapshot does not match paid participant entries.', false)
      }
    }

    const netEntryDebits = netPaidEntryDebitsStatement.get(tournamentId) as { count: number; sum: number }
    if (paidParticipantEntries.length > 0 && netEntryDebits.count !== paidParticipantEntries.length) {
      addIssue(issues, 'invalid_entry_debit_count', 'error', 'Entry debit ledger count does not match participant entries.', false)
    }
    if (netEntryDebits.count > 0 && tournament.status !== 'open' && tournament.total_entry_amount !== null && netEntryDebits.sum !== tournament.total_entry_amount) {
      addIssue(issues, 'invalid_entry_debit_sum', 'error', 'Entry debit ledger sum does not match financial snapshot.', false)
    }

    const duplicateProfiles = database.prepare(`
      SELECT profile_id, COUNT(*) AS count
      FROM tournament_entries
      WHERE tournament_id = ?
      GROUP BY profile_id
      HAVING COUNT(*) > 1;
    `).all(tournamentId)
    if (duplicateProfiles.length > 0) {
      addIssue(issues, 'duplicate_entry_profile', 'error', 'Duplicate participant profile was found.', false)
    }

    const expectedTeamCapacity = tournament.player_capacity / 2
    if (ACTIVE_STATUSES.includes(tournament.status) && tournament.status !== 'open' && teams.length !== expectedTeamCapacity) {
      addIssue(issues, 'invalid_team_count', 'error', 'Started tournament team count does not match its player capacity.', false)
    }

    for (const team of teams) {
      const memberCount = entries.filter((entry) => entry.team_id === team.team_id && ['confirmed', 'finalist', 'champion', 'eliminated'].includes(entry.status)).length
      if (team.status !== 'forming' && memberCount !== 2) {
        addIssue(issues, 'missing_team_member', 'error', 'Locked tournament team does not have two members.', false)
      }
      const profileSet = new Set(entries.filter((entry) => entry.team_id === team.team_id).map((entry) => entry.profile_id))
      if (profileSet.size < entries.filter((entry) => entry.team_id === team.team_id).length) {
        addIssue(issues, 'duplicate_team_member', 'error', 'A team contains a duplicate member.', false)
      }
    }

    // "missing_semifinal"/"duplicate_semifinal" кодовете се пазят непроменени
    // (виж TournamentIntegrityCode) за backward compatibility, но проверката
    // вече е generic за целия round ladder (round_of_16/quarterfinal/
    // semifinal), не само буквално round_type='semifinal'. Първият ladder
    // кръг трябва да съществува веднага щом турнирът е напуснал 'open'; всеки
    // следващ ladder кръг се очаква само откакто турнирът напредне достатъчно
    // (rounds[] просто няма да го съдържа още, което е валидно, не грешка).
    if (['starting', 'semifinal_in_progress', 'final_in_progress', 'finished'].includes(tournament.status)) {
      const roundLadder = getTournamentRoundLadder(expectedTeamCapacity)
      const firstRoundType = roundLadder[0]
      const firstRounds = rounds.filter((round) => round.round_type === firstRoundType)
      const expectedFirstRoundMatchCount = expectedTeamCapacity / 2
      if (firstRounds.length === 0) addIssue(issues, 'missing_semifinal', 'error', 'First bracket round is missing.', false)
      if (firstRounds.length > expectedFirstRoundMatchCount) addIssue(issues, 'duplicate_semifinal', 'error', 'Duplicate first-round bracket rounds were found.', false)
      const firstRoundMatches = matches.filter((match) => firstRounds.some((round) => round.round_id === match.round_id))
      if (firstRoundMatches.length < expectedFirstRoundMatchCount) addIssue(issues, 'missing_semifinal', 'error', 'First bracket round is missing matches.', false)
      if (firstRoundMatches.length > expectedFirstRoundMatchCount) addIssue(issues, 'duplicate_semifinal', 'error', 'More first-round bracket matches were found than expected.', false)

      for (const roundType of roundLadder) {
        const roundsOfType = rounds.filter((round) => round.round_type === roundType)
        if (roundsOfType.length === 0) continue
        const expectedMatchCount = roundType === 'final'
          ? 1
          : roundType === 'semifinal'
            ? 2
            : roundType === 'quarterfinal'
              ? 4
              : 8
        const matchesOfType = matches.filter((match) => roundsOfType.some((round) => round.round_id === match.round_id))
        if (roundsOfType.length > expectedMatchCount) {
          addIssue(issues, 'duplicate_semifinal', 'error', `Duplicate ${roundType} rounds were found.`, false)
        }
        if (matchesOfType.length > expectedMatchCount) {
          addIssue(issues, 'duplicate_semifinal', 'error', `More ${roundType} matches were found than expected.`, false)
        }
      }
    }

    if (['final_in_progress', 'finished'].includes(tournament.status)) {
      const finalRounds = rounds.filter((round) => round.round_type === 'final')
      const finalMatches = matches.filter((match) => finalRounds.some((round) => round.round_id === match.round_id))
      if (finalMatches.length === 0) addIssue(issues, 'missing_final', 'warning', 'Final match has not been created yet.', true)
      if (finalMatches.length > 1) addIssue(issues, 'duplicate_final', 'error', 'Duplicate final matches were found.', false)
    }

    const teamIds = new Set(teams.map((team) => team.team_id))
    for (const match of matches) {
      if (match.team_a_id === match.team_b_id || !teamIds.has(match.team_a_id) || !teamIds.has(match.team_b_id)) {
        addIssue(issues, 'invalid_match_teams', 'error', 'Match points to invalid teams.', false)
      }
      if (match.status === 'completed' && match.winner_team_id === null) {
        addIssue(issues, 'completed_match_without_winner', 'error', 'Completed match is missing a winner.', false)
      }
      if (match.room_id === null && ['starting', 'semifinal_in_progress', 'final_in_progress'].includes(tournament.status) && match.status !== 'completed') {
        addIssue(issues, 'room_assignment_missing', 'warning', 'Pending match has no room assignment yet.', true)
      }
      if (match.status === 'countdown' && match.attendance_resolution_kind === null) {
        addIssue(issues, 'attendance_state_conflict', 'error', 'Countdown match is missing attendance resolution.', false)
      }
    }

    const replacementsConflict = database.prepare(`
      SELECT match_id, assigned_seat, COUNT(*) AS count
      FROM tournament_match_no_show_replacements
      WHERE tournament_id = ? AND status IN ('active', 'takeover_pending')
      GROUP BY match_id, assigned_seat
      HAVING COUNT(*) > 1;
    `).all(tournamentId)
    if (replacementsConflict.length > 0) {
      addIssue(issues, 'replacement_state_conflict', 'error', 'Conflicting no-show replacements were found.', false)
    }

    if (tournament.status === 'finished' && tournament.settlement_state !== 'settled') {
      addIssue(issues, 'finished_without_settlement', 'error', 'Finished tournament is not settled.', false)
    }
    if (tournament.status !== 'finished' && tournament.settlement_state === 'settled') {
      addIssue(issues, 'settled_without_finished', 'error', 'Tournament is settled before finished state.', false)
    }
    if (tournament.status === 'finished' && tournament.finished_at === null) {
      addIssue(issues, 'finished_timestamp_missing', 'error', 'Finished tournament is missing finished_at.', false)
    }

    const prize = ledgerCountSumStatement.get(tournamentId, 'prize_payout') as { count: number; sum: number }
    if (tournament.settlement_state === 'settled') {
      if (prize.count !== 4) {
        addIssue(issues, 'incomplete_prize_payouts', 'error', 'Settled tournament must have four prize payouts.', false)
      }
      const expectedPrize =
        (tournament.winner_team_prize_amount ?? 0) + (tournament.runner_up_team_prize_amount ?? 0)
      if (expectedPrize > 0 && prize.sum !== expectedPrize) {
        addIssue(issues, 'conflicting_prize_payout', 'error', 'Prize payout sum does not match financial snapshot.', false)
      }
      if (tournament.champion_team_id === null || !teamIds.has(tournament.champion_team_id)) {
        addIssue(issues, 'invalid_champion', 'error', 'Champion team is invalid.', false)
      }
      if (tournament.runner_up_team_id === null || !teamIds.has(tournament.runner_up_team_id)) {
        addIssue(issues, 'invalid_runner_up', 'error', 'Runner-up team is invalid.', false)
      }
    }

    const systemFee = ledgerCountSumStatement.get(tournamentId, 'system_fee') as { count: number; sum: number }
    if (tournament.status !== 'open' && !TERMINAL_STATUSES.includes(tournament.status) && systemFee.count === 0) {
      addIssue(issues, 'missing_system_fee_ledger', 'error', 'Started tournament is missing system fee ledger.', false)
    }
    if (systemFee.count > 1 || (systemFee.count === 1 && tournament.system_fee_amount !== null && systemFee.sum !== tournament.system_fee_amount)) {
      addIssue(issues, 'conflicting_system_fee_ledger', 'error', 'System fee ledger does not match snapshot.', false)
    }

    if ((tournament.status === 'cancelled' || tournament.status === 'admin_cancelled') && prize.count > 0) {
      addIssue(issues, 'unexpected_wallet_related_ledger', 'error', 'Cancelled tournament has prize payouts.', false)
    }

    // Fill-mode 1-час expiry (виж migration 20260731_001) — read-only checks,
    // без нов write path. cancel_reason е free-form TEXT (виж migration
    // 20260730_001), затова 'fill_mode_expired' се сравнява buквално, огледално
    // на FILL_MODE_EXPIRED константата в tournamentScheduler.ts.
    if (tournament.start_mode === 'fill') {
      if (tournament.status === 'open' && tournament.fill_expires_at === null) {
        addIssue(issues, 'missing_fill_expiry', 'error', 'Open fill tournament is missing fill_expires_at.', false)
      }
      if (
        tournament.fill_expires_at !== null &&
        new Date(dbDateToUtc(tournament.fill_expires_at)).getTime() <= new Date(dbDateToUtc(tournament.created_at)).getTime()
      ) {
        addIssue(issues, 'invalid_fill_expiry', 'error', 'fill_expires_at is not after created_at.', false)
      }
      if (tournament.status === 'auto_cancelled' && tournament.cancel_reason === 'fill_mode_expired') {
        // Историческа пълнота на refund-ите при cancel (различна семантика от
        // netEntryDebits по-горе, който е за CURRENT paid participation на
        // finished/active турнири) — тук нарочно е GROSS всички исторически
        // debit/refund редове, защото auto_cancel трябва да refund-не буквално
        // всеки debit, който някога е бил направен за този турнир.
        const fillTimeoutDebit = ledgerCountSumStatement.get(tournamentId, 'entry_fee_debit') as { count: number; sum: number }
        const fillTimeoutRefund = ledgerCountSumStatement.get(tournamentId, 'entry_fee_refund') as { count: number; sum: number }
        if (paidParticipantEntries.some((entry) => entry.status === 'confirmed')) {
          addIssue(issues, 'incomplete_fill_timeout_refunds', 'error', 'Fill-timeout cancelled tournament still has confirmed (unrefunded) entries.', false)
        }
        if (fillTimeoutDebit.count > 0 && fillTimeoutDebit.count !== fillTimeoutRefund.count) {
          addIssue(issues, 'incomplete_fill_timeout_refunds', 'error', 'Fill-timeout cancelled tournament has fewer refunds than debits.', false)
        }
        if (systemFee.count > 0) {
          addIssue(issues, 'system_fee_on_fill_timeout_cancel', 'error', 'Fill-timeout cancelled tournament has a system fee ledger entry.', false)
        }
      }
      if (
        tournament.cancel_reason === 'fill_mode_expired' &&
        !['open', 'auto_cancelled'].includes(tournament.status)
      ) {
        addIssue(issues, 'fill_timeout_after_start', 'error', 'Tournament has a fill-timeout cancellation reason but is not open/auto_cancelled.', false)
      }
    }

    return reportFromIssues(issues)
  }

  function buildSummary(tournament: TournamentRow): AdminTournamentSummary {
    const participantsCount = coerceCount(countEntriesStatement.get(tournament.tournament_id))
    const stage =
      tournament.status === 'starting' || tournament.status === 'semifinal_in_progress'
        ? 'semifinal'
        : tournament.status === 'final_in_progress'
          ? 'final'
          : tournament.status
    return {
      tournamentId: tournament.tournament_id,
      name: tournament.name,
      creator: profileDto(tournament.creator_profile_id, deps.getPublicProfile),
      visibility: tournament.visibility,
      entryFee: tournament.entry_fee,
      participantsCount,
      currentStage: stage,
      status: tournament.status,
      settlementState: tournament.settlement_state,
      createdAt: asUtc(tournament.created_at) ?? tournament.created_at,
      scheduledStartAt: asUtc(tournament.scheduled_start_at),
      fillExpiresAt: asUtc(tournament.fill_expires_at),
      finishedAt: asUtc(tournament.finished_at),
      integrity: analyzeTournamentIntegrity(tournament.tournament_id),
    }
  }

  function listAdminTournaments(filter: AdminTournamentListFilter): { rows: AdminTournamentSummary[]; totalCount: number } {
    const limit = Math.max(1, Math.min(100, Math.trunc(filter.limit)))
    const page = Math.max(1, Math.trunc(filter.page))
    const offset = (page - 1) * limit
    const { where, params } = buildWhere(filter)
    const usesIntegrityFilter = filter.integrityState !== null && filter.integrityState !== undefined
    const fetchLimit = usesIntegrityFilter ? 500 : limit
    const fetchOffset = usesIntegrityFilter ? 0 : offset

    const rows = database.prepare(`
      SELECT ${tournamentColumns}
      FROM tournaments t
      ${where}
      ORDER BY
        CASE WHEN t.status IN ('open', 'starting', 'semifinal_in_progress', 'final_in_progress') THEN 0 ELSE 1 END ASC,
        COALESCE(t.finished_at, t.created_at) DESC
      LIMIT ? OFFSET ?;
    `).all(...params, fetchLimit, fetchOffset) as TournamentRow[]

    let summaries = rows.map(buildSummary)
    if (usesIntegrityFilter) {
      const filteredSummaries = summaries.filter((row) => row.integrity.state === filter.integrityState)
      return {
        rows: filteredSummaries.slice(offset, offset + limit),
        totalCount: filteredSummaries.length,
      }
    }

    const totalRow = database.prepare(`
      SELECT COUNT(*) AS count
      FROM tournaments t
      ${where};
    `).get(...params)

    return { rows: summaries, totalCount: coerceCount(totalRow) }
  }

  function getAdminTournamentDetail(tournamentId: TournamentId, eventPage: number, eventLimit: number): AdminTournamentDetail | null {
    const tournament = getTournamentStatement.get(tournamentId) as TournamentRow | undefined
    if (tournament === undefined) return null

    const summary = buildSummary(tournament)
    const debit = ledgerCountSumStatement.get(tournamentId, 'entry_fee_debit') as { count: number; sum: number }
    const refund = ledgerCountSumStatement.get(tournamentId, 'entry_fee_refund') as { count: number; sum: number }
    const systemFee = ledgerCountSumStatement.get(tournamentId, 'system_fee') as { count: number; sum: number }
    const prize = ledgerCountSumStatement.get(tournamentId, 'prize_payout') as { count: number; sum: number }

    const paidProfiles = new Set((database.prepare(`
      SELECT profile_id
      FROM tournament_economy_ledger
      WHERE tournament_id = ? AND entry_type = 'entry_fee_debit' AND profile_id IS NOT NULL;
    `).all(tournamentId) as Array<{ profile_id: string }>).map((row) => row.profile_id))

    const entries = database.prepare(`
      SELECT profile_id, team_id, joined_as, status
      FROM tournament_entries
      WHERE tournament_id = ?
      ORDER BY created_at ASC;
    `).all(tournamentId) as Array<{ profile_id: string; team_id: string | null; joined_as: string; status: string }>
    const teams = (database.prepare(`
      SELECT team_id, status, seed_slot
      FROM tournament_teams
      WHERE tournament_id = ?
      ORDER BY COALESCE(seed_slot, 99), created_at ASC;
    `).all(tournamentId) as Array<{ team_id: string; status: string; seed_slot: number | null }>).map((team) => ({
      teamId: team.team_id,
      seedSlot: team.seed_slot,
      status: team.status,
      members: entries
        .filter((entry) => entry.team_id === team.team_id)
        .map((entry) => ({
          ...profileDto(entry.profile_id, deps.getPublicProfile),
          joinedAs: entry.joined_as,
          entryStatus: entry.status,
          paidEntry: paidProfiles.has(entry.profile_id),
        })),
    }))

    const bracket = (database.prepare(`
      SELECT tm.match_id, tr.round_type, tr.round_index, tm.room_id, tm.team_a_id, tm.team_b_id,
             tm.status, tm.result_kind, tm.winner_team_id, tm.attendance_resolution_kind,
             COUNT(r.replacement_id) AS replacement_count,
             SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS takeover_count,
             s.room_id AS snapshot_room_id
      FROM tournament_matches tm
      JOIN tournament_rounds tr ON tr.round_id = tm.round_id
      LEFT JOIN tournament_match_no_show_replacements r ON r.match_id = tm.match_id
      LEFT JOIN active_room_snapshots s ON s.room_id = tm.room_id
      WHERE tm.tournament_id = ?
      GROUP BY tm.match_id
      ORDER BY tr.round_type ASC, tr.round_index ASC, tm.created_at ASC;
    `).all(tournamentId) as Array<{
      match_id: string
      round_type: 'semifinal' | 'final'
      round_index: number
      room_id: string | null
      team_a_id: string
      team_b_id: string
      status: string
      result_kind: string | null
      winner_team_id: string | null
      attendance_resolution_kind: string | null
      replacement_count: number
      takeover_count: number | null
      snapshot_room_id: string | null
    }>).map((match) => ({
      matchId: match.match_id,
      roundType: match.round_type,
      roundIndex: match.round_index,
      teamAId: match.team_a_id,
      teamBId: match.team_b_id,
      status: match.status,
      roomReady: match.room_id !== null && match.snapshot_room_id !== null,
      resultKind: match.result_kind,
      winnerTeamId: match.winner_team_id,
      loserTeamId: match.winner_team_id === null ? null : match.winner_team_id === match.team_a_id ? match.team_b_id : match.team_a_id,
      played: match.result_kind === 'played',
      playedWithBots: match.result_kind === 'played_with_bots',
      walkover: match.result_kind === 'walkover',
      attendanceResolution: match.attendance_resolution_kind,
      replacementCount: Number(match.replacement_count ?? 0),
      takeoverCount: Number(match.takeover_count ?? 0),
      roomSnapshotRecoverable: match.room_id !== null && match.snapshot_room_id !== null,
    }))

    const limit = Math.max(1, Math.min(100, Math.trunc(eventLimit)))
    const page = Math.max(1, Math.trunc(eventPage))
    const events = listEventsStatement.all(tournamentId, limit, (page - 1) * limit) as Array<{
      event_type: string
      payload_json: string | null
      created_at: string
    }>

    const canCancelOpen = tournament.status === 'open' && bracket.length === 0 && systemFee.count === 0 && prize.count === 0 && tournament.settlement_state === 'pending'

    return {
      ...summary,
      startedAt: asUtc(tournament.started_at),
      rulesVersion: tournament.financial_rules_version,
      teams,
      bracket,
      finance: {
        totalEntry: tournament.total_entry_amount,
        systemFee: tournament.system_fee_amount,
        prizePool: tournament.prize_pool_amount,
        winnerTeamPrize: tournament.winner_team_prize_amount,
        winnerPlayerPrize: tournament.winner_player_prize_amount,
        runnerUpTeamPrize: tournament.runner_up_team_prize_amount,
        runnerUpPlayerPrize: tournament.runner_up_player_prize_amount,
        entryDebitCount: debit.count,
        entryDebitSum: debit.sum,
        refundCount: refund.count,
        refundSum: refund.sum,
        systemFeeLedgerPresent: systemFee.count > 0,
        prizePayoutCount: prize.count,
        prizePayoutSum: prize.sum,
        settlementIntegrity: summary.integrity.state,
      },
      events: {
        page,
        limit,
        totalCount: coerceCount(countEventsStatement.get(tournamentId)),
        rows: events.map((event) => ({
          eventType: event.event_type,
          summary: safeEventSummary(event.payload_json),
          createdAt: asUtc(event.created_at) ?? event.created_at,
        })),
      },
      operations: {
        coordinatorState: deps.getCoordinatorHealth?.()?.state ?? null,
        schedulerState: deps.getSchedulerHealth?.()?.state ?? null,
        roomAssignmentsRecoverable: bracket.every((match) => match.roomSnapshotRecoverable || match.status === 'completed'),
      },
      actions: {
        canReconcile: summary.integrity.state !== 'error',
        canCancelOpen,
        cancelRefundTotal: debit.sum - refund.sum,
      },
    }
  }

  function getHealthSnapshot() {
    const activeTournamentCount = coerceCount(database.prepare(`
      SELECT COUNT(*) AS count FROM tournaments
      WHERE status IN ('open', 'starting', 'semifinal_in_progress', 'final_in_progress');
    `).get())
    const pendingSettlementCount = coerceCount(database.prepare(`
      SELECT COUNT(*) AS count FROM tournaments
      WHERE status = 'final_in_progress' AND settlement_state = 'pending';
    `).get())
    const sample = (database.prepare(`
      SELECT tournament_id FROM tournaments
      WHERE status IN ('starting', 'semifinal_in_progress', 'final_in_progress', 'finished')
      ORDER BY updated_at DESC
      LIMIT 100;
    `).all() as Array<{ tournament_id: string }>).map((row) => analyzeTournamentIntegrity(row.tournament_id))
    return {
      activeTournamentCount,
      pendingSettlementCount,
      integrityErrorCount: sample.filter((report) => report.state === 'error').length,
      recoverableWarningCount: sample.flatMap((report) => report.issues).filter((issue) => issue.recoverable).length,
      lastSuccessfulReconciliation: deps.getCoordinatorHealth?.()?.lastSuccessAt ?? deps.getSchedulerHealth?.()?.lastSuccessAt ?? null,
      lastFailedReconciliationCode: deps.getCoordinatorHealth?.()?.lastError !== null && deps.getCoordinatorHealth?.()?.lastError !== undefined
        ? 'coordinator_error'
        : null,
    }
  }

  function reconcileTournament(tournamentId: TournamentId, actorProfileId: string | null): AdminReconcileResult {
    const tournament = getTournamentStatement.get(tournamentId) as TournamentRow | undefined
    if (tournament === undefined) return { ok: false, status: 'not_found' }
    const before = analyzeTournamentIntegrity(tournamentId)
    if (before.state === 'error') {
      insertEventStatement.run(randomUUID(), tournamentId, 'admin_tournament_reconcile_blocked', actorProfileId, JSON.stringify({ integrityState: before.state }))
      return { ok: false, status: 'blocked_by_integrity_error' }
    }
    const coordinatorBefore = deps.getCoordinatorHealth?.()?.lastSuccessAt ?? null
    deps.runCoordinatorTick?.()
    const after = analyzeTournamentIntegrity(tournamentId)
    const coordinatorAfter = deps.getCoordinatorHealth?.()?.lastSuccessAt ?? null
    const status = before.state === 'healthy' && after.state === 'healthy' && coordinatorBefore === coordinatorAfter
      ? 'already_consistent'
      : after.state === 'error'
        ? 'no_safe_action'
        : 'accepted'
    insertEventStatement.run(randomUUID(), tournamentId, 'admin_tournament_reconcile', actorProfileId, JSON.stringify({ result: status }))
    return { ok: true, status }
  }

  function cancelOpenTournament(tournamentId: TournamentId, actorProfileId: string | null): AdminCancelOpenResult {
    const tournament = getTournamentStatement.get(tournamentId) as TournamentRow | undefined
    if (tournament === undefined) return { ok: false, reason: 'not_found' }
    if (tournament.status === 'admin_cancelled') return { ok: true, alreadyCancelled: true, refundedEntries: 0, totalRefunded: 0 }
    if (tournament.status !== 'open') return { ok: false, reason: 'not_open' }
    if (analyzeTournamentIntegrity(tournamentId).state === 'error') return { ok: false, reason: 'integrity_error' }

    const unsafeRows = coerceCount(database.prepare(`
      SELECT COUNT(*) AS count
      FROM tournament_matches
      WHERE tournament_id = ? AND room_id IS NOT NULL;
    `).get(tournamentId))
    const systemFee = ledgerCountSumStatement.get(tournamentId, 'system_fee') as { count: number; sum: number }
    const prize = ledgerCountSumStatement.get(tournamentId, 'prize_payout') as { count: number; sum: number }
    if (unsafeRows > 0 || systemFee.count > 0 || prize.count > 0 || tournament.settlement_state !== 'pending') {
      return { ok: false, reason: 'unsafe_state' }
    }

    let refundedEntries = 0
    let totalRefunded = 0

    database.exec('BEGIN IMMEDIATE;')
    try {
      const fresh = getTournamentStatement.get(tournamentId) as TournamentRow | undefined
      if (fresh === undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'not_found' }
      }
      if (fresh.status !== 'open') {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'not_open' }
      }
      if (analyzeTournamentIntegrity(tournamentId).state === 'error') {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'integrity_error' }
      }
      const freshUnsafeRows = coerceCount(database.prepare(`
        SELECT COUNT(*) AS count
        FROM tournament_matches
        WHERE tournament_id = ? AND room_id IS NOT NULL;
      `).get(tournamentId))
      const freshSystemFee = ledgerCountSumStatement.get(tournamentId, 'system_fee') as { count: number; sum: number }
      const freshPrize = ledgerCountSumStatement.get(tournamentId, 'prize_payout') as { count: number; sum: number }
      if (freshUnsafeRows > 0 || freshSystemFee.count > 0 || freshPrize.count > 0 || fresh.settlement_state !== 'pending') {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'unsafe_state' }
      }

      database.prepare(`
        UPDATE tournament_partner_invites
        SET status = 'cancelled', responded_at = COALESCE(responded_at, CURRENT_TIMESTAMP)
        WHERE tournament_id = ? AND status = 'pending';
      `).run(tournamentId)

      const entries = database.prepare(`
        SELECT entry_id, profile_id
        FROM tournament_entries
        WHERE tournament_id = ? AND status = 'confirmed';
      `).all(tournamentId) as Array<{ entry_id: string; profile_id: string }>

      for (const entry of entries) {
        const refundKey = `tournament:${tournamentId}:profile:${entry.profile_id}:entry-fee-refund`
        const existingRefund = database.prepare(`
          SELECT amount FROM tournament_economy_ledger
          WHERE idempotency_key = ?
          LIMIT 1;
        `).get(refundKey) as { amount: number } | undefined
        if (existingRefund !== undefined) continue

        const debit = database.prepare(`
          SELECT amount FROM tournament_economy_ledger
          WHERE idempotency_key = ?
          LIMIT 1;
        `).get(`tournament:${tournamentId}:profile:${entry.profile_id}:entry-fee-debit`) as { amount: number } | undefined
        const refundAmount = debit?.amount ?? fresh.entry_fee

        database.prepare(`
          INSERT OR IGNORE INTO profile_wallets (profile_id, yellow_coins_balance)
          VALUES (?, 0);
        `).run(entry.profile_id)
        database.prepare(`
          UPDATE profile_wallets
          SET yellow_coins_balance = yellow_coins_balance + ?, updated_at = CURRENT_TIMESTAMP
          WHERE profile_id = ?;
        `).run(refundAmount, entry.profile_id)
        const balance = (database.prepare(`
          SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ? LIMIT 1;
        `).get(entry.profile_id) as { yellow_coins_balance: number }).yellow_coins_balance
        database.prepare(`
          INSERT INTO tournament_economy_ledger (
            ledger_id, idempotency_key, tournament_id, profile_id, entry_type, amount, balance_after
          ) VALUES (?, ?, ?, ?, 'entry_fee_refund', ?, ?);
        `).run(randomUUID(), refundKey, tournamentId, entry.profile_id, refundAmount, balance)
        database.prepare(`
          UPDATE tournament_entries
          SET status = 'refunded', refunded_at = COALESCE(refunded_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
          WHERE entry_id = ? AND status = 'confirmed';
        `).run(entry.entry_id)
        refundedEntries += 1
        totalRefunded += refundAmount
      }

      database.prepare(`
        UPDATE tournaments
        SET status = 'admin_cancelled',
            cancel_reason = 'Admin cancel-open action.',
            updated_at = CURRENT_TIMESTAMP
        WHERE tournament_id = ? AND status = 'open';
      `).run(tournamentId)
      insertEventStatement.run(randomUUID(), tournamentId, 'admin_tournament_cancel_open', actorProfileId, JSON.stringify({ refundedEntries, totalRefunded }))
      database.exec('COMMIT;')
      return { ok: true, alreadyCancelled: false, refundedEntries, totalRefunded }
    } catch (error) {
      try { database.exec('ROLLBACK;') } catch {}
      throw error
    }
  }

  return {
    listAdminTournaments,
    getAdminTournamentDetail,
    analyzeTournamentIntegrity,
    getHealthSnapshot,
    reconcileTournament,
    cancelOpenTournament,
    close(): void {
      database.close()
    },
  }
}
