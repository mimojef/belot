import { createRequire } from 'node:module'
import type { BotBehaviorPreset, BotLogicSource } from '../bots/botProfiles.js'
import type {
  BotDifficulty,
  PlayerIdentitySnapshot,
  ProfileId,
} from '../core/serverTypes.js'
import type { MatchStake } from '../matchmaking/matchmakingTypes.js'
import { getServerDatabaseFilePath } from './ensureServerDatabaseReady.js'

const require = createRequire(import.meta.url)

type SqliteModule = typeof import('node:sqlite')

type CandidateRow = {
  profile_id: string
  bot_code: string
  difficulty: BotDifficulty
  behavior_preset: BotBehaviorPreset
  logic_source: BotLogicSource
  selection_weight: number
  username: string | null
  display_name: string
  avatar_url: string | null
  level: number
  rank_title: string | null
  skill_rating: number
  yellow_coins_balance: number
}

export type DbEligibleBotProfile = {
  profileId: ProfileId
  code: string
  difficulty: BotDifficulty
  behaviorPreset: BotBehaviorPreset
  logicSource: BotLogicSource
  selectionWeight: number
  yellowCoinsBalance: number
  identity: PlayerIdentitySnapshot
}

type WeightedCandidate = {
  selectionWeight: number
}

function loadSqliteModule(): SqliteModule | null {
  try {
    return require('node:sqlite') as SqliteModule
  } catch {
    return null
  }
}

function createExcludedProfilesClause(
  excludedProfileIds: readonly ProfileId[],
): { sql: string; params: ProfileId[] } {
  if (excludedProfileIds.length === 0) {
    return {
      sql: '',
      params: [],
    }
  }

  return {
    sql: ` AND p.profile_id NOT IN (${excludedProfileIds.map(() => '?').join(', ')})`,
    params: [...excludedProfileIds],
  }
}

function pickWeightedCandidate<T extends WeightedCandidate>(
  candidates: readonly T[],
  nextRandom: () => number = Math.random,
): T | null {
  if (candidates.length === 0) {
    return null
  }

  const totalWeight = candidates.reduce((sum, candidate) => {
    return sum + Math.max(0, Math.trunc(candidate.selectionWeight))
  }, 0)

  if (totalWeight <= 0) {
    return candidates[0] ?? null
  }

  let roll = nextRandom() * totalWeight

  for (const candidate of candidates) {
    roll -= Math.max(0, Math.trunc(candidate.selectionWeight))

    if (roll <= 0) {
      return candidate
    }
  }

  return candidates[candidates.length - 1] ?? null
}

function mapCandidateToEligibleBotProfile(
  candidate: CandidateRow,
): DbEligibleBotProfile {
  return {
    profileId: candidate.profile_id,
    code: candidate.bot_code,
    difficulty: candidate.difficulty,
    behaviorPreset: candidate.behavior_preset,
    logicSource: candidate.logic_source,
    selectionWeight: candidate.selection_weight,
    yellowCoinsBalance: candidate.yellow_coins_balance,
    identity: {
      accountId: null,
      profileId: candidate.profile_id,
      username: candidate.username,
      displayName: candidate.display_name,
      avatarUrl: candidate.avatar_url,
      level: candidate.level,
      rankTitle: candidate.rank_title,
      skillRating: candidate.skill_rating,
    },
  }
}

export function listEligibleBotProfilesFromDb(
  stake: MatchStake,
  excludedProfileIds: readonly ProfileId[] = [],
): DbEligibleBotProfile[] | null {
  const sqliteModule = loadSqliteModule()

  if (!sqliteModule) {
    return null
  }

  const database = new sqliteModule.DatabaseSync(getServerDatabaseFilePath(), {
    open: true,
    enableForeignKeyConstraints: true,
  })

  try {
    database.exec('PRAGMA foreign_keys = ON;')

    const excludedProfilesClause = createExcludedProfilesClause(excludedProfileIds)
    const eligibleBaseSql = `
      FROM profiles p
      JOIN profile_wallets pw
        ON pw.profile_id = p.profile_id
      JOIN bot_metadata bm
        ON bm.profile_id = p.profile_id
      JOIN bot_allowed_stakes bas
        ON bas.profile_id = p.profile_id
      WHERE p.profile_kind = 'bot'
        AND p.status = 'active'
        AND bas.stake_amount = ?
        ${excludedProfilesClause.sql}
    `
    const refillCandidateParams = [stake, ...excludedProfilesClause.params]
    const refillSql = `
      UPDATE profile_wallets
      SET
        yellow_coins_balance = (
          SELECT bm.auto_refill_target_balance
          FROM bot_metadata bm
          WHERE bm.profile_id = profile_wallets.profile_id
        ),
        updated_at = CURRENT_TIMESTAMP
      WHERE profile_id IN (
        SELECT p.profile_id
        ${eligibleBaseSql}
      )
      AND yellow_coins_balance < (
        SELECT bm.auto_refill_threshold
        FROM bot_metadata bm
        WHERE bm.profile_id = profile_wallets.profile_id
      );
    `
    const candidateSql = `
      SELECT
        p.profile_id,
        bm.bot_code,
        bm.difficulty,
        bm.behavior_preset,
        bm.logic_source,
        bm.selection_weight,
        p.username,
        p.display_name,
        p.avatar_url,
        p.level,
        p.rank_title,
        p.skill_rating,
        pw.yellow_coins_balance
      ${eligibleBaseSql}
        AND pw.yellow_coins_balance >= ?
      ORDER BY p.profile_id ASC;
    `
    const candidateParams = [stake, ...excludedProfilesClause.params, stake]

    database.exec('BEGIN;')

    try {
      database.prepare(refillSql).run(...refillCandidateParams)

      const candidates = database.prepare(candidateSql).all(
        ...candidateParams,
      ) as CandidateRow[]

      database.exec('COMMIT;')
      return candidates.map(mapCandidateToEligibleBotProfile)
    } catch {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // ignore rollback failure and preserve the safe fallback path
      }

      return null
    }
  } finally {
    database.close()
  }
}

export function pickEligibleBotProfileFromDb(
  stake: MatchStake,
  excludedProfileIds: readonly ProfileId[] = [],
): DbEligibleBotProfile | null {
  const candidates = listEligibleBotProfilesFromDb(stake, excludedProfileIds)

  if (!candidates) {
    return null
  }

  return pickWeightedCandidate(candidates)
}
