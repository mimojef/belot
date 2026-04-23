import {
  createBotIdentitySnapshot,
  getEligibleBotProfiles,
  type BotProfileRecord,
} from '../bots/botProfiles.js'
import type {
  BotBehaviorPreset,
  BotDifficulty,
  BotLogicSource,
  PlayerIdentitySnapshot,
  ProfileId,
} from '../core/serverTypes.js'
import {
  listEligibleBotProfilesFromDb,
  type DbEligibleBotProfile,
} from '../db/pickEligibleBotProfileFromDb.js'
import type { MatchStake, MatchmakingQueueEntry } from './matchmakingTypes.js'

type WeightedSelectionCandidate = {
  selectionWeight: number
}

export type MatchmakingBotSelectionProfile = {
  profileId: ProfileId | null
  code: string
  difficulty: BotDifficulty
  behaviorPreset: BotBehaviorPreset
  logicSource: BotLogicSource
  selectionWeight: number
  yellowCoinsBalance: number | null
  identity: PlayerIdentitySnapshot
}

type SelectMatchmakingBotProfilesOptions = {
  stake: MatchStake
  count: number
  selectionSeed: string
  excludedProfileIds?: readonly ProfileId[]
}

function hashStringToUint32(value: string): number {
  let hash = 2166136261

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return hash >>> 0
}

function createSeededRandom(seed: string): () => number {
  let state = hashStringToUint32(seed) || 0x9e3779b9

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state

    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

function pickWeightedIndex<T extends WeightedSelectionCandidate>(
  candidates: readonly T[],
  nextRandom: () => number,
): number {
  const totalWeight = candidates.reduce((sum, candidate) => {
    return sum + Math.max(0, Math.trunc(candidate.selectionWeight))
  }, 0)

  if (totalWeight <= 0) {
    return 0
  }

  let roll = nextRandom() * totalWeight

  for (let index = 0; index < candidates.length; index += 1) {
    roll -= Math.max(0, Math.trunc(candidates[index]?.selectionWeight ?? 0))

    if (roll <= 0) {
      return index
    }
  }

  return Math.max(0, candidates.length - 1)
}

function selectWithoutReplacement<T extends WeightedSelectionCandidate>(
  candidates: readonly T[],
  count: number,
  nextRandom: () => number,
): T[] {
  const pool = [...candidates]
  const selected: T[] = []

  while (pool.length > 0 && selected.length < count) {
    const selectedIndex = pickWeightedIndex(pool, nextRandom)
    const [pickedCandidate] = pool.splice(selectedIndex, 1)

    if (pickedCandidate) {
      selected.push(pickedCandidate)
    }
  }

  return selected
}

function mapCatalogProfile(
  profile: BotProfileRecord,
): MatchmakingBotSelectionProfile {
  return {
    profileId: profile.profileId,
    code: profile.code,
    difficulty: profile.difficulty,
    behaviorPreset: profile.behaviorPreset,
    logicSource: profile.logicSource,
    selectionWeight: profile.selectionWeight,
    yellowCoinsBalance: null,
    identity: createBotIdentitySnapshot(profile),
  }
}

function mapDbProfile(
  profile: DbEligibleBotProfile,
): MatchmakingBotSelectionProfile {
  return {
    profileId: profile.profileId,
    code: profile.code,
    difficulty: profile.difficulty,
    behaviorPreset: profile.behaviorPreset,
    logicSource: profile.logicSource,
    selectionWeight: profile.selectionWeight,
    yellowCoinsBalance: profile.yellowCoinsBalance,
    identity: profile.identity,
  }
}

export function createMatchmakingBotSelectionSeed(
  stake: MatchStake,
  entries: readonly Pick<MatchmakingQueueEntry, 'entryId' | 'joinedAt'>[],
): string {
  const orderedEntryIds = [...entries]
    .sort((first, second) => {
      return first.joinedAt - second.joinedAt || first.entryId.localeCompare(second.entryId)
    })
    .map((entry) => entry.entryId)
    .join('|')

  return `${stake}:${orderedEntryIds}`
}

export function selectMatchmakingBotProfiles(
  options: SelectMatchmakingBotProfilesOptions,
): MatchmakingBotSelectionProfile[] {
  const {
    stake,
    count,
    selectionSeed,
    excludedProfileIds = [],
  } = options
  const targetCount = Math.max(0, Math.trunc(count))

  if (targetCount === 0) {
    return []
  }

  const nextRandom = createSeededRandom(selectionSeed)
  const normalizedExcludedProfileIds = [...excludedProfileIds]
  const dbCandidates =
    listEligibleBotProfilesFromDb(stake, normalizedExcludedProfileIds)?.map(mapDbProfile) ?? []
  const selectedDbProfiles = selectWithoutReplacement(
    dbCandidates,
    targetCount,
    nextRandom,
  )

  if (selectedDbProfiles.length >= targetCount) {
    return selectedDbProfiles
  }

  const selectedProfileIds = new Set<ProfileId>(
    [...normalizedExcludedProfileIds, ...selectedDbProfiles]
      .flatMap((profile) => {
        if (typeof profile === 'string') {
          return [profile]
        }

        return profile.profileId ? [profile.profileId] : []
      }),
  )
  const fallbackCandidates = getEligibleBotProfiles(stake)
    .filter((profile) => !selectedProfileIds.has(profile.profileId))
    .map(mapCatalogProfile)
  const selectedFallbackProfiles = selectWithoutReplacement(
    fallbackCandidates,
    targetCount - selectedDbProfiles.length,
    nextRandom,
  )

  return [...selectedDbProfiles, ...selectedFallbackProfiles]
}
