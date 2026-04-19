import type {
  BotDifficulty,
  PlayerIdentitySnapshot,
  ProfileId,
} from '../core/serverTypes.js'
import type { MatchStake } from '../matchmaking/matchmakingTypes.js'

export type BotBehaviorPreset =
  | 'balanced'
  | 'aggressive'
  | 'conservative'
  | 'supportive'

export type BotLogicSource = 'existing-core-v1'
export type BotProfileStatus = 'active' | 'disabled'

export type BotProfileIdentity = {
  profileId: ProfileId
  username: string
  displayName: string
  avatarUrl: string | null
  level: number
  rankTitle: string
  skillRating: number
}

export type BotProfileRecord = {
  profileId: ProfileId
  code: string
  difficulty: BotDifficulty
  behaviorPreset: BotBehaviorPreset
  logicSource: BotLogicSource
  status: BotProfileStatus
  selectionWeight: number
  allowedStakes: readonly MatchStake[]
  identity: BotProfileIdentity
}

const ALL_MATCH_STAKES: readonly MatchStake[] = [5000, 8000, 10000, 15000, 20000]

const BOT_PROFILE_SEED: readonly BotProfileRecord[] = [
  {
    profileId: 'bot-profile-ivo-trifonov',
    code: 'BOT_IVO_TRIFONOV',
    difficulty: 'easy',
    behaviorPreset: 'balanced',
    logicSource: 'existing-core-v1',
    status: 'active',
    selectionWeight: 10,
    allowedStakes: [5000, 8000],
    identity: {
      profileId: 'bot-profile-ivo-trifonov',
      username: 'ivo.trifonov.bot',
      displayName: 'Иво Трифонов',
      avatarUrl: null,
      level: 6,
      rankTitle: 'Новак',
      skillRating: 1080,
    },
  },
  {
    profileId: 'bot-profile-raya-dobreva',
    code: 'BOT_RAYA_DOBREVA',
    difficulty: 'easy',
    behaviorPreset: 'supportive',
    logicSource: 'existing-core-v1',
    status: 'active',
    selectionWeight: 9,
    allowedStakes: [5000, 8000],
    identity: {
      profileId: 'bot-profile-raya-dobreva',
      username: 'raya.dobreva.bot',
      displayName: 'Рая Добрева',
      avatarUrl: null,
      level: 7,
      rankTitle: 'Новак',
      skillRating: 1115,
    },
  },
  {
    profileId: 'bot-profile-martin-petrov',
    code: 'BOT_MARTIN_PETROV',
    difficulty: 'normal',
    behaviorPreset: 'balanced',
    logicSource: 'existing-core-v1',
    status: 'active',
    selectionWeight: 12,
    allowedStakes: ALL_MATCH_STAKES,
    identity: {
      profileId: 'bot-profile-martin-petrov',
      username: 'martin.petrov.bot',
      displayName: 'Мартин Петров',
      avatarUrl: null,
      level: 12,
      rankTitle: 'Любител',
      skillRating: 1240,
    },
  },
  {
    profileId: 'bot-profile-denitsa-ilieva',
    code: 'BOT_DENITSA_ILIEVA',
    difficulty: 'normal',
    behaviorPreset: 'conservative',
    logicSource: 'existing-core-v1',
    status: 'active',
    selectionWeight: 11,
    allowedStakes: ALL_MATCH_STAKES,
    identity: {
      profileId: 'bot-profile-denitsa-ilieva',
      username: 'denitsa.ilieva.bot',
      displayName: 'Деница Илиева',
      avatarUrl: null,
      level: 14,
      rankTitle: 'Любител',
      skillRating: 1285,
    },
  },
  {
    profileId: 'bot-profile-simeon-kolev',
    code: 'BOT_SIMEON_KOLEV',
    difficulty: 'normal',
    behaviorPreset: 'aggressive',
    logicSource: 'existing-core-v1',
    status: 'active',
    selectionWeight: 10,
    allowedStakes: [8000, 10000, 15000, 20000],
    identity: {
      profileId: 'bot-profile-simeon-kolev',
      username: 'simeon.kolev.bot',
      displayName: 'Симеон Колев',
      avatarUrl: null,
      level: 16,
      rankTitle: 'Напреднал',
      skillRating: 1340,
    },
  },
  {
    profileId: 'bot-profile-teodora-yaneva',
    code: 'BOT_TEODORA_YANEVA',
    difficulty: 'normal',
    behaviorPreset: 'supportive',
    logicSource: 'existing-core-v1',
    status: 'active',
    selectionWeight: 10,
    allowedStakes: [8000, 10000, 15000, 20000],
    identity: {
      profileId: 'bot-profile-teodora-yaneva',
      username: 'teodora.yaneva.bot',
      displayName: 'Теодора Янева',
      avatarUrl: null,
      level: 17,
      rankTitle: 'Напреднал',
      skillRating: 1365,
    },
  },
  {
    profileId: 'bot-profile-kalin-georgiev',
    code: 'BOT_KALIN_GEORGIEV',
    difficulty: 'hard',
    behaviorPreset: 'aggressive',
    logicSource: 'existing-core-v1',
    status: 'active',
    selectionWeight: 8,
    allowedStakes: [10000, 15000, 20000],
    identity: {
      profileId: 'bot-profile-kalin-georgiev',
      username: 'kalin.georgiev.bot',
      displayName: 'Калин Георгиев',
      avatarUrl: null,
      level: 22,
      rankTitle: 'Майстор',
      skillRating: 1475,
    },
  },
  {
    profileId: 'bot-profile-vesela-ruseva',
    code: 'BOT_VESELA_RUSEVA',
    difficulty: 'hard',
    behaviorPreset: 'balanced',
    logicSource: 'existing-core-v1',
    status: 'active',
    selectionWeight: 8,
    allowedStakes: [10000, 15000, 20000],
    identity: {
      profileId: 'bot-profile-vesela-ruseva',
      username: 'vesela.ruseva.bot',
      displayName: 'Весела Русева',
      avatarUrl: null,
      level: 24,
      rankTitle: 'Майстор',
      skillRating: 1510,
    },
  },
] as const

export function getBotProfilesCatalog(): readonly BotProfileRecord[] {
  return BOT_PROFILE_SEED
}

export function getBotProfileById(profileId: ProfileId): BotProfileRecord | null {
  return BOT_PROFILE_SEED.find((profile) => profile.profileId === profileId) ?? null
}

export function getBotProfileByCode(code: string): BotProfileRecord | null {
  return BOT_PROFILE_SEED.find((profile) => profile.code === code) ?? null
}

export function isBotProfileEligibleForStake(
  profile: BotProfileRecord,
  stake: MatchStake,
): boolean {
  return profile.status === 'active' && profile.allowedStakes.includes(stake)
}

export function getEligibleBotProfiles(stake: MatchStake): BotProfileRecord[] {
  return BOT_PROFILE_SEED.filter((profile) => isBotProfileEligibleForStake(profile, stake))
}

export function createBotIdentitySnapshot(
  profile: BotProfileRecord,
): PlayerIdentitySnapshot {
  return {
    accountId: null,
    profileId: profile.profileId,
    username: profile.identity.username,
    displayName: profile.identity.displayName,
    avatarUrl: profile.identity.avatarUrl,
    level: profile.identity.level,
    rankTitle: profile.identity.rankTitle,
    skillRating: profile.identity.skillRating,
  }
}

export function pickRandomBotProfile(
  stake: MatchStake,
  excludedProfileIds: readonly ProfileId[] = [],
): BotProfileRecord | null {
  const eligibleProfiles = getEligibleBotProfiles(stake).filter(
    (profile) => !excludedProfileIds.includes(profile.profileId),
  )

  if (eligibleProfiles.length === 0) {
    return null
  }

  const totalWeight = eligibleProfiles.reduce(
    (sum, profile) => sum + profile.selectionWeight,
    0,
  )

  if (totalWeight <= 0) {
    return eligibleProfiles[0] ?? null
  }

  let roll = Math.random() * totalWeight

  for (const profile of eligibleProfiles) {
    roll -= profile.selectionWeight

    if (roll <= 0) {
      return profile
    }
  }

  return eligibleProfiles[eligibleProfiles.length - 1] ?? null
}
