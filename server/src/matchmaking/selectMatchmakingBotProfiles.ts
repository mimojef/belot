import { randomUUID } from 'node:crypto'
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
import { pickRandomTempBotName } from './temporaryBotNames.js'

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

export type TempBotFactory = (stake: MatchStake, profileId: string, baseName: string, completedGamesCount: number, wonGamesCount: number) => string | null

type SelectMatchmakingBotProfilesOptions = {
  stake: MatchStake
  count: number
  selectionSeed: string
  excludedProfileIds?: readonly ProfileId[]
  minLevel?: number
  createTempBot?: TempBotFactory
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

// Pure, side-effect-free fallback used only when no createTempBot factory is
// supplied (the matchmaking "preview" call sites — matchmaking_status,
// matchmaking_joined — which may fire repeatedly per queue entry while a
// player waits). Unlike the real room-creation createTempBot callback, this
// never touches the database: it derives a stable display name and a stable
// synthetic profileId purely from the seeded RNG, so the exact same
// (selectionSeed, index) input always yields the exact same output — no
// randomUUID(), no Math.random(), no temporary profile rows to clean up.
function createPreviewTempBotProfile(
  nextRandom: () => number,
  index: number,
): MatchmakingBotSelectionProfile {
  const baseName = pickRandomTempBotName(nextRandom)
  // Deterministic 6-digit suffix (mirrors the real createTemporaryBotProfile
  // display format "<Name> <suffix>") so preview names read the same as real
  // temp-bot names, without depending on Math.random() or DB uniqueness checks.
  const suffix = 100000 + Math.floor(nextRandom() * 900000)
  const displayName = `${baseName} ${suffix}`
  const profileId = `preview-bot-${index}-${suffix}`

  return {
    profileId,
    code: 'TEMP_BOT',
    difficulty: 'normal',
    behaviorPreset: 'balanced',
    logicSource: 'existing-core-v1',
    selectionWeight: 10,
    yellowCoinsBalance: 55000,
    identity: {
      accountId: null,
      profileId,
      username: null,
      displayName,
      avatarUrl: null,
      level: 7,
      rankTitle: 'Новак',
      skillRating: 1000,
      gender: null,
    },
  }
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
    minLevel = 1,
  } = options
  const targetCount = Math.max(0, Math.trunc(count))

  if (targetCount === 0) {
    return []
  }

  const nextRandom = createSeededRandom(selectionSeed)
  const normalizedExcludedProfileIds = [...excludedProfileIds]
  const dbCandidates =
    listEligibleBotProfilesFromDb(stake, normalizedExcludedProfileIds, minLevel)?.map(mapDbProfile) ?? []
  const selectedDbProfiles = selectWithoutReplacement(
    dbCandidates,
    targetCount,
    nextRandom,
  )

  if (selectedDbProfiles.length >= targetCount) {
    return selectedDbProfiles
  }

  if (process.env.BELOT_ALLOW_CATALOG_BOT_FALLBACK !== '1') {
    const needed = targetCount - selectedDbProfiles.length
    const tempProfiles: MatchmakingBotSelectionProfile[] = []

    if (options.createTempBot) {
      const createTempBot = options.createTempBot

      for (let i = 0; i < needed; i++) {
        const profileId = `temp-bot-${randomUUID()}`
        const baseName = pickRandomTempBotName(nextRandom)
        const completedGamesCount = 25 + Math.floor(nextRandom() * 5)
        const wonGamesCount = Math.round(completedGamesCount * (0.40 + nextRandom() * 0.10))
        const actualDisplayName = createTempBot(stake, profileId, baseName, completedGamesCount, wonGamesCount)

        if (!actualDisplayName) {
          continue
        }

        tempProfiles.push({
          profileId,
          code: 'TEMP_BOT',
          difficulty: 'normal',
          behaviorPreset: 'balanced',
          logicSource: 'existing-core-v1',
          selectionWeight: 10,
          yellowCoinsBalance: 55000,
          identity: {
            accountId: null,
            profileId,
            username: null,
            displayName: actualDisplayName,
            avatarUrl: null,
            level: 7,
            rankTitle: 'Новак',
            skillRating: 1000,
            gender: null,
          },
        })
      }
    } else {
      // Preview-only path (no real room is being created): no DB writes, no
      // randomUUID()/Math.random() — see createPreviewTempBotProfile above.
      for (let i = 0; i < needed; i++) {
        tempProfiles.push(createPreviewTempBotProfile(nextRandom, i))
      }
    }

    console.warn(
      `[matchmaking] Insufficient DB bots for stake ${stake}: ` +
      `requested ${targetCount}, got ${selectedDbProfiles.length}. ` +
      `Created ${tempProfiles.length} temporary bot(s).` +
      (tempProfiles.length < needed ? ` WARNING: ${needed - tempProfiles.length} slot(s) still unfilled.` : ''),
    )

    return [...selectedDbProfiles, ...tempProfiles]
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
