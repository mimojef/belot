import { getBotProfilesCatalog, type BotProfileRecord } from '../bots/botProfiles.js'
import { normalizeProfileDisplayName, normalizeProfileUsername } from './normalizeProfileIdentityText.js'

export type ImportBotProfilesCatalogResult = {
  processedCount: number
  insertedCount: number
  updatedCount: number
}

type SqliteModule = typeof import('node:sqlite')

type ExistingProfileRow = {
  profile_id: string
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getAllowedStakes(profile: BotProfileRecord): readonly number[] {
  return profile.allowedStakes.length > 0 ? profile.allowedStakes : [5000]
}

function getAutoRefillThreshold(profile: BotProfileRecord): number {
  return Math.min(...getAllowedStakes(profile))
}

function getAutoRefillTargetBalance(profile: BotProfileRecord): number {
  const allowedStakes = getAllowedStakes(profile)
  const highestAllowedStake = Math.max(...allowedStakes)

  return Math.max(highestAllowedStake * 5, getAutoRefillThreshold(profile))
}

function getInitialWalletBalance(profile: BotProfileRecord): number {
  return getAutoRefillTargetBalance(profile)
}

function resolveTargetProfileId(
  profile: BotProfileRecord,
  existingByProfileId: ExistingProfileRow | undefined,
  existingByBotCode: ExistingProfileRow | undefined,
): string {
  if (
    existingByProfileId &&
    existingByBotCode &&
    existingByProfileId.profile_id !== existingByBotCode.profile_id
  ) {
    throw new Error(
      `Bot catalog import found conflicting profile ids for bot code "${profile.code}".`,
    )
  }

  return existingByProfileId?.profile_id ?? existingByBotCode?.profile_id ?? profile.profileId
}

export async function importBotProfilesCatalog(
  databaseFilePath: string,
): Promise<ImportBotProfilesCatalogResult> {
  let sqliteModule: SqliteModule

  try {
    sqliteModule = await import('node:sqlite')
  } catch (error) {
    throw new Error(
      `Bot catalog DB import requires node:sqlite (Node 22.5+). ` +
        `Original error: ${toErrorMessage(error)}`,
    )
  }

  const database = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  try {
    database.exec('PRAGMA foreign_keys = ON;')

    const selectProfileByIdStatement = database.prepare(`
      SELECT profile_id
      FROM profiles
      WHERE profile_id = ?
      LIMIT 1;
    `)

    const selectProfileIdByBotCodeStatement = database.prepare(`
      SELECT profile_id
      FROM bot_metadata
      WHERE bot_code = ?
      LIMIT 1;
    `)

    const selectProfileIdByNormalizedDisplayNameStatement = database.prepare(`
      SELECT profile_id
      FROM profiles
      WHERE normalized_display_name = ?
      LIMIT 1;
    `)

    const selectProfileIdByNormalizedUsernameStatement = database.prepare(`
      SELECT profile_id
      FROM profiles
      WHERE normalized_username = ?
      LIMIT 1;
    `)

    const upsertProfileStatement = database.prepare(`
      INSERT INTO profiles (
        profile_id,
        account_id,
        profile_kind,
        username,
        normalized_username,
        display_name,
        normalized_display_name,
        avatar_url,
        level,
        rank_title,
        skill_rating,
        status
      ) VALUES (
        ?,
        NULL,
        'bot',
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?
      )
      ON CONFLICT(profile_id) DO UPDATE SET
        profile_kind = excluded.profile_kind,
        username = excluded.username,
        normalized_username = excluded.normalized_username,
        display_name = excluded.display_name,
        normalized_display_name = excluded.normalized_display_name,
        avatar_url = excluded.avatar_url,
        level = excluded.level,
        rank_title = excluded.rank_title,
        skill_rating = excluded.skill_rating,
        status = excluded.status,
        updated_at = CURRENT_TIMESTAMP;
    `)

    const insertWalletIfMissingStatement = database.prepare(`
      INSERT INTO profile_wallets (
        profile_id,
        yellow_coins_balance
      ) VALUES (?, ?)
      ON CONFLICT(profile_id) DO NOTHING;
    `)

    const upsertBotMetadataStatement = database.prepare(`
      INSERT INTO bot_metadata (
        profile_id,
        bot_code,
        difficulty,
        behavior_preset,
        logic_source,
        selection_weight,
        auto_refill_threshold,
        auto_refill_target_balance
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_id) DO UPDATE SET
        bot_code = excluded.bot_code,
        difficulty = excluded.difficulty,
        behavior_preset = excluded.behavior_preset,
        logic_source = excluded.logic_source,
        selection_weight = excluded.selection_weight,
        auto_refill_threshold = excluded.auto_refill_threshold,
        auto_refill_target_balance = excluded.auto_refill_target_balance,
        updated_at = CURRENT_TIMESTAMP;
    `)

    const deleteAllowedStakesStatement = database.prepare(`
      DELETE FROM bot_allowed_stakes
      WHERE profile_id = ?;
    `)

    const insertAllowedStakeStatement = database.prepare(`
      INSERT OR IGNORE INTO bot_allowed_stakes (
        profile_id,
        stake_amount
      ) VALUES (?, ?);
    `)

    let insertedCount = 0
    let updatedCount = 0
    const catalog = getBotProfilesCatalog()

    database.exec('BEGIN;')

    try {
      for (const profile of catalog) {
        const existingByProfileId = selectProfileByIdStatement.get(
          profile.profileId,
        ) as ExistingProfileRow | undefined
        const existingByBotCode = selectProfileIdByBotCodeStatement.get(
          profile.code,
        ) as ExistingProfileRow | undefined
        const targetProfileId = resolveTargetProfileId(
          profile,
          existingByProfileId,
          existingByBotCode,
        )
        const normalizedDisplayName = normalizeProfileDisplayName(
          profile.identity.displayName,
        )
        const normalizedUsername = normalizeProfileUsername(
          profile.identity.username,
        )

        if (!normalizedDisplayName) {
          throw new Error(
            `Bot catalog import requires a non-empty display name for "${profile.code}".`,
          )
        }

        const existingByDisplayName =
          selectProfileIdByNormalizedDisplayNameStatement.get(
            normalizedDisplayName,
          ) as ExistingProfileRow | undefined

        if (
          existingByDisplayName &&
          existingByDisplayName.profile_id !== targetProfileId
        ) {
          throw new Error(
            `Normalized display name conflict for "${profile.identity.displayName}".`,
          )
        }

        if (normalizedUsername) {
          const existingByUsername = selectProfileIdByNormalizedUsernameStatement.get(
            normalizedUsername,
          ) as ExistingProfileRow | undefined

          if (existingByUsername && existingByUsername.profile_id !== targetProfileId) {
            throw new Error(
              `Normalized username conflict for "${profile.identity.username}".`,
            )
          }
        }

        upsertProfileStatement.run(
          targetProfileId,
          profile.identity.username,
          normalizedUsername,
          profile.identity.displayName,
          normalizedDisplayName,
          profile.identity.avatarUrl,
          profile.identity.level,
          profile.identity.rankTitle,
          profile.identity.skillRating,
          profile.status,
        )

        insertWalletIfMissingStatement.run(
          targetProfileId,
          getInitialWalletBalance(profile),
        )

        upsertBotMetadataStatement.run(
          targetProfileId,
          profile.code,
          profile.difficulty,
          profile.behaviorPreset,
          profile.logicSource,
          profile.selectionWeight,
          getAutoRefillThreshold(profile),
          getAutoRefillTargetBalance(profile),
        )

        deleteAllowedStakesStatement.run(targetProfileId)

        for (const stake of getAllowedStakes(profile)) {
          insertAllowedStakeStatement.run(targetProfileId, stake)
        }

        if (existingByProfileId || existingByBotCode) {
          updatedCount += 1
        } else {
          insertedCount += 1
        }
      }

      database.exec('COMMIT;')
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // ignore rollback failure and surface the original import error
      }

      throw error
    }

    return {
      processedCount: catalog.length,
      insertedCount,
      updatedCount,
    }
  } finally {
    database.close()
  }
}
