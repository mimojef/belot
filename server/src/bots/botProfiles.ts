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

const BOT_PROFILE_SEED: readonly BotProfileRecord[] = [] as const

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
    gender: null,
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
