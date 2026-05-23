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
  type TempBotFactory,
} from './selectMatchmakingBotProfiles.js'

export type CreateMatchedRoomFromEntriesResult = {
  room: ServerRoom
  group: PendingMatchGroup
}

type BlockCheck = (profileIdA: string, profileIdB: string) => boolean

const TEAM_A_SEATS = new Set<Seat>(['bottom', 'top'])

function hasBlockedPartnership(
  entries: MatchmakingQueueEntry[],
  shuffled: Seat[],
  isBlocked: BlockCheck,
): boolean {
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const seatI = shuffled[i]
      const seatJ = shuffled[j]
      if (!seatI || !seatJ) continue
      const sameTeam = TEAM_A_SEATS.has(seatI) === TEAM_A_SEATS.has(seatJ)
      if (!sameTeam) continue
      const a = entries[i].profileId
      const b = entries[j].profileId
      if (!a || !b) continue
      if (isBlocked(a, b) || isBlocked(b, a)) return true
    }
  }
  return false
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
  blockCheck?: BlockCheck,
  createTempBot?: TempBotFactory,
): CreateMatchedRoomFromEntriesResult {
  const createdAt = Date.now()
  const stake = assertSingleStake(entries)

  let shuffledSeats = shuffleSeats(SERVER_SEAT_ORDER)
  if (blockCheck) {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!hasBlockedPartnership(entries, shuffledSeats, blockCheck)) break
      if (attempt < 19) shuffledSeats = shuffleSeats(SERVER_SEAT_ORDER)
    }
  }
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

  const selectedBotProfiles = selectMatchmakingBotProfiles({
    stake,
    count: shuffledSeats.length,
    selectionSeed: createMatchmakingBotSelectionSeed(stake, entries),
    createTempBot,
  })

  while (shuffledSeats.length > 0) {
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
