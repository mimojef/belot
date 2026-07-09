import { addBotToRoom } from './addBotToRoom.js'
import { createRoomWithHumanHost } from './createRoomWithHumanHost.js'
import {
  createMatchmakingBotSelectionSeed,
  selectMatchmakingBotProfiles,
  type MatchmakingBotSelectionProfile,
} from '../matchmaking/selectMatchmakingBotProfiles.js'
import type { MatchStake } from '../matchmaking/matchmakingTypes.js'
import type {
  ConnectionId,
  Seat,
  ServerRoom,
} from './serverTypes.js'

export type CreateGuestTrialRoomOptions = {
  connectionId: ConnectionId
  guestId: string
  stake: MatchStake
  botCount?: number
}

export type CreateGuestTrialRoomResult = {
  room: ServerRoom
  hostSeat: Seat
}

function botOptionsFromSelectedProfile(profile: MatchmakingBotSelectionProfile) {
  return {
    botProfileId: profile.profileId ?? undefined,
    botCode: profile.code,
    difficulty: profile.difficulty,
    behaviorPreset: profile.behaviorPreset,
    logicSource: profile.logicSource,
    identity: profile.identity,
  }
}

export function createGuestTrialRoom(
  options: CreateGuestTrialRoomOptions,
): CreateGuestTrialRoomResult {
  const botCount = options.botCount ?? 3

  const hostResult = createRoomWithHumanHost({
    connectionId: options.connectionId,
    identity: {
      displayName: 'Гост',
    },
    config: {
      allowBots: true,
      isPrivate: true,
      stakeAmount: options.stake,
      isGuestTrial: true,
    },
    isGuestTrial: true,
  })

  let nextRoom = hostResult.room

  const selectedBotProfiles = selectMatchmakingBotProfiles({
    stake: options.stake,
    count: botCount,
    selectionSeed: createMatchmakingBotSelectionSeed(options.stake, [
      { entryId: options.guestId, joinedAt: Date.now() },
    ]),
  })

  for (let index = 0; index < botCount; index += 1) {
    const selectedProfile = selectedBotProfiles[index]

    const addBotResult = selectedProfile
      ? addBotToRoom(nextRoom, botOptionsFromSelectedProfile(selectedProfile))
      : addBotToRoom(nextRoom, { botCode: `Бот ${index + 1}` })

    nextRoom = addBotResult.room
  }

  return {
    room: nextRoom,
    hostSeat: hostResult.seat,
  }
}
