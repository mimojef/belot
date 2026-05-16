import { randomUUID } from 'node:crypto'
import type {
  PlayerPublicProfileSnapshot,
  ProfileId,
  RoomParticipant,
  Seat,
  ServerRoom,
  Team,
} from '../core/serverTypes.js'
import {
  SERVER_SEAT_ORDER,
  SERVER_TEAM_A_SEATS,
} from '../core/serverTypes.js'
import { normalizeProfileDisplayName } from './normalizeProfileIdentityText.js'
import { createRankProgressSnapshot, getRankTitleForLevel, computeEloChange } from '../progression/rankProgression.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type LeaderboardCategory = 'balance' | 'rank' | 'wins' | 'rating'

export type LeaderboardsSnapshot = Record<
  LeaderboardCategory,
  PlayerPublicProfileSnapshot[]
>

export type PlayerProgressStore = {
  createTemporaryHumanProfile: (
    displayName: string,
    stableKey: string,
  ) => PlayerPublicProfileSnapshot
  getPublicProfile: (profileId: ProfileId) => PlayerPublicProfileSnapshot | null
  listPublicHumanProfiles: (onlineProfileIds?: Set<string>) => PlayerPublicProfileSnapshot[]
  listLeaderboards: () => LeaderboardsSnapshot
  changeProfileDisplayName: (
    profileId: ProfileId,
    displayName: string,
    priceAmount: number,
  ) => { ok: true; profile: PlayerPublicProfileSnapshot } | { ok: false; message: string }
  updateProfileAvatar: (
    profileId: ProfileId,
    avatarUrl: string | null,
  ) => { ok: true; profile: PlayerPublicProfileSnapshot } | { ok: false; message: string }
  addProfileGalleryImage: (input: {
    profileId: ProfileId
    imageId: string
    imageUrl: string
    thumbnailUrl: string
  }) => { ok: true; profile: PlayerPublicProfileSnapshot } | { ok: false; message: string }
  deleteProfileGalleryImage: (
    profileId: ProfileId,
    imageId: string,
  ) =>
    | {
        ok: true
        profile: PlayerPublicProfileSnapshot
        deletedImageUrls: string[]
      }
    | { ok: false; message: string }
  isDisplayNameAvailable: (displayName: string) => boolean
  seedCatalogBotsIfNeeded: () => void
  refillCatalogBotWallets: () => void
  recordCompletedMatch: (room: ServerRoom) => void
  submitPartnerRating: (
    room: ServerRoom,
    raterSeat: Seat,
    ratingValue: number,
  ) => { ok: true } | { ok: false; message: string }
  close: () => void
}

type ProfileRatingRow = {
  average_rating: number
  total_ratings_count: number
}

type ProfileGalleryImageRow = {
  image_id: string
  image_url: string
  thumbnail_url: string
  sort_order: number
}

function getTeamBySeat(seat: Seat): Team {
  return SERVER_TEAM_A_SEATS.includes(seat) ? 'A' : 'B'
}

function getPartnerSeat(seat: Seat): Seat {
  if (seat === 'bottom') return 'top'
  if (seat === 'top') return 'bottom'
  if (seat === 'left') return 'right'
  return 'left'
}

function toSafeProfileId(stableKey: string): ProfileId {
  const normalizedKey = stableKey.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `guest_${normalizedKey}`.slice(0, 96)
}

function toUniqueGuestNormalizedDisplayName(
  displayName: string,
  stableKey: string,
): string {
  const trimmed = displayName.trim() || 'Гост'
  const suffix = stableKey.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6) || 'player'

  return `${trimmed} ${suffix}`
}

function toPublicProfileSnapshot(row: {
  profile_id: string
  profile_kind?: string
  display_name: string
  avatar_url: string | null
  level: number
  rank_title: string | null
  skill_rating: number
  average_rating: number
  total_ratings_count: number
  yellow_coins_balance: number
  completed_games_count: number | null
  won_games_count: number | null
  gender: string | null
}, galleryImages: ProfileGalleryImageRow[] = []): PlayerPublicProfileSnapshot {
  const rankProgress = createRankProgressSnapshot(row.completed_games_count ?? 0)
  const gender = row.gender === 'male' || row.gender === 'female' ? row.gender : null

  return {
    profileId: row.profile_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    level: row.level || rankProgress.rankLevel,
    rankTitle: getRankTitleForLevel(row.level || rankProgress.rankLevel),
    skillRating: row.skill_rating,
    completedGamesCount: rankProgress.completedGamesCount,
    wonGamesCount: row.won_games_count ?? 0,
    currentRankGames: rankProgress.currentRankGames,
    nextRankGames: rankProgress.nextRankGames,
    gamesUntilNextRank: rankProgress.gamesUntilNextRank,
    rankProgressRatio: rankProgress.progressRatio,
    averageRating: row.average_rating,
    totalRatingsCount: row.total_ratings_count,
    yellowCoinsBalance: row.yellow_coins_balance,
    gender,
    isBot: row.profile_kind === 'bot',
    galleryImages: galleryImages.map((image) => ({
      imageId: image.image_id,
      imageUrl: image.thumbnail_url || image.image_url,
      sortOrder: image.sort_order,
    })),
  }
}

function getParticipantProfileId(
  participant: RoomParticipant | null,
): ProfileId | null {
  return participant?.identity.profileId ?? participant?.publicProfile?.profileId ?? null
}

function getRuntimeMatchEnded(room: ServerRoom): {
  winnerTeam: Team
} | null {
  const authoritativeState = room.game.authoritativeState

  if (
    authoritativeState === null ||
    !('phase' in authoritativeState) ||
    authoritativeState.phase !== 'match-ended' ||
    authoritativeState.matchEnded === null
  ) {
    return null
  }

  return {
    winnerTeam: authoritativeState.matchEnded.winnerTeam,
  }
}

export async function createPlayerProgressStore(
  databaseFilePath: string,
): Promise<PlayerProgressStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')

  const upsertTemporaryProfileStatement = database.prepare(`
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
      'human',
      ?,
      ?,
      ?,
      ?,
      NULL,
      1,
      'Ранг 1',
      1000,
      'active'
    )
    ON CONFLICT(profile_id) DO UPDATE SET
      display_name = excluded.display_name,
      normalized_display_name = excluded.normalized_display_name,
      updated_at = CURRENT_TIMESTAMP;
  `)

  const ensureWalletStatement = database.prepare(`
    INSERT INTO profile_wallets (
      profile_id,
      yellow_coins_balance
    ) VALUES (
      ?,
      0
    )
    ON CONFLICT(profile_id) DO NOTHING;
  `)

  const ensureProgressStatement = database.prepare(`
    INSERT INTO profile_progress (
      profile_id,
      completed_games_count,
      won_games_count,
      rank_level
    ) VALUES (
      ?,
      0,
      0,
      1
    )
    ON CONFLICT(profile_id) DO NOTHING;
  `)

  const selectPublicProfileStatement = database.prepare(`
    SELECT
      p.profile_id,
      p.profile_kind,
      p.display_name,
      p.avatar_url,
      p.level,
      p.rank_title,
      p.skill_rating,
      p.average_rating,
      p.total_ratings_count,
      COALESCE(pw.yellow_coins_balance, 0) AS yellow_coins_balance,
      pp.completed_games_count,
      pp.won_games_count,
      p.gender
    FROM profiles p
    LEFT JOIN profile_wallets pw
      ON pw.profile_id = p.profile_id
    LEFT JOIN profile_progress pp
      ON pp.profile_id = p.profile_id
    WHERE p.profile_id = ?
    LIMIT 1;
  `)

  const selectProfileGalleryImagesStatement = database.prepare(`
    SELECT
      image_id,
      image_url,
      thumbnail_url,
      sort_order
    FROM profile_gallery_images
    WHERE profile_id = ?
    ORDER BY sort_order ASC, created_at ASC;
  `)

  const listPublicHumanProfilesStatement = database.prepare(`
    SELECT
      p.profile_id,
      p.profile_kind,
      p.display_name,
      p.avatar_url,
      p.level,
      p.rank_title,
      p.skill_rating,
      p.average_rating,
      p.total_ratings_count,
      COALESCE(pw.yellow_coins_balance, 0) AS yellow_coins_balance,
      pp.completed_games_count,
      pp.won_games_count,
      p.gender
    FROM profiles p
    LEFT JOIN profile_wallets pw
      ON pw.profile_id = p.profile_id
    LEFT JOIN profile_progress pp
      ON pp.profile_id = p.profile_id
    WHERE p.status = 'active'
      AND (
        (p.profile_kind = 'human' AND p.account_id IS NOT NULL)
        OR p.profile_kind = 'bot'
      )
    ORDER BY p.updated_at DESC, p.created_at DESC
    LIMIT 500;
  `)

  const listLeaderboardByBalanceStatement = database.prepare(`
    SELECT
      p.profile_id,
      p.display_name,
      p.avatar_url,
      p.level,
      p.rank_title,
      p.skill_rating,
      p.average_rating,
      p.total_ratings_count,
      COALESCE(pw.yellow_coins_balance, 0) AS yellow_coins_balance,
      pp.completed_games_count,
      pp.won_games_count,
      p.gender
    FROM profiles p
    LEFT JOIN profile_wallets pw
      ON pw.profile_id = p.profile_id
    LEFT JOIN profile_progress pp
      ON pp.profile_id = p.profile_id
    WHERE p.status = 'active'
      AND (
        (p.profile_kind = 'human' AND p.account_id IS NOT NULL)
        OR p.profile_kind = 'bot'
      )
    ORDER BY COALESCE(pw.yellow_coins_balance, 0) DESC,
      COALESCE(pp.completed_games_count, 0) DESC,
      p.display_name ASC
    LIMIT 50;
  `)

  const listLeaderboardByRankStatement = database.prepare(`
    SELECT
      p.profile_id,
      p.display_name,
      p.avatar_url,
      p.level,
      p.rank_title,
      p.skill_rating,
      p.average_rating,
      p.total_ratings_count,
      COALESCE(pw.yellow_coins_balance, 0) AS yellow_coins_balance,
      pp.completed_games_count,
      pp.won_games_count,
      p.gender
    FROM profiles p
    LEFT JOIN profile_wallets pw
      ON pw.profile_id = p.profile_id
    LEFT JOIN profile_progress pp
      ON pp.profile_id = p.profile_id
    WHERE p.status = 'active'
      AND (
        (p.profile_kind = 'human' AND p.account_id IS NOT NULL)
        OR p.profile_kind = 'bot'
      )
    ORDER BY COALESCE(pp.completed_games_count, 0) DESC,
      p.level DESC,
      COALESCE(pp.won_games_count, 0) DESC,
      p.display_name ASC
    LIMIT 50;
  `)

  const listLeaderboardByWinsStatement = database.prepare(`
    SELECT
      p.profile_id,
      p.display_name,
      p.avatar_url,
      p.level,
      p.rank_title,
      p.skill_rating,
      p.average_rating,
      p.total_ratings_count,
      COALESCE(pw.yellow_coins_balance, 0) AS yellow_coins_balance,
      pp.completed_games_count,
      pp.won_games_count,
      p.gender
    FROM profiles p
    LEFT JOIN profile_wallets pw
      ON pw.profile_id = p.profile_id
    LEFT JOIN profile_progress pp
      ON pp.profile_id = p.profile_id
    WHERE p.status = 'active'
      AND (
        (p.profile_kind = 'human' AND p.account_id IS NOT NULL)
        OR p.profile_kind = 'bot'
      )
    ORDER BY COALESCE(pp.won_games_count, 0) DESC,
      COALESCE(pp.completed_games_count, 0) DESC,
      p.display_name ASC
    LIMIT 50;
  `)

  const listLeaderboardByRatingStatement = database.prepare(`
    SELECT
      p.profile_id,
      p.display_name,
      p.avatar_url,
      p.level,
      p.rank_title,
      p.skill_rating,
      p.average_rating,
      p.total_ratings_count,
      COALESCE(pw.yellow_coins_balance, 0) AS yellow_coins_balance,
      pp.completed_games_count,
      pp.won_games_count,
      p.gender
    FROM profiles p
    LEFT JOIN profile_wallets pw
      ON pw.profile_id = p.profile_id
    LEFT JOIN profile_progress pp
      ON pp.profile_id = p.profile_id
    WHERE p.status = 'active'
      AND (
        (p.profile_kind = 'human' AND p.account_id IS NOT NULL)
        OR p.profile_kind = 'bot'
      )
      AND p.total_ratings_count > 0
    ORDER BY p.average_rating DESC,
      p.total_ratings_count DESC,
      COALESCE(pp.completed_games_count, 0) DESC,
      p.display_name ASC
    LIMIT 50;
  `)

  const refillCatalogBotWalletsStatement = database.prepare(`
    UPDATE profile_wallets
    SET
      yellow_coins_balance = 50000,
      updated_at = CURRENT_TIMESTAMP
    WHERE profile_id IN (
      SELECT profile_id FROM profiles
      WHERE profile_kind = 'bot' AND status = 'active'
    )
    AND yellow_coins_balance < 5000;
  `)

  const updateProfileAvatarStatement = database.prepare(`
    UPDATE profiles
    SET
      avatar_url = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE profile_id = ?
      AND profile_kind = 'human'
      AND status = 'active';
  `)

  const selectProfileDisplayNameStatement = database.prepare(`
    SELECT display_name
    FROM profiles
    WHERE profile_id = ?
      AND profile_kind = 'human'
      AND status = 'active'
    LIMIT 1;
  `)

  const selectProfileByNormalizedDisplayNameStatement = database.prepare(`
    SELECT profile_id
    FROM profiles
    WHERE normalized_display_name = ?
      AND status = 'active'
    LIMIT 1;
  `)

  const selectWalletBalanceStatement = database.prepare(`
    SELECT yellow_coins_balance
    FROM profile_wallets
    WHERE profile_id = ?
    LIMIT 1;
  `)

  const debitWalletStatement = database.prepare(`
    UPDATE profile_wallets
    SET
      yellow_coins_balance = yellow_coins_balance - ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE profile_id = ?
      AND yellow_coins_balance >= ?;
  `)

  const updateProfileDisplayNameStatement = database.prepare(`
    UPDATE profiles
    SET
      display_name = ?,
      normalized_display_name = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE profile_id = ?
      AND profile_kind = 'human'
      AND status = 'active';
  `)

  const insertNameChangeLedgerStatement = database.prepare(`
    INSERT INTO profile_name_change_ledger (
      change_id,
      profile_id,
      old_display_name,
      new_display_name,
      price_amount,
      balance_after
    ) VALUES (
      ?,
      ?,
      ?,
      ?,
      ?,
      ?
    );
  `)

  const selectNextGallerySortOrderStatement = database.prepare(`
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
    FROM profile_gallery_images
    WHERE profile_id = ?;
  `)

  const insertProfileGalleryImageStatement = database.prepare(`
    INSERT INTO profile_gallery_images (
      image_id,
      profile_id,
      image_url,
      thumbnail_url,
      sort_order
    ) VALUES (
      ?,
      ?,
      ?,
      ?,
      ?
    );
  `)

  const selectProfileGalleryImageStatement = database.prepare(`
    SELECT
      image_url,
      thumbnail_url
    FROM profile_gallery_images
    WHERE profile_id = ?
      AND image_id = ?
    LIMIT 1;
  `)

  const deleteProfileGalleryImageStatement = database.prepare(`
    DELETE FROM profile_gallery_images
    WHERE profile_id = ?
      AND image_id = ?;
  `)

  const insertMatchResultStatement = database.prepare(`
    INSERT OR IGNORE INTO profile_match_results (
      room_id,
      profile_id,
      team,
      did_win
    ) VALUES (
      ?,
      ?,
      ?,
      ?
    );
  `)

  const selectProgressStatement = database.prepare(`
    SELECT completed_games_count, won_games_count
    FROM profile_progress
    WHERE profile_id = ?
    LIMIT 1;
  `)

  const updateProgressStatement = database.prepare(`
    UPDATE profile_progress
    SET
      completed_games_count = ?,
      won_games_count = ?,
      rank_level = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE profile_id = ?;
  `)

  const updateProfileRankStatement = database.prepare(`
    UPDATE profiles
    SET
      level = ?,
      rank_title = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE profile_id = ?;
  `)

  const selectSkillRatingStatement = database.prepare(`
    SELECT skill_rating FROM profiles WHERE profile_id = ? LIMIT 1;
  `)

  const updateSkillRatingStatement = database.prepare(`
    UPDATE profiles SET skill_rating = ?, updated_at = CURRENT_TIMESTAMP WHERE profile_id = ?;
  `)

  const insertPartnerRatingStatement = database.prepare(`
    INSERT INTO profile_partner_ratings (
      rating_id,
      room_id,
      rated_profile_id,
      rated_by_profile_id,
      rating_value
    ) VALUES (
      ?,
      ?,
      ?,
      ?,
      ?
    );
  `)

  const selectRatingAggregateStatement = database.prepare(`
    SELECT
      COALESCE(AVG(rating_value), 0) AS average_rating,
      COUNT(*) AS total_ratings_count
    FROM profile_partner_ratings
    WHERE rated_profile_id = ?;
  `)

  const updateProfileRatingStatement = database.prepare(`
    UPDATE profiles
    SET
      average_rating = ?,
      total_ratings_count = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE profile_id = ?;
  `)

  function createTemporaryHumanProfile(
    displayName: string,
    stableKey: string,
  ): PlayerPublicProfileSnapshot {
    const profileId = toSafeProfileId(stableKey)
    const publicDisplayName = displayName.trim() || 'Гост'
    const uniqueDisplayName = toUniqueGuestNormalizedDisplayName(
      publicDisplayName,
      stableKey,
    )
    const normalizedDisplayName =
      normalizeProfileDisplayName(uniqueDisplayName) ?? profileId
    const username = profileId
    const normalizedUsername = profileId

    upsertTemporaryProfileStatement.run(
      profileId,
      username,
      normalizedUsername,
      publicDisplayName,
      normalizedDisplayName,
    )
    ensureWalletStatement.run(profileId)
    ensureProgressStatement.run(profileId)

    const row = selectPublicProfileStatement.get(profileId) as
      | Parameters<typeof toPublicProfileSnapshot>[0]
      | undefined

    if (!row) {
      throw new Error(`Temporary profile "${profileId}" was not created.`)
    }

    const galleryImages = selectProfileGalleryImagesStatement.all(profileId) as
      ProfileGalleryImageRow[]

    return toPublicProfileSnapshot(row, galleryImages)
  }

  function getPublicProfile(profileId: ProfileId): PlayerPublicProfileSnapshot | null {
    const row = selectPublicProfileStatement.get(profileId) as
      | Parameters<typeof toPublicProfileSnapshot>[0]
      | undefined

    if (!row) {
      return null
    }

    const galleryImages = selectProfileGalleryImagesStatement.all(profileId) as
      ProfileGalleryImageRow[]

    return toPublicProfileSnapshot(row, galleryImages)
  }

  function listPublicHumanProfiles(onlineProfileIds?: Set<string>): PlayerPublicProfileSnapshot[] {
    const rows = listPublicHumanProfilesStatement.all() as Array<
      Parameters<typeof toPublicProfileSnapshot>[0] & { profile_kind: string }
    >

    return rows.map((row) => {
      const galleryImages = selectProfileGalleryImagesStatement.all(
        row.profile_id,
      ) as ProfileGalleryImageRow[]

      const snapshot = toPublicProfileSnapshot(row, galleryImages)
      const isCatalogBot = row.profile_kind === 'bot'
      if (onlineProfileIds !== undefined || isCatalogBot) {
        snapshot.isOnline = isCatalogBot || (onlineProfileIds?.has(row.profile_id) ?? false)
      }
      return snapshot
    })
  }

  function listProfilesFromStatement(
    statement: ReturnType<SqliteDatabase['prepare']>,
  ): PlayerPublicProfileSnapshot[] {
    const rows = statement.all() as Array<
      Parameters<typeof toPublicProfileSnapshot>[0]
    >

    return rows.map((row) => {
      const galleryImages = selectProfileGalleryImagesStatement.all(
        row.profile_id,
      ) as ProfileGalleryImageRow[]

      return toPublicProfileSnapshot(row, galleryImages)
    })
  }

  function listLeaderboards(): LeaderboardsSnapshot {
    return {
      balance: listProfilesFromStatement(listLeaderboardByBalanceStatement),
      rank: listProfilesFromStatement(listLeaderboardByRankStatement),
      wins: listProfilesFromStatement(listLeaderboardByWinsStatement),
      rating: listProfilesFromStatement(listLeaderboardByRatingStatement),
    }
  }

  function getWalletBalance(profileId: ProfileId): number {
    const row = selectWalletBalanceStatement.get(profileId) as
      | { yellow_coins_balance: number }
      | undefined

    return row?.yellow_coins_balance ?? 0
  }

  function changeProfileDisplayName(
    profileId: ProfileId,
    displayNameRaw: string,
    priceAmountRaw: number,
  ): { ok: true; profile: PlayerPublicProfileSnapshot } | { ok: false; message: string } {
    const displayName = displayNameRaw.trim().replace(/\s+/g, ' ')
    const normalizedDisplayName = normalizeProfileDisplayName(displayName)

    if (normalizedDisplayName === null) {
      return {
        ok: false,
        message: 'Името може да съдържа само букви на кирилица, латиница, цифри и интервал.',
      }
    }

    if (displayName.length < 3 || displayName.length > 32) {
      return {
        ok: false,
        message: 'Името трябва да е между 3 и 32 символа.',
      }
    }

    if (!Number.isInteger(priceAmountRaw) || priceAmountRaw < 0) {
      return {
        ok: false,
        message: 'Невалидна цена за смяна на име.',
      }
    }

    const existingProfile = selectProfileDisplayNameStatement.get(profileId) as
      | { display_name: string }
      | undefined

    if (!existingProfile) {
      return {
        ok: false,
        message: 'Профилът не беше намерен.',
      }
    }

    if (normalizeProfileDisplayName(existingProfile.display_name) === normalizedDisplayName) {
      return {
        ok: false,
        message: 'Новото име трябва да е различно от текущото.',
      }
    }

    try {
      database.exec('BEGIN;')
      ensureWalletStatement.run(profileId)

      const debitResult = debitWalletStatement.run(
        priceAmountRaw,
        profileId,
        priceAmountRaw,
      ) as { changes?: number }

      if ((debitResult.changes ?? 0) === 0) {
        database.exec('ROLLBACK;')
        return {
          ok: false,
          message: 'Нямаш достатъчно жълтици за смяна на име.',
        }
      }

      const updateResult = updateProfileDisplayNameStatement.run(
        displayName,
        normalizedDisplayName,
        profileId,
      ) as { changes?: number }

      if ((updateResult.changes ?? 0) === 0) {
        database.exec('ROLLBACK;')
        return {
          ok: false,
          message: 'Профилът не беше намерен.',
        }
      }

      insertNameChangeLedgerStatement.run(
        randomUUID(),
        profileId,
        existingProfile.display_name,
        displayName,
        priceAmountRaw,
        getWalletBalance(profileId),
      )
      database.exec('COMMIT;')
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // surface the original failure
      }

      const message = error instanceof Error ? error.message : String(error)

      if (message.includes('normalized_display_name')) {
        return {
          ok: false,
          message: 'Това име вече е заето.',
        }
      }

      return {
        ok: false,
        message: 'Името не беше сменено.',
      }
    }

    const profile = getPublicProfile(profileId)

    if (profile === null) {
      return {
        ok: false,
        message: 'Профилът не беше намерен след смяната.',
      }
    }

    return {
      ok: true,
      profile,
    }
  }

  function normalizeAvatarUrl(value: string | null): string | null {
    const trimmed = value?.trim() ?? ''

    if (trimmed.length === 0) {
      return null
    }

    if (trimmed.length > 2048) {
      return ''
    }

    if (trimmed.startsWith('/')) {
      return trimmed
    }

    try {
      const parsedUrl = new URL(trimmed)

      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return ''
      }

      return parsedUrl.toString()
    } catch {
      return ''
    }
  }

  function updateProfileAvatar(
    profileId: ProfileId,
    avatarUrl: string | null,
  ): { ok: true; profile: PlayerPublicProfileSnapshot } | { ok: false; message: string } {
    const normalizedAvatarUrl = normalizeAvatarUrl(avatarUrl)

    if (normalizedAvatarUrl === '') {
      return {
        ok: false,
        message: 'Невалиден адрес за аватар.',
      }
    }

    const result = updateProfileAvatarStatement.run(
      normalizedAvatarUrl,
      profileId,
    ) as { changes?: number }

    if ((result.changes ?? 0) === 0) {
      return {
        ok: false,
        message: 'Профилът не беше намерен.',
      }
    }

    const profile = getPublicProfile(profileId)

    if (profile === null) {
      return {
        ok: false,
        message: 'Профилът не беше намерен.',
      }
    }

    return {
      ok: true,
      profile,
    }
  }

  function addProfileGalleryImage(input: {
    profileId: ProfileId
    imageId: string
    imageUrl: string
    thumbnailUrl: string
  }): { ok: true; profile: PlayerPublicProfileSnapshot } | { ok: false; message: string } {
    if (getPublicProfile(input.profileId) === null) {
      return {
        ok: false,
        message: 'Профилът не беше намерен.',
      }
    }

    const nextSortOrderRow = selectNextGallerySortOrderStatement.get(
      input.profileId,
    ) as { next_sort_order: number } | undefined

    insertProfileGalleryImageStatement.run(
      input.imageId,
      input.profileId,
      input.imageUrl,
      input.thumbnailUrl,
      nextSortOrderRow?.next_sort_order ?? 0,
    )

    const profile = getPublicProfile(input.profileId)

    if (profile === null) {
      return {
        ok: false,
        message: 'Профилът не беше намерен.',
      }
    }

    return {
      ok: true,
      profile,
    }
  }

  function deleteProfileGalleryImage(
    profileId: ProfileId,
    imageId: string,
  ):
    | {
        ok: true
        profile: PlayerPublicProfileSnapshot
        deletedImageUrls: string[]
      }
    | { ok: false; message: string } {
    const existingImage = selectProfileGalleryImageStatement.get(
      profileId,
      imageId,
    ) as
      | {
          image_url: string
          thumbnail_url: string
        }
      | undefined

    if (!existingImage) {
      return {
        ok: false,
        message: 'Снимката не беше намерена.',
      }
    }

    deleteProfileGalleryImageStatement.run(profileId, imageId)

    const profile = getPublicProfile(profileId)

    if (profile === null) {
      return {
        ok: false,
        message: 'Профилът не беше намерен.',
      }
    }

    return {
      ok: true,
      profile,
      deletedImageUrls: [
        existingImage.image_url,
        existingImage.thumbnail_url,
      ].filter((url, index, urls) => url.trim().length > 0 && urls.indexOf(url) === index),
    }
  }

  function incrementCompletedGame(
    profileId: ProfileId,
    didWin: boolean,
  ): void {
    ensureProgressStatement.run(profileId)

    const row = selectProgressStatement.get(profileId) as
      | { completed_games_count: number; won_games_count: number }
      | undefined
    const completedGamesCount = (row?.completed_games_count ?? 0) + 1
    const wonGamesCount = (row?.won_games_count ?? 0) + (didWin ? 1 : 0)
    const rankLevel = createRankProgressSnapshot(completedGamesCount).rankLevel

    updateProgressStatement.run(
      completedGamesCount,
      wonGamesCount,
      rankLevel,
      profileId,
    )
    updateProfileRankStatement.run(rankLevel, getRankTitleForLevel(rankLevel), profileId)
  }

  function getParticipantSkillRating(participant: ServerRoom['seats'][Seat]['participant']): number {
    if (participant === null) return 1000
    if (participant.kind === 'bot') return participant.identity.skillRating ?? 1000
    const profileId = getParticipantProfileId(participant)
    if (profileId === null) return 1000
    const row = selectSkillRatingStatement.get(profileId) as { skill_rating: number } | undefined
    return row?.skill_rating ?? 1000
  }

  function recordCompletedMatch(room: ServerRoom): void {
    const matchEnded = getRuntimeMatchEnded(room)

    if (matchEnded === null) {
      return
    }

    // Collect ratings per team for ELO calculation
    const teamRatings: Record<'A' | 'B', number[]> = { A: [], B: [] }
    for (const seat of SERVER_SEAT_ORDER) {
      const participant = room.seats[seat].participant
      if (participant === null) continue
      const team = getTeamBySeat(seat)
      teamRatings[team].push(getParticipantSkillRating(participant))
    }
    const avgA = teamRatings.A.length > 0 ? teamRatings.A.reduce((s, r) => s + r, 0) / teamRatings.A.length : 1000
    const avgB = teamRatings.B.length > 0 ? teamRatings.B.reduce((s, r) => s + r, 0) / teamRatings.B.length : 1000

    for (const seat of SERVER_SEAT_ORDER) {
      const participant = room.seats[seat].participant

      if (participant === null) {
        continue
      }

      const profileId =
        participant.kind === 'human'
          ? getParticipantProfileId(participant)
          : (participant.botProfileId ?? null)

      if (profileId === null) {
        continue
      }

      const team = getTeamBySeat(seat)
      const didWin = team === matchEnded.winnerTeam
      const result = insertMatchResultStatement.run(
        room.id,
        profileId,
        team,
        didWin ? 1 : 0,
      ) as { changes?: number }

      if ((result.changes ?? 0) > 0) {
        incrementCompletedGame(profileId, didWin)

        if (participant.kind === 'human') {
          // Update ELO skill rating: individual vs opponent team average
          const opponentAvg = team === 'A' ? avgB : avgA
          const currentRating = getParticipantSkillRating(participant)
          const change = computeEloChange(currentRating, opponentAvg, didWin)
          const newRating = Math.max(100, currentRating + change)
          updateSkillRatingStatement.run(newRating, profileId)
        }
      }
    }
  }

  function refreshRatingAggregate(profileId: ProfileId): void {
    const row = selectRatingAggregateStatement.get(profileId) as
      | ProfileRatingRow
      | undefined
    const averageRating = row?.average_rating ?? 0
    const totalRatingsCount = row?.total_ratings_count ?? 0

    updateProfileRatingStatement.run(
      averageRating,
      totalRatingsCount,
      profileId,
    )
  }

  function submitPartnerRating(
    room: ServerRoom,
    raterSeat: Seat,
    ratingValue: number,
  ): { ok: true } | { ok: false; message: string } {
    if (getRuntimeMatchEnded(room) === null) {
      return {
        ok: false,
        message: 'Оценка може да се даде само след края на играта.',
      }
    }

    if (!Number.isInteger(ratingValue) || ratingValue < 1 || ratingValue > 6) {
      return {
        ok: false,
        message: 'Оценката трябва да е между 1 и 6.',
      }
    }

    const rater = room.seats[raterSeat]?.participant ?? null
    const partnerSeat = getPartnerSeat(raterSeat)
    const partner = room.seats[partnerSeat]?.participant ?? null
    const raterProfileId = getParticipantProfileId(rater)
    const partnerProfileId = getParticipantProfileId(partner)

    if (rater?.kind !== 'human' || raterProfileId === null) {
      return {
        ok: false,
        message: 'Твоят профил не е намерен.',
      }
    }

    if (partnerProfileId === null) {
      return {
        ok: false,
        message: 'Партньорът няма профил за оценяване.',
      }
    }

    const ratingRoomScope = `${room.id}:v${room.game.stateVersion}`

    try {
      insertPartnerRatingStatement.run(
        randomUUID(),
        ratingRoomScope,
        partnerProfileId,
        raterProfileId,
        ratingValue,
      )
    } catch {
      return {
        ok: false,
        message: 'Вече си оценил партньора за тази игра.',
      }
    }

    refreshRatingAggregate(partnerProfileId)

    return { ok: true }
  }

  function seedCatalogBotsIfNeeded(): void {
    const countRow = database.prepare(
      `SELECT COUNT(*) AS count FROM profiles WHERE profile_kind = 'bot'`,
    ).get() as { count: number }

    if (countRow.count >= 300) return

    const maleNames = ['Иван','Петър','Георги','Стефан','Антон','Борис','Мартин','Калин','Симон','Кирил','Радо','Веско','Митко','Христо','Тодор','Алекс','Виктор','Тошко','Данко','Ивайло']
    const femaleNames = ['Мария','Елена','Надя','Соня','Вера','Нора','Лора','Яна','Деси','Поли','Катя','Таня','Сара','Ева','Диана','Стела','Ани','Ина','Силвия','Биляна']

    const insertBotProfile = database.prepare(`
      INSERT OR IGNORE INTO profiles (
        profile_id, account_id, profile_kind, username, normalized_username,
        display_name, normalized_display_name, avatar_url,
        level, rank_title, skill_rating, gender, status
      ) VALUES (?, NULL, 'bot', NULL, NULL, ?, ?, NULL, 1, 'Ранг 1', 1000, ?, 'active')
    `)

    const insertBotWallet = database.prepare(`
      INSERT OR IGNORE INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 50000)
    `)

    const insertBotProgress = database.prepare(`
      INSERT OR IGNORE INTO profile_progress (
        profile_id, completed_games_count, won_games_count, rank_level
      ) VALUES (?, 0, 0, 1)
    `)

    const insertBotMetadata = database.prepare(`
      INSERT OR IGNORE INTO bot_metadata (
        profile_id, bot_code, logic_source, selection_weight,
        auto_refill_threshold, auto_refill_target_balance
      ) VALUES (?, ?, 'existing-core-v1', 10, 5000, 50000)
    `)

    function suffix(globalIndex: number): string {
      return String(10000 + ((globalIndex * 7919 + 11111) % 90000))
    }

    function generateBots(
      names: string[],
      gender: 'male' | 'female',
      profileIdPrefix: string,
      globalOffset: number,
    ): void {
      let botIndex = 0
      for (let nameIdx = 0; nameIdx < names.length; nameIdx++) {
        const count = nameIdx < 10 ? 8 : 7
        for (let variant = 0; variant < count; variant++) {
          const displayName = `${names[nameIdx]}${suffix(globalOffset + botIndex)}`
          const normalizedDisplayName = displayName.toLocaleLowerCase('bg-BG')
          const profileId = `${profileIdPrefix}${String(botIndex).padStart(3, '0')}`
          const botCode = `CATALOG_${profileId.toUpperCase().replace(/-/g, '_')}`
          insertBotProfile.run(profileId, displayName, normalizedDisplayName, gender)
          insertBotWallet.run(profileId)
          insertBotProgress.run(profileId)
          insertBotMetadata.run(profileId, botCode)
          botIndex++
        }
      }
    }

    database.exec('BEGIN;')
    try {
      generateBots(maleNames, 'male', 'bot-m-', 0)
      generateBots(femaleNames, 'female', 'bot-f-', 150)
      database.exec('COMMIT;')
      console.log('[catalog-bots] Seeded 300 catalog bot profiles.')
    } catch (error) {
      try { database.exec('ROLLBACK;') } catch { /* ignore */ }
      console.error('[catalog-bots] Seeding failed:', error)
    }
  }

  function refillCatalogBotWallets(): void {
    refillCatalogBotWalletsStatement.run()
  }

  function isDisplayNameAvailable(displayName: string): boolean {
    const normalized = normalizeProfileDisplayName(displayName)
    if (normalized === null) return false
    const row = selectProfileByNormalizedDisplayNameStatement.get(normalized)
    return row === undefined
  }

  function close(): void {
    database.close()
  }

  return {
    createTemporaryHumanProfile,
    getPublicProfile,
    listPublicHumanProfiles,
    listLeaderboards,
    changeProfileDisplayName,
    isDisplayNameAvailable,
    updateProfileAvatar,
    addProfileGalleryImage,
    deleteProfileGalleryImage,
    seedCatalogBotsIfNeeded,
    refillCatalogBotWallets,
    recordCompletedMatch,
    submitPartnerRating,
    close,
  }
}
