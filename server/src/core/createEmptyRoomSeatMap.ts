import {
  SERVER_TEAM_A_SEATS,
  SERVER_TEAM_B_SEATS,
  type Seat,
  type ServerSeatMap,
  type RoomSeatSlot,
} from './serverTypes.js'

function getTeamBySeat(seat: Seat): 'A' | 'B' {
  if (SERVER_TEAM_A_SEATS.includes(seat)) {
    return 'A'
  }

  if (SERVER_TEAM_B_SEATS.includes(seat)) {
    return 'B'
  }

  throw new Error(`Unknown seat team mapping for seat: ${seat}`)
}

export function createEmptyRoomSeatMap(): ServerSeatMap<RoomSeatSlot> {
  return {
    bottom: {
      seat: 'bottom',
      team: getTeamBySeat('bottom'),
      participant: null,
    },
    right: {
      seat: 'right',
      team: getTeamBySeat('right'),
      participant: null,
    },
    top: {
      seat: 'top',
      team: getTeamBySeat('top'),
      participant: null,
    },
    left: {
      seat: 'left',
      team: getTeamBySeat('left'),
      participant: null,
    },
  }
}