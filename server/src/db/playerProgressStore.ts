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
import { createRankProgressSnapshot } from '../progression/rankProgression.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type PlayerProgressStore = {
  createTemporaryHumanProfile: (
    displayName: string,
    stableKey: string,
  ) => PlayerPublicProfileSnapshot
  getPublicProfile: (profileId: ProfileId) => PlayerPublicProfileSnapshot | null
  listPublicHumanProfiles: () => PlayerPublicProfileSnapshot[]
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
}, galleryImages: ProfileGalleryImageRow[] = []): PlayerPublicProfileSnapshot {
  const rankProgress = createRankProgressSnapshot(row.completed_games_count ?? 0)

  return {
    profileId: row.profile_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    level: rankProgress.rankLevel || row.level,
    rankTitle: row.rank_title ?? `Ранг ${rankProgress.rankLevel}`,
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
      p.display_name,
      p.avatar_url,
      p.level,
      p.rank_title,
      p.skill_rating,
      p.average_rating,
      p.total_ratings_count,
      COALESCE(pw.yellow_coins_balance, 0) AS yellow_coins_balance
      ,
      pp.completed_games_count,
      pp.won_games_count
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
      p.display_name,
      p.avatar_url,
      p.level,
      p.rank_title,
      p.skill_rating,
      p.average_rating,
      p.total_ratings_count,
      COALESCE(pw.yellow_coins_balance, 0) AS yellow_coins_balance
      ,
      pp.completed_games_count,
      pp.won_games_count
    FROM profiles p
    LEFT JOIN profile_wallets pw
      ON pw.profile_id = p.profile_id
    LEFT JOIN profile_progress pp
      ON pp.profile_id = p.profile_id
    WHERE p.profile_kind = 'human'
      AND p.status = 'active'
      AND p.account_id IS NOT NULL
    ORDER BY p.updated_at DESC, p.created_at DESC
    LIMIT 200;
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

  function listPublicHumanProfiles(): PlayerPublicProfileSnapshot[] {
    const rows = listPublicHumanProfilesStatement.all() as Array<
      Parameters<typeof toPublicProfileSnapshot>[0]
    >

    return rows.map((row) => {
      const galleryImages = selectProfileGalleryImagesStatement.all(
        row.profile_id,
      ) as ProfileGalleryImageRow[]

      return toPublicProfileSnapshot(row, galleryImages)
    })
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
    updateProfileRankStatement.run(rankLevel, `Ранг ${rankLevel}`, profileId)
  }

  function recordCompletedMatch(room: ServerRoom): void {
    const matchEnded = getRuntimeMatchEnded(room)

    if (matchEnded === null) {
      return
    }

    for (const seat of SERVER_SEAT_ORDER) {
      const participant = room.seats[seat].participant

      if (participant?.kind !== 'human') {
        continue
      }

      const profileId = getParticipantProfileId(participant)

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

    if (partner?.kind !== 'human' || partnerProfileId === null) {
      return {
        ok: false,
        message: 'Партньорът няма профил за оценяване.',
      }
    }

    try {
      insertPartnerRatingStatement.run(
        randomUUID(),
        room.id,
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

  function close(): void {
    database.close()
  }

  return {
    createTemporaryHumanProfile,
    getPublicProfile,
    listPublicHumanProfiles,
    updateProfileAvatar,
    addProfileGalleryImage,
    deleteProfileGalleryImage,
    recordCompletedMatch,
    submitPartnerRating,
    close,
  }
}
