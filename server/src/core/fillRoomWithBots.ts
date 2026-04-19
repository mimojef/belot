import {
  getBotProfilesCatalog,
  pickRandomBotProfile,
} from '../bots/botProfiles.js'
import type { MatchStake } from '../matchmaking/matchmakingTypes.js'
import { addBotToRoom, type AddBotToRoomResult } from './addBotToRoom.js'
import { getRoomParticipantCount } from './getRoomParticipantCount.js'
import { isRoomFull } from './isRoomFull.js'
import type { ProfileId, ServerRoom } from './serverTypes.js'

export type FillRoomWithBotsOptions = {
  stake?: MatchStake
}

export type FillRoomWithBotsResult = {
  room: ServerRoom
  addedBots: AddBotToRoomResult[]
}

function getExistingBotProfileIds(room: ServerRoom): ProfileId[] {
  const profileIds: ProfileId[] = []

  for (const seatSlot of Object.values(room.seats)) {
    const participant = seatSlot.participant

    if (participant?.kind === 'bot' && participant.botProfileId) {
      profileIds.push(participant.botProfileId)
    }
  }

  return profileIds
}

function getAddedBotProfileIds(addedBots: AddBotToRoomResult[]): ProfileId[] {
  return addedBots
    .map((entry) => entry.participant.botProfileId)
    .filter((profileId): profileId is ProfileId => profileId !== undefined)
}

export function fillRoomWithBots(
  room: ServerRoom,
  options: FillRoomWithBotsOptions = {},
): FillRoomWithBotsResult {
  if (!room.config.allowBots) {
    return {
      room,
      addedBots: [],
    }
  }

  let nextRoom = room
  const addedBots: AddBotToRoomResult[] = []

  while (!isRoomFull(nextRoom) && getRoomParticipantCount(nextRoom) < nextRoom.config.maxPlayers) {
    const excludedProfileIds = [
      ...getExistingBotProfileIds(nextRoom),
      ...getAddedBotProfileIds(addedBots),
    ]

    const selectedProfile = options.stake
      ? pickRandomBotProfile(options.stake, excludedProfileIds)
      : getBotProfilesCatalog().find(
          (profile) => !excludedProfileIds.includes(profile.profileId),
        ) ?? null

    if (!selectedProfile) {
      break
    }

    const result = addBotToRoom(nextRoom, {
      botProfileId: selectedProfile.profileId,
    })

    nextRoom = result.room
    addedBots.push(result)
  }

  return {
    room: nextRoom,
    addedBots,
  }
}