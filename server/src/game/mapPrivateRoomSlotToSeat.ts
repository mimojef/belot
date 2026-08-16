import { SERVER_TEAM_A_SEATS, SERVER_TEAM_B_SEATS, type Seat, type Team } from '../core/serverTypes.js'

// A,0→bottom  A,1→top  B,0→right  B,1→left — заменя изцяло shuffleSeatOrder()
// в private-room пътя. Партньорските двойки (bottom/top, right/left) идват
// директно от SERVER_TEAM_A_SEATS/SERVER_TEAM_B_SEATS, не се дублират тук.
export function mapPrivateRoomSlotToSeat(team: Team, slotIndex: 0 | 1): Seat {
  const teamSeats = team === 'A' ? SERVER_TEAM_A_SEATS : SERVER_TEAM_B_SEATS
  return teamSeats[slotIndex]!
}
