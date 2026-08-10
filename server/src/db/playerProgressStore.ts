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
import { BOT_CATALOG_DISPLAY_NAMES } from './botCatalogDisplayNames.js'
import {
  escapeSqlLikePattern,
  normalizeProfileDisplayName,
  validateProfileDisplayName,
  type ProfileIdentityValidationCode,
} from './normalizeProfileIdentityText.js'
import { createRankProgressSnapshot, getRankTitleForLevel, computeEloChange } from '../progression/rankProgression.js'
import { getSofiaDayBoundsUtc } from './sofiaDayBounds.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

type ProfileDisplayNameMutationError = {
  ok: false
  message: string
  code?: ProfileIdentityValidationCode
}

export type LeaderboardCategory = 'balance' | 'rank' | 'wins' | 'rating'

export type LeaderboardsSnapshot = Record<
  LeaderboardCategory,
  PlayerPublicProfileSnapshot[]
>

export type HumanProfileCountStats = {
  total: number
  today: number
  yesterday: number
}

export type PlayerProgressStore = {
  createTemporaryHumanProfile: (
    displayName: string,
    stableKey: string,
  ) => PlayerPublicProfileSnapshot
  createTemporaryBotProfile: (
    profileId: string,
    baseName: string,
    completedGamesCount: number,
    wonGamesCount: number,
  ) => PlayerPublicProfileSnapshot
  deleteTemporaryBotProfile: (profileId: string) => void
  cleanupAllTemporaryBotProfiles: () => number
  isTemporaryProfile: (profileId: string) => boolean
  getPublicProfile: (profileId: ProfileId) => PlayerPublicProfileSnapshot | null
  listPublicHumanProfiles: (onlineProfileIds?: Set<string>) => PlayerPublicProfileSnapshot[]
  searchPublicProfiles: (
    normalizedTerm: string,
    onlineProfileIds?: Set<string>,
  ) => PlayerPublicProfileSnapshot[]
  listEligibleProfileKinds: () => Array<{ profileId: string; isBot: boolean }>
  getProfileSnapshotsByIds: (
    profileIds: string[],
    onlineProfileIds?: Set<string>,
  ) => PlayerPublicProfileSnapshot[]
  listLeaderboards: () => LeaderboardsSnapshot
  changeProfileDisplayName: (
    profileId: ProfileId,
    displayName: string,
    priceAmount: number,
  ) => { ok: true; profile: PlayerPublicProfileSnapshot } | ProfileDisplayNameMutationError
  adminRenameProfileDisplayName: (
    profileId: ProfileId,
    displayName: string,
  ) => { ok: true; profile: PlayerPublicProfileSnapshot } | ProfileDisplayNameMutationError
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
  isDisplayNameAvailable: (displayName: string, excludedProfileId?: ProfileId | null) => boolean
  countHumanProfiles: (now?: Date) => HumanProfileCountStats
  getUserGamesPlayedStats: (now?: Date) => { today: number; yesterday: number }
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

function hashStableKeyToDigits(value: string): string {
  let hash = 2166136261

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return (hash >>> 0).toString(10).padStart(10, '0').slice(0, 10)
}

function createTemporaryGuestFallbackDisplayName(
  stableKey: string,
  profileId: string,
  attempt: number,
): string {
  const baseSuffix = hashStableKeyToDigits(`${stableKey}:${profileId}`)
  const suffix = attempt === 0 ? baseSuffix : `${baseSuffix}${attempt}`
  return `Гост ${suffix}`
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
    likesCount: null,
    hasLikedByMe: null,
    isBlockedByMe: null,
    isVip: null,
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

  const insertTemporaryBotProfileStatement = database.prepare(`
    INSERT OR IGNORE INTO profiles (
      profile_id, account_id, profile_kind, username, normalized_username,
      display_name, normalized_display_name, avatar_url,
      level, rank_title, skill_rating, status, is_temporary
    ) VALUES (
      ?, NULL, 'bot', NULL, NULL,
      ?, ?, NULL,
      7, 'Новак', 1000, 'active', 1
    )
  `)

  const insertTemporaryBotWalletStatement = database.prepare(`
    INSERT OR IGNORE INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 55000)
  `)

  const insertTemporaryBotProgressStatement = database.prepare(`
    INSERT OR IGNORE INTO profile_progress (
      profile_id, completed_games_count, won_games_count, rank_level
    ) VALUES (?, ?, ?, 7)
  `)

  const deleteTemporaryBotStatement = database.prepare(`
    DELETE FROM profiles WHERE profile_id = ? AND is_temporary = 1
  `)

  const cleanupAllTemporaryBotsStatement = database.prepare(`
    DELETE FROM profiles WHERE is_temporary = 1
  `)

  const isTemporaryProfileStatement = database.prepare(`
    SELECT is_temporary FROM profiles WHERE profile_id = ? LIMIT 1
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
      AND p.is_temporary = 0
      AND (
        (p.profile_kind = 'human' AND p.account_id IS NOT NULL)
        OR p.profile_kind = 'bot'
      )
    ORDER BY p.updated_at DESC, p.created_at DESC
    LIMIT 500;
  `)

  // Отделен search statement — не наследява LIMIT 500 на browse списъка.
  // Проверява ВСИЧКИ допустими профили (същия WHERE филтър), за да могат
  // резултати извън първите 500 (по updated_at/created_at) да се намират.
  const searchPublicProfilesStatement = database.prepare(`
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
      AND p.is_temporary = 0
      AND (
        (p.profile_kind = 'human' AND p.account_id IS NOT NULL)
        OR p.profile_kind = 'bot'
      )
      AND p.normalized_display_name LIKE ? ESCAPE '\\'
    ORDER BY
      CASE
        WHEN p.normalized_display_name = ? THEN 0
        WHEN p.normalized_display_name LIKE ? ESCAPE '\\' THEN 1
        ELSE 2
      END,
      p.normalized_display_name ASC,
      p.profile_id ASC
    LIMIT 50;
  `)

  // Лек statement (без joins/LIMIT) за server-side pagination на players
  // директорията — връща ID + категория за ВСИЧКИ допустими профили, за да
  // може подредбата (seeded shuffle + admin bucketing) да покрие всички,
  // не само първите 500. Пълните данни (wallet/progress/gallery) се теглят
  // отделно, само за profileId-тата от текущата заявена страница.
  const listEligibleProfileKindsStatement = database.prepare(`
    SELECT p.profile_id, p.profile_kind
    FROM profiles p
    WHERE p.status = 'active'
      AND p.is_temporary = 0
      AND (
        (p.profile_kind = 'human' AND p.account_id IS NOT NULL)
        OR p.profile_kind = 'bot'
      );
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
      AND p.is_temporary = 0
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
      AND p.is_temporary = 0
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
      AND p.is_temporary = 0
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
      AND p.is_temporary = 0
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
      WHERE profile_kind = 'bot' AND status = 'active' AND is_temporary = 0
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

  const selectProfileByReservedIdentityNameStatement = database.prepare(`
    SELECT profile_id
    FROM profiles
    WHERE status = 'active'
      AND (
        normalized_display_name = ?
        OR normalized_username = ?
      )
      AND (? IS NULL OR profile_id <> ?)
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

  // username/normalized_username се записват еднократно при регистрация
  // (authStore.register) като snapshot на първоначалното display name — ако
  // тук не се обновят заедно с display_name/normalized_display_name, старото
  // име остава завинаги "заето" в normalized_username (виж
  // selectProfileByReservedIdentityNameStatement по-долу, която проверява
  // И двете колони), макар вече никой активен профил да не го показва.
  // Държейки username синхронизиран с текущото display name при всяка смяна,
  // UNIQUE(normalized_username) продължава да пази текущото име, но старото
  // веднага се освобождава за нов собственик.
  const updateProfileDisplayNameStatement = database.prepare(`
    UPDATE profiles
    SET
      display_name = ?,
      normalized_display_name = ?,
      username = ?,
      normalized_username = ?,
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
      did_win,
      is_guest_trial
    ) VALUES (
      ?,
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
    const publicNameResult = validateProfileDisplayName(displayName)
    let publicDisplayName = publicNameResult.ok ? publicNameResult.canonicalDisplayName : ''
    let normalizedDisplayName = publicNameResult.ok ? publicNameResult.normalizedKey : null

    if (
      normalizedDisplayName === null ||
      !isReservedIdentityNameAvailable(normalizedDisplayName, profileId)
    ) {
      publicDisplayName = ''
      normalizedDisplayName = null

      for (let attempt = 0; attempt < 20; attempt++) {
        const candidate = validateProfileDisplayName(
          createTemporaryGuestFallbackDisplayName(stableKey, profileId, attempt),
        )

        if (
          candidate.ok &&
          isReservedIdentityNameAvailable(candidate.normalizedKey, profileId)
        ) {
          publicDisplayName = candidate.canonicalDisplayName
          normalizedDisplayName = candidate.normalizedKey
          break
        }
      }
    }

    if (normalizedDisplayName === null || publicDisplayName.length === 0) {
      throw new Error(`Temporary profile "${profileId}" could not reserve a display name.`)
    }

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

  function createTemporaryBotProfile(
    profileId: string,
    baseName: string,
    completedGamesCount: number,
    wonGamesCount: number,
  ): PlayerPublicProfileSnapshot {
    let displayName: string
    let normalizedDisplayName: string
    let attempts = 0
    do {
      const suffix = 100000 + Math.floor(Math.random() * 900000)
      displayName = `${baseName} ${suffix}`
      normalizedDisplayName = displayName.toLocaleLowerCase('bg-BG')
      attempts++
    } while (!isDisplayNameAvailable(displayName) && attempts < 20)

    insertTemporaryBotProfileStatement.run(profileId, displayName, normalizedDisplayName)
    insertTemporaryBotWalletStatement.run(profileId)
    insertTemporaryBotProgressStatement.run(profileId, completedGamesCount, wonGamesCount)

    const row = selectPublicProfileStatement.get(profileId) as
      | Parameters<typeof toPublicProfileSnapshot>[0]
      | undefined

    if (!row) {
      throw new Error(`Temporary bot profile "${profileId}" was not created.`)
    }

    return toPublicProfileSnapshot(row, [])
  }

  function deleteTemporaryBotProfile(profileId: string): void {
    deleteTemporaryBotStatement.run(profileId)
  }

  function cleanupAllTemporaryBotProfiles(): number {
    const result = cleanupAllTemporaryBotsStatement.run()
    return result.changes as number
  }

  function isTemporaryProfile(profileId: string): boolean {
    const row = isTemporaryProfileStatement.get(profileId) as { is_temporary: number } | undefined
    return (row?.is_temporary ?? 0) === 1
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

  function mapProfileRowsToSnapshots(
    rows: Array<Parameters<typeof toPublicProfileSnapshot>[0] & { profile_kind: string }>,
    onlineProfileIds?: Set<string>,
  ): PlayerPublicProfileSnapshot[] {
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

  function listPublicHumanProfiles(onlineProfileIds?: Set<string>): PlayerPublicProfileSnapshot[] {
    const rows = listPublicHumanProfilesStatement.all() as Array<
      Parameters<typeof toPublicProfileSnapshot>[0] & { profile_kind: string }
    >

    return mapProfileRowsToSnapshots(rows, onlineProfileIds)
  }

  function searchPublicProfiles(
    normalizedTerm: string,
    onlineProfileIds?: Set<string>,
  ): PlayerPublicProfileSnapshot[] {
    if (normalizedTerm.length === 0) {
      return []
    }

    const escapedTerm = escapeSqlLikePattern(normalizedTerm)
    const containsPattern = `%${escapedTerm}%`
    const prefixPattern = `${escapedTerm}%`

    const rows = searchPublicProfilesStatement.all(
      containsPattern,
      normalizedTerm,
      prefixPattern,
    ) as Array<Parameters<typeof toPublicProfileSnapshot>[0] & { profile_kind: string }>

    return mapProfileRowsToSnapshots(rows, onlineProfileIds)
  }

  function listEligibleProfileKinds(): Array<{ profileId: string; isBot: boolean }> {
    const rows = listEligibleProfileKindsStatement.all() as Array<{
      profile_id: string
      profile_kind: string
    }>
    return rows.map((row) => ({ profileId: row.profile_id, isBot: row.profile_kind === 'bot' }))
  }

  function getProfileSnapshotsByIds(
    profileIds: string[],
    onlineProfileIds?: Set<string>,
  ): PlayerPublicProfileSnapshot[] {
    if (profileIds.length === 0) {
      return []
    }

    // Динамична arity (варира по страница) — statement-ът се строи прясно
    // за тази заявка, не се кешира като останалите (фиксирани) statements.
    const placeholders = profileIds.map(() => '?').join(', ')
    const statement = database.prepare(`
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
        AND p.is_temporary = 0
        AND (
          (p.profile_kind = 'human' AND p.account_id IS NOT NULL)
          OR p.profile_kind = 'bot'
        )
        AND p.profile_id IN (${placeholders});
    `)

    const rows = statement.all(...profileIds) as Array<
      Parameters<typeof toPublicProfileSnapshot>[0] & { profile_kind: string }
    >

    const snapshots = mapProfileRowsToSnapshots(rows, onlineProfileIds)
    const byId = new Map(snapshots.map((s) => [s.profileId, s]))

    // IN (...) не гарантира ред — пресъздаваме точно подадения ред
    // (вече определен от computePlayersPageOrder + slice за страницата).
    return profileIds
      .map((id) => byId.get(id))
      .filter((s): s is PlayerPublicProfileSnapshot => s !== undefined)
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
  ): { ok: true; profile: PlayerPublicProfileSnapshot } | ProfileDisplayNameMutationError {
    const displayNameResult = validateProfileDisplayName(displayNameRaw, { profileId })

    if (!displayNameResult.ok) {
      return {
        ok: false,
        message: displayNameResult.message,
        code: displayNameResult.code,
      }
    }

    const displayName = displayNameResult.canonicalDisplayName
    const normalizedDisplayName = displayNameResult.normalizedKey

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

    if (normalizeProfileDisplayName(existingProfile.display_name, { profileId }) === normalizedDisplayName) {
      return {
        ok: false,
        message: 'Новото име трябва да е различно от текущото.',
      }
    }

    try {
      database.exec('BEGIN IMMEDIATE;')
      ensureWalletStatement.run(profileId)

      const nameConflict = selectProfileByReservedIdentityNameStatement.get(
        normalizedDisplayName,
        normalizedDisplayName,
        profileId,
        profileId,
      ) as { profile_id: string } | undefined

      if (nameConflict !== undefined) {
        database.exec('ROLLBACK;')
        return {
          ok: false,
          message: 'Това име вече е заето.',
        }
      }

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

      if (message.includes('normalized_display_name') || message.includes('normalized_username')) {
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

  function adminRenameProfileDisplayName(
    profileId: ProfileId,
    displayNameRaw: string,
  ): { ok: true; profile: PlayerPublicProfileSnapshot } | ProfileDisplayNameMutationError {
    const displayNameResult = validateProfileDisplayName(displayNameRaw, { profileId })

    if (!displayNameResult.ok) {
      return {
        ok: false,
        message: displayNameResult.message,
        code: displayNameResult.code,
      }
    }

    const displayName = displayNameResult.canonicalDisplayName
    const normalizedDisplayName = displayNameResult.normalizedKey

    const existingProfile = selectProfileDisplayNameStatement.get(profileId) as
      | { display_name: string }
      | undefined

    if (!existingProfile) {
      return { ok: false, message: 'Профилът не беше намерен.' }
    }

    if (normalizeProfileDisplayName(existingProfile.display_name, { profileId }) === normalizedDisplayName) {
      const profile = getPublicProfile(profileId)
      if (profile === null) return { ok: false, message: 'Профилът не беше намерен.' }
      return { ok: true, profile }
    }

    const nameConflict = selectProfileByReservedIdentityNameStatement.get(
      normalizedDisplayName,
      normalizedDisplayName,
      profileId,
      profileId,
    ) as { profile_id: string } | undefined

    if (nameConflict !== undefined) {
      return { ok: false, message: 'Това име вече е заето.' }
    }

    try {
      const updateResult = updateProfileDisplayNameStatement.run(
        displayName,
        normalizedDisplayName,
        displayName,
        normalizedDisplayName,
        profileId,
      ) as { changes?: number }

      if ((updateResult.changes ?? 0) === 0) {
        return { ok: false, message: 'Профилът не беше намерен.' }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('normalized_display_name') || message.includes('normalized_username')) {
        return { ok: false, message: 'Това име вече е заето.' }
      }
      throw error
    }

    const profile = getPublicProfile(profileId)
    if (profile === null) {
      return { ok: false, message: 'Профилът не беше намерен.' }
    }
    return { ok: true, profile }
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

    // Collect ratings per team for ELO — exclude temporary bots (fake rating)
    const teamRatings: Record<'A' | 'B', number[]> = { A: [], B: [] }
    for (const seat of SERVER_SEAT_ORDER) {
      const participant = room.seats[seat].participant
      if (participant === null) continue
      if (participant.kind === 'bot' && participant.botProfileId?.startsWith('temp-bot-')) continue
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

      if (profileId.startsWith('temp-bot-')) {
        continue
      }

      const team = getTeamBySeat(seat)
      const didWin = team === matchEnded.winnerTeam
      const result = insertMatchResultStatement.run(
        room.id,
        profileId,
        team,
        didWin ? 1 : 0,
        room.config.isGuestTrial ? 1 : 0,
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

  function countHumanProfiles(now: Date = new Date()): HumanProfileCountStats {
    const total = (database.prepare(
      `SELECT COUNT(*) AS count FROM profiles WHERE profile_kind = 'human'`,
    ).get() as { count: number }).count

    const bounds = getSofiaDayBoundsUtc(now)
    const countCreatedInRange = (start: string, end: string): number => {
      const row = database.prepare(
        `SELECT COUNT(*) AS count FROM profiles WHERE profile_kind = 'human' AND created_at >= ? AND created_at < ?`,
      ).get(start, end) as { count: number }
      return row.count
    }

    return {
      total,
      today: countCreatedInRange(bounds.todayStart, bounds.tomorrowStart),
      yesterday: countCreatedInRange(bounds.yesterdayStart, bounds.todayStart),
    }
  }

  function getUserGamesPlayedStats(now: Date = new Date()): { today: number; yesterday: number } {
    const bounds = getSofiaDayBoundsUtc(now)
    const countCompletedInRange = (start: string, end: string): number => {
      const row = database.prepare(
        `SELECT COUNT(DISTINCT room_id) AS count
         FROM profile_match_results
         WHERE is_guest_trial = 0
           AND completed_at >= ?
           AND completed_at < ?`,
      ).get(start, end) as { count: number }
      return row.count
    }

    return {
      today: countCompletedInRange(bounds.todayStart, bounds.tomorrowStart),
      yesterday: countCompletedInRange(bounds.yesterdayStart, bounds.todayStart),
    }
  }

  function seedCatalogBotsIfNeeded(): void {
    const countRow = database.prepare(
      `SELECT COUNT(*) AS count FROM profiles WHERE profile_kind = 'bot'`,
    ).get() as { count: number }

    if (countRow.count >= 300) return

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

    function generateBots(
      gender: 'male' | 'female',
      profileIdPrefix: string,
    ): void {
      for (let botIndex = 0; botIndex < 150; botIndex++) {
        const profileId = `${profileIdPrefix}${String(botIndex).padStart(3, '0')}`
        const displayName = BOT_CATALOG_DISPLAY_NAMES[profileId]

        if (!displayName) {
          throw new Error(`Missing catalog display name for bot profile "${profileId}".`)
        }

        const normalizedDisplayName = displayName.toLocaleLowerCase('bg-BG')
        const botCode = `CATALOG_${profileId.toUpperCase().replace(/-/g, '_')}`
        insertBotProfile.run(profileId, displayName, normalizedDisplayName, gender)
        insertBotWallet.run(profileId)
        insertBotProgress.run(profileId)
        insertBotMetadata.run(profileId, botCode)
      }
    }

    database.exec('BEGIN;')
    try {
      generateBots('male', 'bot-m-')
      generateBots('female', 'bot-f-')
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

  function isReservedIdentityNameAvailable(
    normalizedName: string,
    excludedProfileId: ProfileId | null,
  ): boolean {
    const row = selectProfileByReservedIdentityNameStatement.get(
      normalizedName,
      normalizedName,
      excludedProfileId,
      excludedProfileId,
    )
    return row === undefined
  }

  function isDisplayNameAvailable(
    displayName: string,
    excludedProfileId: ProfileId | null = null,
  ): boolean {
    const normalized = normalizeProfileDisplayName(displayName, { profileId: excludedProfileId })
    if (normalized === null) return false
    return isReservedIdentityNameAvailable(normalized, excludedProfileId)
  }

  function close(): void {
    database.close()
  }

  return {
    createTemporaryHumanProfile,
    createTemporaryBotProfile,
    deleteTemporaryBotProfile,
    cleanupAllTemporaryBotProfiles,
    isTemporaryProfile,
    getPublicProfile,
    listPublicHumanProfiles,
    searchPublicProfiles,
    listEligibleProfileKinds,
    getProfileSnapshotsByIds,
    listLeaderboards,
    changeProfileDisplayName,
    adminRenameProfileDisplayName,
    isDisplayNameAvailable,
    countHumanProfiles,
    getUserGamesPlayedStats,
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
