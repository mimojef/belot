import { randomUUID } from 'node:crypto'
import type { ProfileId } from '../core/serverTypes.js'
import { dbDateToUtc } from './dbDate.js'
import type {
  TournamentEntryJoinedAs,
  TournamentEntryRecord,
  TournamentEntryStatus,
  TournamentEventRecord,
  TournamentId,
  TournamentKind,
  TournamentMatchRecord,
  TournamentMatchResultKind,
  TournamentMatchStatus,
  TournamentPartnerInviteId,
  TournamentPartnerInviteRecord,
  TournamentPartnerInviteStatus,
  TournamentRecord,
  TournamentRoundId,
  TournamentRoundRecord,
  TournamentRoundType,
  TournamentStartMode,
  TournamentStatus,
  TournamentTeamId,
  TournamentTeamRecord,
  TournamentTeamStatus,
  TournamentVisibility,
} from '../tournament/tournamentTypes.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type CreateTournamentInput = {
  kind?: TournamentKind
  name: string
  creatorProfileId: ProfileId
  visibility: TournamentVisibility
  passwordHash?: string | null
  entryFee: number
  playerCapacity?: number
  startMode: TournamentStartMode
  scheduledStartAt?: string | null
}

export type ListTournamentsFilter = {
  statuses?: TournamentStatus[]
  creatorProfileId?: ProfileId
  limit?: number
  offset?: number
  orderBy?: 'created_desc' | 'finished_desc'
}

export type CreateTournamentResult =
  | { ok: true; tournament: TournamentRecord }
  | { ok: false; reason: 'active_tournament_limit' }

// Единствената допустима мутация извън join/team/economy flow-овете —
// creator-ът редактира САМО scheduled_start_at на 'scheduled' турнир, докато
// е още 'open' (§ "EDIT SCHEDULED START" в task spec-а). Никакви entries/
// teams/economy редове не се пипат тук — затова живее в tournamentStore.ts
// (plain CRUD), не в tournamentEconomyStore.ts.
export type UpdateScheduledStartAtResult =
  | { ok: true; tournament: TournamentRecord }
  | {
      ok: false
      reason: 'tournament_not_found' | 'not_creator' | 'tournament_not_open' | 'not_scheduled_mode'
    }

export type CreateTournamentTeamInput = {
  tournamentId: TournamentId
  status?: TournamentTeamStatus
  seedSlot?: number | null
}

export type CreateTournamentEntryInput = {
  tournamentId: TournamentId
  profileId: ProfileId
  teamId?: TournamentTeamId | null
  joinedAs: TournamentEntryJoinedAs
  status?: TournamentEntryStatus
}

export type CreatePartnerInviteInput = {
  tournamentId: TournamentId
  teamId: TournamentTeamId
  inviterProfileId: ProfileId
  inviteeProfileId: ProfileId
  expiresAt: string
}

export type CreateTournamentRoundInput = {
  tournamentId: TournamentId
  roundType: TournamentRoundType
  roundIndex: number
}

export type CreateTournamentMatchInput = {
  tournamentId: TournamentId
  roundId: TournamentRoundId
  teamAId: TournamentTeamId
  teamBId: TournamentTeamId
  roomId?: string | null
  noShowDeadlineAt?: string | null
}

export type AppendTournamentEventInput = {
  tournamentId: TournamentId
  eventType: string
  actorProfileId?: ProfileId | null
  actorRole?: 'player' | 'admin' | 'system' | null
  payload?: Record<string, unknown> | null
}

export type TournamentStore = {
  createTournament: (input: CreateTournamentInput) => CreateTournamentResult
  getTournamentById: (tournamentId: TournamentId) => TournamentRecord | null
  listTournaments: (filter?: ListTournamentsFilter) => TournamentRecord[]
  countTournaments: (filter?: Pick<ListTournamentsFilter, 'statuses' | 'creatorProfileId'>) => number
  updateTournamentStatus: (
    tournamentId: TournamentId,
    expectedStatus: TournamentStatus,
    nextStatus: TournamentStatus,
  ) => boolean
  updateScheduledStartAt: (
    tournamentId: TournamentId,
    requesterProfileId: ProfileId,
    newScheduledStartAtIso: string,
  ) => UpdateScheduledStartAtResult

  createTeam: (input: CreateTournamentTeamInput) => TournamentTeamRecord
  getTeamsForTournament: (tournamentId: TournamentId) => TournamentTeamRecord[]

  createEntry: (input: CreateTournamentEntryInput) => TournamentEntryRecord
  getEntriesForTournament: (tournamentId: TournamentId) => TournamentEntryRecord[]

  createPartnerInvite: (input: CreatePartnerInviteInput) => TournamentPartnerInviteRecord
  getPartnerInviteById: (
    inviteId: TournamentPartnerInviteId,
  ) => TournamentPartnerInviteRecord | null
  listPendingInvitesForProfile: (
    inviteeProfileId: ProfileId,
  ) => TournamentPartnerInviteRecord[]
  dismissInvitePopup: (inviteId: TournamentPartnerInviteId) => boolean
  markInviteNotificationRead: (inviteId: TournamentPartnerInviteId) => boolean

  createRound: (input: CreateTournamentRoundInput) => TournamentRoundRecord
  getRoundsForTournament: (tournamentId: TournamentId) => TournamentRoundRecord[]
  createTournamentMatch: (input: CreateTournamentMatchInput) => TournamentMatchRecord
  getMatchesForTournament: (tournamentId: TournamentId) => TournamentMatchRecord[]
  hasSemifinalResultAcknowledgement: (
    tournamentId: TournamentId,
    semifinalMatchId: string,
    profileId: ProfileId,
  ) => boolean
  countMissingHumanFinalistAcknowledgements: (
    tournamentId: TournamentId,
    teamAId: TournamentTeamId,
    teamBId: TournamentTeamId,
  ) => number

  appendTournamentEvent: (input: AppendTournamentEventInput) => TournamentEventRecord

  close: () => void
}

type TournamentRow = {
  tournament_id: string
  kind: string
  name: string
  creator_profile_id: string
  visibility: string
  password_hash: string | null
  entry_fee: number
  player_capacity: number
  start_mode: string
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
  settlement_state: string
  settled_at: string | null
  total_entry_amount: number | null
  system_fee_percent: number | null
  system_fee_amount: number | null
  prize_pool_amount: number | null
  winner_share_percent: number | null
  runner_up_share_percent: number | null
  winner_team_prize_amount: number | null
  runner_up_team_prize_amount: number | null
  winner_player_prize_amount: number | null
  runner_up_player_prize_amount: number | null
  financial_rules_version: string | null
}

type TournamentTeamRow = {
  team_id: string
  tournament_id: string
  status: string
  seed_slot: number | null
  created_at: string
  updated_at: string
}

type TournamentEntryRow = {
  entry_id: string
  tournament_id: string
  profile_id: string
  team_id: string | null
  joined_as: string
  status: string
  created_at: string
  updated_at: string
  withdrawn_at: string | null
  refunded_at: string | null
}

type TournamentPartnerInviteRow = {
  invite_id: string
  tournament_id: string
  team_id: string
  inviter_profile_id: string
  invitee_profile_id: string
  status: string
  expires_at: string
  popup_dismissed_at: string | null
  notification_read_at: string | null
  created_at: string
  responded_at: string | null
}

type TournamentRoundRow = {
  round_id: string
  tournament_id: string
  round_type: string
  round_index: number
  created_at: string
}

type TournamentMatchRow = {
  match_id: string
  tournament_id: string
  round_id: string
  room_id: string | null
  team_a_id: string
  team_b_id: string
  status: string
  no_show_deadline_at: string | null
  attendance_started_at: string | null
  attendance_deadline_at: string | null
  attendance_resolved_at: string | null
  attendance_resolution_kind: string | null
  deadline_kind: string | null
  game_start_at: string | null
  attendance_revision: number
  winner_team_id: string | null
  result_kind: string | null
  walkover_reason: string | null
  missing_profile_ids: string | null
  final_score_team_a: number | null
  final_score_team_b: number | null
  final_start_at: string | null
  next_match_start_at: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

type TournamentEventRow = {
  event_id: string
  tournament_id: string
  event_type: string
  actor_profile_id: string | null
  actor_role: string | null
  payload_json: string | null
  created_at: string
}

function toTournamentRecord(row: TournamentRow): TournamentRecord {
  return {
    tournamentId: row.tournament_id,
    kind: row.kind as TournamentRecord['kind'],
    name: row.name,
    creatorProfileId: row.creator_profile_id,
    visibility: row.visibility as TournamentVisibility,
    passwordHash: row.password_hash,
    entryFee: row.entry_fee,
    playerCapacity: row.player_capacity,
    startMode: row.start_mode as TournamentStartMode,
    scheduledStartAt: row.scheduled_start_at !== null ? dbDateToUtc(row.scheduled_start_at) : null,
    fillExpiresAt: row.fill_expires_at !== null ? dbDateToUtc(row.fill_expires_at) : null,
    status: row.status as TournamentStatus,
    cancelReason: row.cancel_reason,
    createdAt: dbDateToUtc(row.created_at),
    updatedAt: dbDateToUtc(row.updated_at),
    startedAt: row.started_at !== null ? dbDateToUtc(row.started_at) : null,
    finishedAt: row.finished_at !== null ? dbDateToUtc(row.finished_at) : null,
    championTeamId: row.champion_team_id,
    runnerUpTeamId: row.runner_up_team_id,
    settlementState: row.settlement_state as TournamentRecord['settlementState'],
    settledAt: row.settled_at !== null ? dbDateToUtc(row.settled_at) : null,
    totalEntryAmount: row.total_entry_amount,
    systemFeePercent: row.system_fee_percent,
    systemFeeAmount: row.system_fee_amount,
    prizePoolAmount: row.prize_pool_amount,
    winnerSharePercent: row.winner_share_percent,
    runnerUpSharePercent: row.runner_up_share_percent,
    winnerTeamPrizeAmount: row.winner_team_prize_amount,
    runnerUpTeamPrizeAmount: row.runner_up_team_prize_amount,
    winnerPlayerPrizeAmount: row.winner_player_prize_amount,
    runnerUpPlayerPrizeAmount: row.runner_up_player_prize_amount,
    financialRulesVersion: row.financial_rules_version,
  }
}

function toTournamentTeamRecord(row: TournamentTeamRow): TournamentTeamRecord {
  return {
    teamId: row.team_id,
    tournamentId: row.tournament_id,
    status: row.status as TournamentTeamStatus,
    seedSlot: row.seed_slot,
    createdAt: dbDateToUtc(row.created_at),
    updatedAt: dbDateToUtc(row.updated_at),
  }
}

function toTournamentEntryRecord(row: TournamentEntryRow): TournamentEntryRecord {
  return {
    entryId: row.entry_id,
    tournamentId: row.tournament_id,
    profileId: row.profile_id,
    teamId: row.team_id,
    joinedAs: row.joined_as as TournamentEntryJoinedAs,
    status: row.status as TournamentEntryStatus,
    createdAt: dbDateToUtc(row.created_at),
    updatedAt: dbDateToUtc(row.updated_at),
    withdrawnAt: row.withdrawn_at !== null ? dbDateToUtc(row.withdrawn_at) : null,
    refundedAt: row.refunded_at !== null ? dbDateToUtc(row.refunded_at) : null,
  }
}

function toTournamentPartnerInviteRecord(
  row: TournamentPartnerInviteRow,
): TournamentPartnerInviteRecord {
  return {
    inviteId: row.invite_id,
    tournamentId: row.tournament_id,
    teamId: row.team_id,
    inviterProfileId: row.inviter_profile_id,
    inviteeProfileId: row.invitee_profile_id,
    status: row.status as TournamentPartnerInviteStatus,
    expiresAt: dbDateToUtc(row.expires_at),
    popupDismissedAt: row.popup_dismissed_at !== null ? dbDateToUtc(row.popup_dismissed_at) : null,
    notificationReadAt:
      row.notification_read_at !== null ? dbDateToUtc(row.notification_read_at) : null,
    createdAt: dbDateToUtc(row.created_at),
    respondedAt: row.responded_at !== null ? dbDateToUtc(row.responded_at) : null,
  }
}

function toTournamentRoundRecord(row: TournamentRoundRow): TournamentRoundRecord {
  return {
    roundId: row.round_id,
    tournamentId: row.tournament_id,
    roundType: row.round_type as TournamentRoundType,
    roundIndex: row.round_index,
    createdAt: dbDateToUtc(row.created_at),
  }
}

function toTournamentMatchRecord(row: TournamentMatchRow): TournamentMatchRecord {
  return {
    matchId: row.match_id,
    tournamentId: row.tournament_id,
    roundId: row.round_id,
    roomId: row.room_id,
    teamAId: row.team_a_id,
    teamBId: row.team_b_id,
    status: row.status as TournamentMatchStatus,
    noShowDeadlineAt: row.no_show_deadline_at !== null ? dbDateToUtc(row.no_show_deadline_at) : null,
    attendanceStartedAt: row.attendance_started_at !== null ? dbDateToUtc(row.attendance_started_at) : null,
    attendanceDeadlineAt: row.attendance_deadline_at !== null ? dbDateToUtc(row.attendance_deadline_at) : null,
    attendanceResolvedAt: row.attendance_resolved_at !== null ? dbDateToUtc(row.attendance_resolved_at) : null,
    attendanceResolutionKind: row.attendance_resolution_kind as TournamentMatchRecord['attendanceResolutionKind'],
    deadlineKind: row.deadline_kind as TournamentMatchRecord['deadlineKind'],
    gameStartAt: row.game_start_at !== null ? dbDateToUtc(row.game_start_at) : null,
    attendanceRevision: row.attendance_revision,
    winnerTeamId: row.winner_team_id,
    resultKind: row.result_kind as TournamentMatchResultKind | null,
    walkoverReason: row.walkover_reason,
    missingProfileIds: row.missing_profile_ids !== null
      ? (JSON.parse(row.missing_profile_ids) as string[])
      : null,
    finalScoreTeamA: row.final_score_team_a,
    finalScoreTeamB: row.final_score_team_b,
    finalStartAt: row.final_start_at !== null ? dbDateToUtc(row.final_start_at) : null,
    nextMatchStartAt: row.next_match_start_at !== null ? dbDateToUtc(row.next_match_start_at) : null,
    createdAt: dbDateToUtc(row.created_at),
    startedAt: row.started_at !== null ? dbDateToUtc(row.started_at) : null,
    completedAt: row.completed_at !== null ? dbDateToUtc(row.completed_at) : null,
  }
}

function toTournamentEventRecord(row: TournamentEventRow): TournamentEventRecord {
  return {
    eventId: row.event_id,
    tournamentId: row.tournament_id,
    eventType: row.event_type,
    actorProfileId: row.actor_profile_id,
    actorRole: row.actor_role as TournamentEventRecord['actorRole'],
    payload: row.payload_json !== null ? (JSON.parse(row.payload_json) as Record<string, unknown>) : null,
    createdAt: dbDateToUtc(row.created_at),
  }
}

export async function createTournamentStore(databaseFilePath: string): Promise<TournamentStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')

  // fill_expires_at се изчислява от DB-та (не от app clock) спрямо
  // start_mode: fill → created_at (DEFAULT CURRENT_TIMESTAMP) + 1 час,
  // scheduled → NULL. Клиентът никога не подава/влияе тази стойност —
  // няма съответно поле в CreateTournamentInput. Фиксирано на точно 60
  // минути, не избираемо.
  const insertTournamentStatement = database.prepare(`
    INSERT INTO tournaments (
      tournament_id,
      kind,
      name,
      creator_profile_id,
      visibility,
      password_hash,
      entry_fee,
      player_capacity,
      start_mode,
      scheduled_start_at,
      fill_expires_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      CASE WHEN ? = 'fill' THEN datetime(CURRENT_TIMESTAMP, '+1 hours') ELSE NULL END
    );
  `)

  const selectTournamentByIdStatement = database.prepare(`
    SELECT
      tournament_id, kind, name, creator_profile_id, visibility, password_hash,
      entry_fee, player_capacity, start_mode, scheduled_start_at, fill_expires_at, status,
      cancel_reason, created_at, updated_at, started_at, finished_at,
      champion_team_id, runner_up_team_id, settlement_state, settled_at,
      total_entry_amount, system_fee_percent, system_fee_amount, prize_pool_amount,
      winner_share_percent, runner_up_share_percent, winner_team_prize_amount,
      runner_up_team_prize_amount, winner_player_prize_amount,
      runner_up_player_prize_amount, financial_rules_version
    FROM tournaments
    WHERE tournament_id = ?
    LIMIT 1;
  `)

  const updateTournamentStatusStatement = database.prepare(`
    UPDATE tournaments
    SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE tournament_id = ? AND status = ?;
  `)

  // Единственият field, който тази операция някога пипа. WHERE клаузата
  // преповтаря ЦЯЛАТА authorization/state guard (creator + scheduled mode +
  // still open) directly в самия UPDATE — TOCTOU-safe: дори ако състоянието
  // се е сменило между pre-check четенето в updateScheduledStartAt по-долу и
  // тук, guard-ът пак важи. Единично UPDATE stmt в SQLite вече е atomic —
  // няма нужда от explicit BEGIN/COMMIT за single-table single-field промяна
  // без economy/team/entry странични ефекти.
  const updateScheduledStartAtStatement = database.prepare(`
    UPDATE tournaments
    SET scheduled_start_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE tournament_id = ? AND creator_profile_id = ? AND start_mode = 'scheduled' AND status = 'open';
  `)

  const insertTeamStatement = database.prepare(`
    INSERT INTO tournament_teams (
      team_id, tournament_id, status, seed_slot
    ) VALUES (?, ?, ?, ?);
  `)

  const selectTeamsForTournamentStatement = database.prepare(`
    SELECT team_id, tournament_id, status, seed_slot, created_at, updated_at
    FROM tournament_teams
    WHERE tournament_id = ?
    ORDER BY created_at ASC, team_id ASC;
  `)

  const insertEntryStatement = database.prepare(`
    INSERT INTO tournament_entries (
      entry_id, tournament_id, profile_id, team_id, joined_as, status
    ) VALUES (?, ?, ?, ?, ?, ?);
  `)

  const selectEntriesForTournamentStatement = database.prepare(`
    SELECT
      entry_id, tournament_id, profile_id, team_id, joined_as, status,
      created_at, updated_at, withdrawn_at, refunded_at
    FROM tournament_entries
    WHERE tournament_id = ?
    ORDER BY created_at ASC;
  `)

  const insertPartnerInviteStatement = database.prepare(`
    INSERT INTO tournament_partner_invites (
      invite_id, tournament_id, team_id, inviter_profile_id, invitee_profile_id,
      expires_at
    ) VALUES (?, ?, ?, ?, ?, ?);
  `)

  const selectPartnerInviteByIdStatement = database.prepare(`
    SELECT
      invite_id, tournament_id, team_id, inviter_profile_id, invitee_profile_id,
      status, expires_at, popup_dismissed_at, notification_read_at, created_at,
      responded_at
    FROM tournament_partner_invites
    WHERE invite_id = ?
    LIMIT 1;
  `)

  const selectPendingInvitesForProfileStatement = database.prepare(`
    SELECT
      invite_id, tournament_id, team_id, inviter_profile_id, invitee_profile_id,
      status, expires_at, popup_dismissed_at, notification_read_at, created_at,
      responded_at
    FROM tournament_partner_invites
    WHERE invitee_profile_id = ? AND status = 'pending'
    ORDER BY created_at DESC;
  `)

  const updatePopupDismissedStatement = database.prepare(`
    UPDATE tournament_partner_invites
    SET popup_dismissed_at = CURRENT_TIMESTAMP
    WHERE invite_id = ? AND popup_dismissed_at IS NULL;
  `)

  const updateNotificationReadStatement = database.prepare(`
    UPDATE tournament_partner_invites
    SET notification_read_at = CURRENT_TIMESTAMP
    WHERE invite_id = ? AND notification_read_at IS NULL;
  `)

  const insertRoundStatement = database.prepare(`
    INSERT INTO tournament_rounds (
      round_id, tournament_id, round_type, round_index
    ) VALUES (?, ?, ?, ?);
  `)

  const selectRoundsForTournamentStatement = database.prepare(`
    SELECT round_id, tournament_id, round_type, round_index, created_at
    FROM tournament_rounds
    WHERE tournament_id = ?
    ORDER BY round_type ASC, round_index ASC;
  `)

  const insertMatchStatement = database.prepare(`
    INSERT INTO tournament_matches (
      match_id, tournament_id, round_id, room_id, team_a_id, team_b_id,
      no_show_deadline_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?);
  `)

  const selectMatchesForTournamentStatement = database.prepare(`
    SELECT
      match_id, tournament_id, round_id, room_id, team_a_id, team_b_id, status,
      no_show_deadline_at, attendance_started_at, attendance_deadline_at,
      attendance_resolved_at, attendance_resolution_kind, deadline_kind, game_start_at,
      attendance_revision, winner_team_id, result_kind, walkover_reason,
      missing_profile_ids, final_score_team_a, final_score_team_b, final_start_at,
      next_match_start_at, created_at, started_at, completed_at
    FROM tournament_matches
    WHERE tournament_id = ?
    ORDER BY created_at ASC;
  `)

  const selectSemifinalAcknowledgementStatement = database.prepare(`
    SELECT acknowledgement_id
    FROM tournament_semifinal_result_acknowledgements
    WHERE tournament_id = ? AND semifinal_match_id = ? AND profile_id = ?
    LIMIT 1;
  `)

  const countMissingHumanFinalistAcknowledgementsStatement = database.prepare(`
    SELECT COUNT(*) AS count
    FROM tournament_entries te
    JOIN profiles p ON p.profile_id = te.profile_id
    WHERE te.tournament_id = ?
      AND te.team_id IN (?, ?)
      AND te.status = 'finalist'
      AND p.profile_kind = 'human'
      AND NOT EXISTS (
        SELECT 1
        FROM tournament_matches sm
        JOIN tournament_rounds sr ON sr.round_id = sm.round_id
        WHERE sm.tournament_id = te.tournament_id
          AND sr.round_type = 'semifinal'
          AND sm.status = 'completed'
          AND sm.winner_team_id = te.team_id
          AND EXISTS (
            SELECT 1
            FROM tournament_semifinal_result_acknowledgements ack
            WHERE ack.tournament_id = te.tournament_id
              AND ack.semifinal_match_id = sm.match_id
              AND ack.profile_id = te.profile_id
          )
      );
  `)

  const insertEventStatement = database.prepare(`
    INSERT INTO tournament_events (
      event_id, tournament_id, event_type, actor_profile_id, actor_role, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?);
  `)

  return {
    createTournament(input: CreateTournamentInput): CreateTournamentResult {
      const tournamentId = randomUUID()
      try {
        insertTournamentStatement.run(
          tournamentId,
          input.kind ?? 'community',
          input.name,
          input.creatorProfileId,
          input.visibility,
          input.passwordHash ?? null,
          input.entryFee,
          input.playerCapacity ?? 8,
          input.startMode,
          input.scheduledStartAt ?? null,
          input.startMode,
        )
      } catch {
        // Единственият UNIQUE constraint, който INSERT в tournaments може да
        // удари, е idx_tournaments_one_active_per_creator (partial index,
        // виж migration 20260730_003) — DB-ниво защита срещу race condition
        // при две едновременни POST заявки от същия creator (огледално на
        // insertPartnerRatingStatement pattern-а в playerProgressStore.ts).
        return { ok: false, reason: 'active_tournament_limit' }
      }
      const record = selectTournamentByIdStatement.get(tournamentId) as TournamentRow
      return { ok: true, tournament: toTournamentRecord(record) }
    },

    getTournamentById(tournamentId: TournamentId): TournamentRecord | null {
      const row = selectTournamentByIdStatement.get(tournamentId) as TournamentRow | undefined
      return row ? toTournamentRecord(row) : null
    },

    listTournaments(filter: ListTournamentsFilter = {}): TournamentRecord[] {
      const limit = filter.limit ?? 50
      const offset = filter.offset ?? 0
      const conditions: string[] = []
      const params: (string | number)[] = []

      if (filter.statuses && filter.statuses.length > 0) {
        conditions.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`)
        params.push(...filter.statuses)
      }
      if (filter.creatorProfileId) {
        conditions.push('creator_profile_id = ?')
        params.push(filter.creatorProfileId)
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
      const orderBy = filter.orderBy === 'finished_desc'
        ? 'finished_at DESC, created_at DESC'
        : 'created_at DESC'
      const rows = database
        .prepare(
          `SELECT
             tournament_id, kind, name, creator_profile_id, visibility, password_hash,
             entry_fee, player_capacity, start_mode, scheduled_start_at, fill_expires_at, status,
             cancel_reason, created_at, updated_at, started_at, finished_at,
             champion_team_id, runner_up_team_id, settlement_state, settled_at,
             total_entry_amount, system_fee_percent, system_fee_amount, prize_pool_amount,
             winner_share_percent, runner_up_share_percent, winner_team_prize_amount,
             runner_up_team_prize_amount, winner_player_prize_amount,
             runner_up_player_prize_amount, financial_rules_version
           FROM tournaments
           ${whereClause}
           ORDER BY ${orderBy}
           LIMIT ? OFFSET ?;`,
        )
        .all(...params, limit, offset) as TournamentRow[]
      return rows.map(toTournamentRecord)
    },

    countTournaments(filter: Pick<ListTournamentsFilter, 'statuses' | 'creatorProfileId'> = {}): number {
      const conditions: string[] = []
      const params: (string | number)[] = []

      if (filter.statuses && filter.statuses.length > 0) {
        conditions.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`)
        params.push(...filter.statuses)
      }
      if (filter.creatorProfileId) {
        conditions.push('creator_profile_id = ?')
        params.push(filter.creatorProfileId)
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
      const row = database
        .prepare(`SELECT COUNT(*) as count FROM tournaments ${whereClause};`)
        .get(...params) as { count: number }
      return row.count
    },

    updateTournamentStatus(
      tournamentId: TournamentId,
      expectedStatus: TournamentStatus,
      nextStatus: TournamentStatus,
    ): boolean {
      const result = updateTournamentStatusStatement.run(nextStatus, tournamentId, expectedStatus)
      return result.changes > 0
    },

    updateScheduledStartAt(
      tournamentId: TournamentId,
      requesterProfileId: ProfileId,
      newScheduledStartAtIso: string,
    ): UpdateScheduledStartAtResult {
      const row = selectTournamentByIdStatement.get(tournamentId) as TournamentRow | undefined
      if (row === undefined) return { ok: false, reason: 'tournament_not_found' }
      if (row.creator_profile_id !== requesterProfileId) return { ok: false, reason: 'not_creator' }
      if (row.start_mode !== 'scheduled') return { ok: false, reason: 'not_scheduled_mode' }
      if (row.status !== 'open') return { ok: false, reason: 'tournament_not_open' }

      const result = updateScheduledStartAtStatement.run(
        newScheduledStartAtIso,
        tournamentId,
        requesterProfileId,
      ) as { changes?: number }

      if ((result.changes ?? 0) === 0) {
        // Race between the pre-check above and the guarded UPDATE (e.g. the
        // tournament started or was cancelled in between) — re-read for an
        // accurate reason instead of a generic failure.
        const fresh = selectTournamentByIdStatement.get(tournamentId) as TournamentRow | undefined
        if (fresh === undefined) return { ok: false, reason: 'tournament_not_found' }
        if (fresh.creator_profile_id !== requesterProfileId) return { ok: false, reason: 'not_creator' }
        if (fresh.start_mode !== 'scheduled') return { ok: false, reason: 'not_scheduled_mode' }
        return { ok: false, reason: 'tournament_not_open' }
      }

      const updated = selectTournamentByIdStatement.get(tournamentId) as TournamentRow
      return { ok: true, tournament: toTournamentRecord(updated) }
    },

    createTeam(input: CreateTournamentTeamInput): TournamentTeamRecord {
      const teamId = randomUUID()
      insertTeamStatement.run(
        teamId,
        input.tournamentId,
        input.status ?? 'forming',
        input.seedSlot ?? null,
      )
      const row = database
        .prepare(
          `SELECT team_id, tournament_id, status, seed_slot, created_at, updated_at
           FROM tournament_teams WHERE team_id = ? LIMIT 1;`,
        )
        .get(teamId) as TournamentTeamRow
      return toTournamentTeamRecord(row)
    },

    getTeamsForTournament(tournamentId: TournamentId): TournamentTeamRecord[] {
      const rows = selectTeamsForTournamentStatement.all(tournamentId) as TournamentTeamRow[]
      return rows.map(toTournamentTeamRecord)
    },

    createEntry(input: CreateTournamentEntryInput): TournamentEntryRecord {
      const entryId = randomUUID()
      insertEntryStatement.run(
        entryId,
        input.tournamentId,
        input.profileId,
        input.teamId ?? null,
        input.joinedAs,
        input.status ?? 'confirmed',
      )
      const row = database
        .prepare(
          `SELECT entry_id, tournament_id, profile_id, team_id, joined_as, status,
                  created_at, updated_at, withdrawn_at, refunded_at
           FROM tournament_entries WHERE entry_id = ? LIMIT 1;`,
        )
        .get(entryId) as TournamentEntryRow
      return toTournamentEntryRecord(row)
    },

    getEntriesForTournament(tournamentId: TournamentId): TournamentEntryRecord[] {
      const rows = selectEntriesForTournamentStatement.all(tournamentId) as TournamentEntryRow[]
      return rows.map(toTournamentEntryRecord)
    },

    createPartnerInvite(input: CreatePartnerInviteInput): TournamentPartnerInviteRecord {
      const inviteId = randomUUID()
      insertPartnerInviteStatement.run(
        inviteId,
        input.tournamentId,
        input.teamId,
        input.inviterProfileId,
        input.inviteeProfileId,
        input.expiresAt,
      )
      const row = selectPartnerInviteByIdStatement.get(inviteId) as TournamentPartnerInviteRow
      return toTournamentPartnerInviteRecord(row)
    },

    getPartnerInviteById(inviteId: TournamentPartnerInviteId): TournamentPartnerInviteRecord | null {
      const row = selectPartnerInviteByIdStatement.get(inviteId) as
        | TournamentPartnerInviteRow
        | undefined
      return row ? toTournamentPartnerInviteRecord(row) : null
    },

    listPendingInvitesForProfile(inviteeProfileId: ProfileId): TournamentPartnerInviteRecord[] {
      const rows = selectPendingInvitesForProfileStatement.all(
        inviteeProfileId,
      ) as TournamentPartnerInviteRow[]
      return rows.map(toTournamentPartnerInviteRecord)
    },

    dismissInvitePopup(inviteId: TournamentPartnerInviteId): boolean {
      const result = updatePopupDismissedStatement.run(inviteId)
      return result.changes > 0
    },

    markInviteNotificationRead(inviteId: TournamentPartnerInviteId): boolean {
      const result = updateNotificationReadStatement.run(inviteId)
      return result.changes > 0
    },

    createRound(input: CreateTournamentRoundInput): TournamentRoundRecord {
      const roundId = randomUUID()
      insertRoundStatement.run(roundId, input.tournamentId, input.roundType, input.roundIndex)
      const row = database
        .prepare(
          `SELECT round_id, tournament_id, round_type, round_index, created_at
           FROM tournament_rounds WHERE round_id = ? LIMIT 1;`,
        )
        .get(roundId) as TournamentRoundRow
      return toTournamentRoundRecord(row)
    },

    getRoundsForTournament(tournamentId: TournamentId): TournamentRoundRecord[] {
      const rows = selectRoundsForTournamentStatement.all(tournamentId) as TournamentRoundRow[]
      return rows.map(toTournamentRoundRecord)
    },

    createTournamentMatch(input: CreateTournamentMatchInput): TournamentMatchRecord {
      const matchId = randomUUID()
      insertMatchStatement.run(
        matchId,
        input.tournamentId,
        input.roundId,
        input.roomId ?? null,
        input.teamAId,
        input.teamBId,
        input.noShowDeadlineAt ?? null,
      )
      const row = database
        .prepare(
          `SELECT
             match_id, tournament_id, round_id, room_id, team_a_id, team_b_id, status,
             no_show_deadline_at, attendance_started_at, attendance_deadline_at,
             attendance_resolved_at, attendance_resolution_kind, game_start_at,
             attendance_revision, winner_team_id, result_kind, walkover_reason,
             missing_profile_ids, final_score_team_a, final_score_team_b, final_start_at,
             next_match_start_at, created_at, started_at, completed_at
           FROM tournament_matches WHERE match_id = ? LIMIT 1;`,
        )
        .get(matchId) as TournamentMatchRow
      return toTournamentMatchRecord(row)
    },

    getMatchesForTournament(tournamentId: TournamentId): TournamentMatchRecord[] {
      const rows = selectMatchesForTournamentStatement.all(tournamentId) as TournamentMatchRow[]
      return rows.map(toTournamentMatchRecord)
    },

    hasSemifinalResultAcknowledgement(
      tournamentId: TournamentId,
      semifinalMatchId: string,
      profileId: ProfileId,
    ): boolean {
      return selectSemifinalAcknowledgementStatement.get(tournamentId, semifinalMatchId, profileId) !== undefined
    },

    countMissingHumanFinalistAcknowledgements(
      tournamentId: TournamentId,
      teamAId: TournamentTeamId,
      teamBId: TournamentTeamId,
    ): number {
      return (countMissingHumanFinalistAcknowledgementsStatement.get(tournamentId, teamAId, teamBId) as { count: number }).count
    },

    appendTournamentEvent(input: AppendTournamentEventInput): TournamentEventRecord {
      const eventId = randomUUID()
      insertEventStatement.run(
        eventId,
        input.tournamentId,
        input.eventType,
        input.actorProfileId ?? null,
        input.actorRole ?? null,
        input.payload !== undefined && input.payload !== null ? JSON.stringify(input.payload) : null,
      )
      const row = database
        .prepare(
          `SELECT event_id, tournament_id, event_type, actor_profile_id, actor_role,
                  payload_json, created_at
           FROM tournament_events WHERE event_id = ? LIMIT 1;`,
        )
        .get(eventId) as TournamentEventRow
      return toTournamentEventRecord(row)
    },

    close(): void {
      database.close()
    },
  }
}
