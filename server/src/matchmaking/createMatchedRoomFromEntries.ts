import { randomUUID } from 'node:crypto'
import { pickRandomBotProfile } from '../bots/botProfiles.js'
import { createBotParticipant } from '../core/createBotParticipant.js'
import { createHumanParticipant } from '../core/createHumanParticipant.js'
import { createServerRoom } from '../core/createServerRoom.js'
import { seatParticipantInRoom } from '../core/seatParticipantInRoom.js'
import {
  SERVER_SEAT_ORDER,
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
} from './selectMatchmakingBotProfiles.js'

export type CreateMatchedRoomFromEntriesResult = {
  room: ServerRoom
  group: PendingMatchGroup
}

function shuffleSeats(seats: Seat[]): Seat[] {
  const nextSeats = [...seats]

  for (let index = nextSeats.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    const currentSeat = nextSeats[index]

    nextSeats[index] = nextSeats[swapIndex]
    nextSeats[swapIndex] = currentSeat
  }

  return nextSeats
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
): CreateMatchedRoomFromEntriesResult {
  const createdAt = Date.now()
  const stake = assertSingleStake(entries)
  const shuffledSeats = shuffleSeats(SERVER_SEAT_ORDER)
  let nextRoom = createServerRoom({
    config: {
      allowBots: true,
      isPrivate: false,
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
        displayName: entry.displayName,
      },
    })

    nextRoom = seatParticipantInRoom(nextRoom, seat, participant)

    seatAssignments.push({
      seat,
      playerId: participant.playerId,
      isBot: false,
    })
  }

  const selectedBotProfiles = selectMatchmakingBotProfiles({
    stake,
    count: shuffledSeats.length,
    selectionSeed: createMatchmakingBotSelectionSeed(stake, entries),
  })

  while (shuffledSeats.length > 0) {
    const seat = shuffledSeats.shift()

    if (!seat) {
      break
    }

    const participant =
      createBotParticipantFromSelectedProfile(selectedBotProfiles[addedBots.length]) ??
      createBotParticipantFromFallbackSelection(
        stake,
        addedBots.flatMap((bot) => (bot.botProfileId ? [bot.botProfileId] : [])),
        addedBots.length + 1,
      )

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
