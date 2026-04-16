import { addBotToRoom, type AddBotToRoomResult } from './addBotToRoom.js'
import { getRoomParticipantCount } from './getRoomParticipantCount.js'
import { isRoomFull } from './isRoomFull.js'
import type { ServerRoom } from './serverTypes.js'

export type FillRoomWithBotsResult = {
  room: ServerRoom
  addedBots: AddBotToRoomResult[]
}

function getNextBotIndex(room: ServerRoom): number {
  let botCount = 0

  for (const seatSlot of Object.values(room.seats)) {
    if (seatSlot.participant?.kind === 'bot') {
      botCount += 1
    }
  }

  return botCount + 1
}

export function fillRoomWithBots(room: ServerRoom): FillRoomWithBotsResult {
  if (!room.config.allowBots) {
    return {
      room,
      addedBots: [],
    }
  }

  let nextRoom = room
  const addedBots: AddBotToRoomResult[] = []

  while (!isRoomFull(nextRoom) && getRoomParticipantCount(nextRoom) < nextRoom.config.maxPlayers) {
    const botIndex = getNextBotIndex(nextRoom)
    const result = addBotToRoom(nextRoom, {
      botCode: `BOT ${botIndex}`,
      identity: {
        displayName: `Бот ${botIndex}`,
        username: `bot_${botIndex}`,
      },
    })

    nextRoom = result.room
    addedBots.push(result)
  }

  return {
    room: nextRoom,
    addedBots,
  }
}