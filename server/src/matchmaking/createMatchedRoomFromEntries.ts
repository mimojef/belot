import { randomUUID } from 'node:crypto'
import { pickRandomBotProfile } from '../bots/botProfiles.js'
import { createBotParticipant } from '../core/createBotParticipant.js'
import { createHumanParticipant } from '../core/createHumanParticipant.js'
import { createServerRoom } from '../core/createServerRoom.js'
import { seatParticipantInRoom } from '../core/seatParticipantInRoom.js'
import {
  type BotRoomParticipant,
  type Seat,
  type ServerRoom,
} from '../core/serverTypes.js'
import { updateRoomHostPlayerId } from '../core/updateRoomHostPlayerId.js'
import type {
  MatchStake,
  MatchSeatAssignment,
  MatchmakingQueueEntry,
  PendingMatchGroup,
} from './matchmakingTypes.js'
import {
  createMatchmakingBotSelectionSeed,
  selectMatchmakingBotProfiles,
  type MatchmakingBotSelectionProfile,
  type TempBotFactory,
} from './selectMatchmakingBotProfiles.js'

export type CreateMatchedRoomFromEntriesResult = {
  room: ServerRoom
  group: PendingMatchGroup
}

function assertSingleStake(entries: MatchmakingQueueEntry[]): MatchStake {
  const firstEntry = entries[0]

  if (!firstEntry) {
    throw new Error('Cannot create matched room from empty entry list.')
  }

  const stake = firstEntry.stake

  for (const entry of entries) {
    if (entry.stake !== stake) {
      throw new Error('All matched queue entries must have the same stake.')
    }
  }

  return stake
}

function createBotParticipantFromSelectedProfile(
  selectedProfile: MatchmakingBotSelectionProfile | undefined,
): BotRoomParticipant | null {
  if (!selectedProfile) {
    return null
  }

  return createBotParticipant({
    botProfileId: selectedProfile.profileId ?? undefined,
    botCode: selectedProfile.code,
    difficulty: selectedProfile.difficulty,
    behaviorPreset: selectedProfile.behaviorPreset,
    logicSource: selectedProfile.logicSource,
    identity: selectedProfile.identity,
    publicProfile: {
      profileId: selectedProfile.profileId,
      displayName: selectedProfile.identity.displayName,
      avatarUrl: selectedProfile.identity.avatarUrl,
      level: selectedProfile.identity.level,
      rankTitle: selectedProfile.identity.rankTitle,
      skillRating: selectedProfile.identity.skillRating,
      completedGamesCount: null,
      wonGamesCount: null,
      currentRankGames: null,
      nextRankGames: null,
      gamesUntilNextRank: null,
      rankProgressRatio: null,
      yellowCoinsBalance: selectedProfile.yellowCoinsBalance,
    },
  })
}

function createBotParticipantFromFallbackSelection(
  stake: MatchStake,
  excludedProfileIds: string[],
  botIndex: number,
): BotRoomParticipant {
  const selectedFallbackProfile = pickRandomBotProfile(stake, excludedProfileIds)

  if (selectedFallbackProfile) {
    return createBotParticipant({
      botProfileId: selectedFallbackProfile.profileId,
    })
  }

  return createBotParticipant({
    botCode: `BOT ${botIndex}`,
    identity: {
      displayName: `Бот ${botIndex}`,
      username: `bot_${botIndex}`,
    },
  })
}

export function createMatchedRoomFromEntries(
  entries: MatchmakingQueueEntry[],
  shouldStartImmediately: boolean,
  resolvedSeatOrder: Seat[],
  createTempBot?: TempBotFactory,
  maxBots?: number,
): CreateMatchedRoomFromEntriesResult {
  const createdAt = Date.now()
  const stake = assertSingleStake(entries)

  const shuffledSeats = [...resolvedSeatOrder]
  let nextRoom = createServerRoom({
    config: {
      allowBots: true,
      isPrivate: false,
      stakeAmount: stake,
    },
  })

  const seatAssignments: MatchSeatAssignment[] = []
  const addedBots: BotRoomParticipant[] = []

  for (const entry of entries) {
    const seat = shuffledSeats.shift()

    if (!seat) {
      throw new Error('No seat available while assigning matched humans.')
    }

    const participant = createHumanParticipant({
      connectionId: entry.connectionId,
      playerId: entry.playerId,
      identity: {
        profileId: entry.profileId,
        displayName: entry.displayName,
        avatarUrl: entry.publicProfile?.avatarUrl ?? null,
        level: entry.publicProfile?.level ?? null,
        rankTitle: entry.publicProfile?.rankTitle ?? null,
        skillRating: entry.publicProfile?.skillRating ?? null,
      },
      publicProfile: entry.publicProfile,
    })

    nextRoom = seatParticipantInRoom(nextRoom, seat, participant)

    seatAssignments.push({
      seat,
      playerId: participant.playerId,
      isBot: false,
    })
  }

  // Honour the staged bot-fill limit: only add up to maxBots bots this tick.
  // Undefined means no limit (e.g. shouldStartImmediately path).
  const botLimit = maxBots ?? shuffledSeats.length

  const selectedBotProfiles = selectMatchmakingBotProfiles({
    stake,
    count: Math.min(shuffledSeats.length, botLimit),
    selectionSeed: createMatchmakingBotSelectionSeed(stake, entries),
    createTempBot,
  })

  while (shuffledSeats.length > 0 && addedBots.length < botLimit) {
    const seat = shuffledSeats.shift()

    if (!seat) {
      break
    }

    const participant =
      createBotParticipantFromSelectedProfile(selectedBotProfiles[addedBots.length]) ??
      (process.env.BELOT_ALLOW_CATALOG_BOT_FALLBACK === '1'
        ? createBotParticipantFromFallbackSelection(
            stake,
            addedBots.flatMap((bot) => (bot.botProfileId ? [bot.botProfileId] : [])),
            addedBots.length + 1,
          )
        : null)

    if (!participant) {
      throw new Error(
        `[matchmaking] No bot available for stake ${stake}, slot ${addedBots.length + 1}. ` +
        `Set BELOT_ALLOW_CATALOG_BOT_FALLBACK=1 or add DB bots for this stake.`,
      )
    }

    nextRoom = seatParticipantInRoom(nextRoom, seat, participant)
    addedBots.push(participant)

    seatAssignments.push({
      seat,
      playerId: participant.playerId,
      isBot: true,
    })
  }

  nextRoom = updateRoomHostPlayerId(nextRoom)

  const group: PendingMatchGroup = {
    groupId: randomUUID(),
    roomId: nextRoom.id,
    stake,
    createdAt,
    shouldStartImmediately,
    matchedHumans: entries,
    addedBots,
    seatAssignments,
  }

  return {
    room: nextRoom,
    group,
  }
}
