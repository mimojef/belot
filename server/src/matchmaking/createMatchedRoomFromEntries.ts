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

  while (shuffledSeats.length > 0) {
    const seat = shuffledSeats.shift()

    if (!seat) {
      break
    }

    const excludedProfileIds = addedBots.flatMap((bot) =>
      bot.botProfileId ? [bot.botProfileId] : [],
    )

    const selectedProfile = pickRandomBotProfile(stake, excludedProfileIds)

    const participant: BotRoomParticipant = selectedProfile
      ? createBotParticipant({
          botProfileId: selectedProfile.profileId,
        })
      : createBotParticipant({
          botCode: `BOT ${addedBots.length + 1}`,
          identity: {
            displayName: `Бот ${addedBots.length + 1}`,
            username: `bot_${addedBots.length + 1}`,
          },
        })

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