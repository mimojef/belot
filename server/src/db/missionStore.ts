import { randomUUID } from 'node:crypto'
import type { ProfileId, Seat, ServerRoom, Team } from '../core/serverTypes.js'
import { SERVER_SEAT_ORDER, SERVER_TEAM_A_SEATS } from '../core/serverTypes.js'
import type {
  ServerAuthoritativeGameState,
  ServerDeclarationMissionType,
  ServerRoundScore,
} from '../game/serverGameTypes.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type MissionType =
  | 'win_games'
  | 'win_capot_games'
  | 'win_contra_games'
  | 'play_games'
  | 'announce_tersa'
  | 'announce_50'
  | 'announce_100'
  | 'announce_kare'
  | 'announce_belot'

export type MissionTemplateSnapshot = {
  missionId: string
  missionType: MissionType
  title: string
  targetCount: number
  rewardYellowCoins: number
  isActive: boolean
  isStaged: boolean
  sortOrder: number
}

export type MissionTemplateInput = {
  missionId?: string | null
  missionType: MissionType
  title: string
  targetCount: number
  rewardYellowCoins: number
  isActive?: boolean
  isStaged?: boolean
  sortOrder?: number
}

export type PlayerMissionProgressSnapshot = {
  progressId: string
  missionId: string
  missionType: MissionType
  title: string
  targetCount: number
  rewardYellowCoins: number
  progressCount: number
  isClaimed: boolean
  isCompleted: boolean
}

export type MissionStore = {
  listAllMissions: () => MissionTemplateSnapshot[]
  listActiveMissions: () => MissionTemplateSnapshot[]
  listStagedMissions: () => MissionTemplateSnapshot[]
  maybePromoteStaged: () => void
  upsertMission: (
    input: MissionTemplateInput,
  ) => { ok: true; mission: MissionTemplateSnapshot } | { ok: false; message: string }
  deleteMission: (
    missionId: string,
  ) => { ok: true } | { ok: false; message: string }
  setMissionActive: (
    missionId: string,
    isActive: boolean,
  ) => { ok: true; mission: MissionTemplateSnapshot } | { ok: false; message: string }
  getPlayerDailyMissions: (
    profileId: ProfileId,
    date: string,
  ) => PlayerMissionProgressSnapshot[]
  getUnclaimedCompletedCount: (profileId: ProfileId, date: string) => number
  claimMissionReward: (
    profileId: ProfileId,
    missionId: string,
    date: string,
  ) => { ok: true; rewardYellowCoins: number } | { ok: false; message: string }
  recordMatchCompletion: (room: ServerRoom) => void
  close: () => void
}

type MissionTemplateRow = {
  mission_id: string
  mission_type: string
  title: string
  target_count: number
  reward_yellow_coins: number
  is_active: number
  is_staged: number
  sort_order: number
}

type MissionProgressRow = {
  progress_id: string
  profile_id: string
  mission_id: string
  date: string
  progress_count: number
  is_claimed: number
  claimed_at: string | null
  mission_type: string
  title: string
  target_count: number
  reward_yellow_coins: number
}

function rowToMissionTemplate(row: MissionTemplateRow): MissionTemplateSnapshot {
  return {
    missionId: row.mission_id,
    missionType: row.mission_type as MissionType,
    title: row.title,
    targetCount: row.target_count,
    rewardYellowCoins: row.reward_yellow_coins,
    isActive: row.is_active === 1,
    isStaged: row.is_staged === 1,
    sortOrder: row.sort_order,
  }
}

function rowToPlayerMission(row: MissionProgressRow): PlayerMissionProgressSnapshot {
  const isCompleted = row.progress_count >= row.target_count
  return {
    progressId: row.progress_id,
    missionId: row.mission_id,
    missionType: row.mission_type as MissionType,
    title: row.title,
    targetCount: row.target_count,
    rewardYellowCoins: row.reward_yellow_coins,
    progressCount: row.progress_count,
    isClaimed: row.is_claimed === 1,
    isCompleted,
  }
}

function getTodayDate(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Sofia' })
}

function getTeamBySeat(seat: Seat): Team {
  return SERVER_TEAM_A_SEATS.includes(seat) ? 'A' : 'B'
}

function getHumanProfilesBySeat(
  room: ServerRoom,
): Map<Seat, ProfileId> {
  const result = new Map<Seat, ProfileId>()
  for (const seat of SERVER_SEAT_ORDER) {
    const participant = room.seats[seat].participant
    if (participant !== null && participant.kind === 'human') {
      const profileId = participant.identity.profileId
      if (profileId !== null) {
        result.set(seat, profileId)
      }
    }
  }
  return result
}

type MatchMissionDeltas = {
  profileId: ProfileId
  deltas: Partial<Record<MissionType, number>>
}[]

const DECLARATION_MISSION_TYPES: ServerDeclarationMissionType[] = [
  'announce_tersa',
  'announce_50',
  'announce_100',
  'announce_kare',
  'announce_belot',
]

function getTeamMissionCount(score: ServerRoundScore | null | undefined, team: Team): number {
  if (!score) {
    return 0
  }

  return team === 'A' ? score.teamA : score.teamB
}

function computeMatchMissionDeltas(room: ServerRoom): MatchMissionDeltas {
  const state = room.game.authoritativeState

  if (
    state === null ||
    !('phase' in state) ||
    state.phase !== 'match-ended' ||
    state.matchEnded === null ||
    state.scoring === null
  ) {
    return []
  }

  const winnerTeam = state.matchEnded.winnerTeam
  const isCapot = state.scoring.isCapotRound
  const counterMultiplier = state.scoring.counterMultiplier
  const isContra = counterMultiplier > 1

  const humansBySeat = getHumanProfilesBySeat(room)
  const result: MatchMissionDeltas = []

  for (const [seat, profileId] of humansBySeat) {
    const team = getTeamBySeat(seat)
    const didWin = team === winnerTeam
    const deltas: Partial<Record<MissionType, number>> = {}

    deltas['play_games'] = 1

    if (didWin) {
      deltas['win_games'] = 1
      if (isCapot) deltas['win_capot_games'] = 1
      if (isContra) deltas['win_contra_games'] = 1
    }

    const matchDeclarationMissionCounts =
      (state as Partial<ServerAuthoritativeGameState>).matchDeclarationMissionCounts

    if (matchDeclarationMissionCounts) {
      for (const missionType of DECLARATION_MISSION_TYPES) {
        const count = getTeamMissionCount(matchDeclarationMissionCounts[missionType], team)

        if (count > 0) {
          deltas[missionType] = (deltas[missionType] ?? 0) + count
        }
      }
    } else {
      const declarations = (state as ServerAuthoritativeGameState).declarations ?? []
      for (const decl of declarations) {
        const declTeam = getTeamBySeat(decl.seat)
        if (declTeam !== team) continue
        if (!decl.valid || !decl.announced) continue

        switch (decl.publicLabel) {
          case 'Терца':
            deltas['announce_tersa'] = (deltas['announce_tersa'] ?? 0) + 1
            break
          case '50':
            deltas['announce_50'] = (deltas['announce_50'] ?? 0) + 1
            break
          case '100':
            deltas['announce_100'] = (deltas['announce_100'] ?? 0) + 1
            break
          case 'Каре':
            deltas['announce_kare'] = (deltas['announce_kare'] ?? 0) + 1
            break
          case 'Белот':
            deltas['announce_belot'] = (deltas['announce_belot'] ?? 0) + 1
            break
        }
      }
    }

    result.push({ profileId, deltas })
  }

  return result
}

export async function createMissionStore(
  databaseFilePath: string,
): Promise<MissionStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')

  const listAllMissionsStatement = database.prepare(`
    SELECT mission_id, mission_type, title, target_count, reward_yellow_coins, is_active, is_staged, sort_order
    FROM mission_templates
    ORDER BY sort_order ASC, created_at ASC
  `)

  const listActiveMissionsStatement = database.prepare(`
    SELECT mission_id, mission_type, title, target_count, reward_yellow_coins, is_active, is_staged, sort_order
    FROM mission_templates
    WHERE is_active = 1 AND is_staged = 0
    ORDER BY sort_order ASC, created_at ASC
  `)

  const listStagedMissionsStatement = database.prepare(`
    SELECT mission_id, mission_type, title, target_count, reward_yellow_coins, is_active, is_staged, sort_order
    FROM mission_templates
    WHERE is_staged = 1
    ORDER BY sort_order ASC, created_at ASC
  `)

  const getMissionByIdStatement = database.prepare(`
    SELECT mission_id, mission_type, title, target_count, reward_yellow_coins, is_active, is_staged, sort_order
    FROM mission_templates
    WHERE mission_id = ?
  `)

  const getAdminSettingStatement = database.prepare(`
    SELECT setting_value FROM admin_settings WHERE setting_key = ?
  `)

  const setAdminSettingStatement = database.prepare(`
    INSERT INTO admin_settings (setting_key, setting_value) VALUES (?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value
  `)

  const deleteActiveMissionsStatement = database.prepare(`
    DELETE FROM mission_templates WHERE is_staged = 0
  `)

  const promoteAllStagedStatement = database.prepare(`
    UPDATE mission_templates SET is_staged = 0 WHERE is_staged = 1
  `)

  const insertMissionStatement = database.prepare(`
    INSERT INTO mission_templates (mission_id, mission_type, title, target_count, reward_yellow_coins, is_active, is_staged, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const updateMissionStatement = database.prepare(`
    UPDATE mission_templates
    SET mission_type = ?, title = ?, target_count = ?, reward_yellow_coins = ?, is_active = ?, is_staged = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
    WHERE mission_id = ?
  `)

  const setMissionActiveStatement = database.prepare(`
    UPDATE mission_templates
    SET is_active = ?, updated_at = CURRENT_TIMESTAMP
    WHERE mission_id = ?
  `)

  const deleteMissionStatement = database.prepare(`
    DELETE FROM mission_templates WHERE mission_id = ?
  `)

  const getPlayerDailyMissionsStatement = database.prepare(`
    SELECT
      COALESCE(p.progress_id, '') AS progress_id,
      COALESCE(p.profile_id, ?) AS profile_id,
      m.mission_id,
      COALESCE(p.date, ?) AS date,
      COALESCE(p.progress_count, 0) AS progress_count,
      COALESCE(p.is_claimed, 0) AS is_claimed,
      p.claimed_at,
      m.mission_type,
      m.title,
      m.target_count,
      m.reward_yellow_coins
    FROM mission_templates m
    LEFT JOIN player_mission_progress p
      ON p.mission_id = m.mission_id
      AND p.profile_id = ?
      AND p.date = ?
    WHERE m.is_active = 1 AND m.is_staged = 0
    ORDER BY m.sort_order ASC, m.created_at ASC
  `)

  const getUnclaimedCompletedCountStatement = database.prepare(`
    SELECT COUNT(*) AS cnt
    FROM player_mission_progress p
    JOIN mission_templates m ON m.mission_id = p.mission_id
    WHERE p.profile_id = ?
      AND p.date = ?
      AND p.progress_count >= m.target_count
      AND p.is_claimed = 0
  `)

  const getMissionProgressStatement = database.prepare(`
    SELECT progress_id, profile_id, mission_id, date, progress_count, is_claimed
    FROM player_mission_progress
    WHERE profile_id = ? AND mission_id = ? AND date = ?
  `)

  const claimMissionStatement = database.prepare(`
    UPDATE player_mission_progress
    SET is_claimed = 1, claimed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE profile_id = ? AND mission_id = ? AND date = ?
      AND is_claimed = 0
  `)

  const insertProgressStatement = database.prepare(`
    INSERT INTO player_mission_progress (progress_id, profile_id, mission_id, date, progress_count)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, mission_id, date) DO UPDATE SET
      progress_count = player_mission_progress.progress_count + excluded.progress_count,
      updated_at = CURRENT_TIMESTAMP
  `)

  const addToWalletStatement = database.prepare(`
    UPDATE profile_wallets
    SET yellow_coins_balance = yellow_coins_balance + ?, updated_at = CURRENT_TIMESTAMP
    WHERE profile_id = ?
  `)

  function listAllMissions(): MissionTemplateSnapshot[] {
    return (listAllMissionsStatement.all() as MissionTemplateRow[]).map(rowToMissionTemplate)
  }

  function listActiveMissions(): MissionTemplateSnapshot[] {
    return (listActiveMissionsStatement.all() as MissionTemplateRow[]).map(rowToMissionTemplate)
  }

  function listStagedMissions(): MissionTemplateSnapshot[] {
    return (listStagedMissionsStatement.all() as MissionTemplateRow[]).map(rowToMissionTemplate)
  }

  function maybePromoteStaged(): void {
    const today = getTodayDate()
    const row = getAdminSettingStatement.get('last_mission_reset_date') as { setting_value: string } | undefined
    const lastResetDate = row?.setting_value ?? ''
    if (lastResetDate === today) return

    const staged = listStagedMissions()

    database.exec('BEGIN')
    try {
      if (staged.length > 0) {
        deleteActiveMissionsStatement.run()
        promoteAllStagedStatement.run()
      }
      // Always mark today as rotated — prevents mid-day promotion if admin
      // stages new missions between midnight and the first lazy call.
      setAdminSettingStatement.run('last_mission_reset_date', today)
      database.exec('COMMIT')
    } catch (err) {
      database.exec('ROLLBACK')
      throw err
    }
  }

  function upsertMission(
    input: MissionTemplateInput,
  ): { ok: true; mission: MissionTemplateSnapshot } | { ok: false; message: string } {
    try {
      const missionId = input.missionId ?? randomUUID()
      const isActive = input.isActive ?? true
      const isStaged = input.isStaged ?? false
      const sortOrder = input.sortOrder ?? 0

      const existing = getMissionByIdStatement.get(missionId) as MissionTemplateRow | undefined
      if (existing !== undefined) {
        updateMissionStatement.run(
          input.missionType,
          input.title,
          input.targetCount,
          input.rewardYellowCoins,
          isActive ? 1 : 0,
          isStaged ? 1 : 0,
          sortOrder,
          missionId,
        )
      } else {
        insertMissionStatement.run(
          missionId,
          input.missionType,
          input.title,
          input.targetCount,
          input.rewardYellowCoins,
          isActive ? 1 : 0,
          isStaged ? 1 : 0,
          sortOrder,
        )
      }

      const updated = getMissionByIdStatement.get(missionId) as MissionTemplateRow
      return { ok: true, mission: rowToMissionTemplate(updated) }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  function deleteMission(missionId: string): { ok: true } | { ok: false; message: string } {
    try {
      deleteMissionStatement.run(missionId)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  function setMissionActive(
    missionId: string,
    isActive: boolean,
  ): { ok: true; mission: MissionTemplateSnapshot } | { ok: false; message: string } {
    try {
      setMissionActiveStatement.run(isActive ? 1 : 0, missionId)
      const updated = getMissionByIdStatement.get(missionId) as MissionTemplateRow | undefined
      if (updated === undefined) {
        return { ok: false, message: 'Мисията не беше намерена.' }
      }
      return { ok: true, mission: rowToMissionTemplate(updated) }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  function getPlayerDailyMissions(
    profileId: ProfileId,
    date: string,
  ): PlayerMissionProgressSnapshot[] {
    const rows = getPlayerDailyMissionsStatement.all(
      profileId,
      date,
      profileId,
      date,
    ) as MissionProgressRow[]
    return rows.map(rowToPlayerMission)
  }

  function getUnclaimedCompletedCount(profileId: ProfileId, date: string): number {
    const row = getUnclaimedCompletedCountStatement.get(profileId, date) as { cnt: number }
    return row?.cnt ?? 0
  }

  function claimMissionReward(
    profileId: ProfileId,
    missionId: string,
    date: string,
  ): { ok: true; rewardYellowCoins: number } | { ok: false; message: string } {
    try {
      const progress = getMissionProgressStatement.get(profileId, missionId, date) as
        | { progress_id: string; progress_count: number; is_claimed: number }
        | undefined

      if (progress === undefined) {
        return { ok: false, message: 'Прогресът не беше намерен.' }
      }

      const missionRow = getMissionByIdStatement.get(missionId) as MissionTemplateRow | undefined
      if (missionRow === undefined) {
        return { ok: false, message: 'Мисията не беше намерена.' }
      }

      if (progress.progress_count < missionRow.target_count) {
        return { ok: false, message: 'Мисията не е завършена.' }
      }

      if (progress.is_claimed === 1) {
        return { ok: false, message: 'Наградата вече е взета.' }
      }

      claimMissionStatement.run(profileId, missionId, date)
      addToWalletStatement.run(missionRow.reward_yellow_coins, profileId)

      return { ok: true, rewardYellowCoins: missionRow.reward_yellow_coins }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  function recordMatchCompletion(room: ServerRoom): void {
    const deltas = computeMatchMissionDeltas(room)
    if (deltas.length === 0) return

    const today = getTodayDate()
    const activeMissions = listActiveMissions()
    if (activeMissions.length === 0) return

    for (const { profileId, deltas: playerDeltas } of deltas) {
      for (const mission of activeMissions) {
        const delta = playerDeltas[mission.missionType]
        if (!delta || delta <= 0) continue

        insertProgressStatement.run(
          randomUUID(),
          profileId,
          mission.missionId,
          today,
          delta,
        )
      }
    }
  }

  function close(): void {
    database.close()
  }

  return {
    listAllMissions,
    listActiveMissions,
    listStagedMissions,
    maybePromoteStaged,
    upsertMission,
    deleteMission,
    setMissionActive,
    getPlayerDailyMissions,
    getUnclaimedCompletedCount,
    claimMissionReward,
    recordMatchCompletion,
    close,
  }
}
