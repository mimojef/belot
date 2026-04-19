import { randomUUID } from 'node:crypto'
import {
  createBotIdentitySnapshot,
  getBotProfileByCode,
  getBotProfileById,
} from '../bots/botProfiles.js'
import type {
  BotBehaviorPreset,
  BotDifficulty,
  BotLogicSource,
  BotRoomParticipant,
  PlayerId,
  PlayerIdentitySnapshot,
  PlayerPublicProfileSnapshot,
  ProfileId,
} from './serverTypes.js'

type CreateBotParticipantOptions = {
  playerId?: PlayerId
  botProfileId?: ProfileId
  botCode?: string
  difficulty?: BotDifficulty
  behaviorPreset?: BotBehaviorPreset
  logicSource?: BotLogicSource
  identity?: Partial<PlayerIdentitySnapshot>
  publicProfile?: Partial<PlayerPublicProfileSnapshot>
}

type BotProfilePublicData = {
  profileId?: ProfileId | null
  averageRating?: number | null
  totalRatingsCount?: number | null
  yellowCoinsBalance?: number | null
  galleryImages?: Array<{
    imageId?: string | null
    imageUrl?: string | null
    sortOrder?: number | null
  }>
  galleryImageUrls?: string[]
}

function createDefaultBotIdentity(botCode: string): PlayerIdentitySnapshot {
  return {
    accountId: null,
    profileId: null,
    username: botCode.toLowerCase().replace(/\s+/g, '_'),
    displayName: botCode,
    avatarUrl: null,
    level: null,
    rankTitle: null,
    skillRating: null,
  }
}

function normalizeNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeNullableCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }

  return Math.max(0, Math.trunc(value))
}

function normalizeGalleryImages(
  source: BotProfilePublicData | null,
): PlayerPublicProfileSnapshot['galleryImages'] {
  if (!source) {
    return []
  }

  if (Array.isArray(source.galleryImages) && source.galleryImages.length > 0) {
    return source.galleryImages.flatMap((image, index) => {
      const imageUrl =
        typeof image?.imageUrl === 'string' ? image.imageUrl.trim() : ''

      if (!imageUrl) {
        return []
      }

      const imageId =
        typeof image?.imageId === 'string' && image.imageId.trim()
          ? image.imageId.trim()
          : `bot-gallery-${index + 1}`

      const sortOrder =
        typeof image?.sortOrder === 'number' && Number.isFinite(image.sortOrder)
          ? image.sortOrder
          : index

      return [
        {
          imageId,
          imageUrl,
          sortOrder,
        },
      ]
    })
  }

  if (Array.isArray(source.galleryImageUrls) && source.galleryImageUrls.length > 0) {
    return source.galleryImageUrls.flatMap((imageUrl, index) => {
      const normalizedUrl = typeof imageUrl === 'string' ? imageUrl.trim() : ''

      if (!normalizedUrl) {
        return []
      }

      return [
        {
          imageId: `bot-gallery-${index + 1}`,
          imageUrl: normalizedUrl,
          sortOrder: index,
        },
      ]
    })
  }

  return []
}

function createBotPublicProfileSnapshot(
  identity: PlayerIdentitySnapshot,
  source: BotProfilePublicData | null,
): PlayerPublicProfileSnapshot {
  return {
    profileId: identity.profileId ?? source?.profileId ?? null,
    displayName: identity.displayName,
    avatarUrl: identity.avatarUrl,
    level: identity.level,
    rankTitle: identity.rankTitle,
    skillRating: identity.skillRating,
    averageRating: normalizeNullableNumber(source?.averageRating),
    totalRatingsCount: normalizeNullableCount(source?.totalRatingsCount),
    yellowCoinsBalance: normalizeNullableCount(source?.yellowCoinsBalance),
    galleryImages: normalizeGalleryImages(source),
  }
}

export function createBotParticipant(
  options: CreateBotParticipantOptions = {},
): BotRoomParticipant {
  const now = Date.now()
  const profile =
    (options.botProfileId ? getBotProfileById(options.botProfileId) : null) ??
    (options.botCode ? getBotProfileByCode(options.botCode) : null)

  const botCode = profile?.code ?? options.botCode ?? 'BOT'
  const difficulty = options.difficulty ?? profile?.difficulty ?? 'normal'
  const behaviorPreset =
    options.behaviorPreset ?? profile?.behaviorPreset ?? 'balanced'
  const logicSource =
    options.logicSource ?? profile?.logicSource ?? 'existing-core-v1'
  const identityBase = profile
    ? createBotIdentitySnapshot(profile)
    : createDefaultBotIdentity(botCode)

  const mergedIdentity: PlayerIdentitySnapshot = {
    ...identityBase,
    ...options.identity,
  }

  const publicProfileSource = (profile ?? null) as BotProfilePublicData | null
  const publicProfileBase = createBotPublicProfileSnapshot(
    mergedIdentity,
    publicProfileSource,
  )

  return {
    kind: 'bot',
    playerId: options.playerId ?? randomUUID(),
    joinedAt: now,
    botCode,
    difficulty,
    botProfileId: profile?.profileId,
    behaviorPreset,
    logicSource,
    identity: mergedIdentity,
    publicProfile: {
      ...publicProfileBase,
      ...options.publicProfile,
      galleryImages:
        options.publicProfile?.galleryImages ?? publicProfileBase.galleryImages,
    },
  }
}