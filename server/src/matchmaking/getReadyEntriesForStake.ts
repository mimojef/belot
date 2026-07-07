import { getSearchingEntriesByStake } from './getSearchingEntriesByStake.js'
import type {
  MatchStake,
  MatchmakingQueueEntry,
} from './matchmakingTypes.js'
import {
  MATCHMAKING_BOT_FILL_WINDOW_MS,
  MATCHMAKING_BOT_FILL_RATE_MS,
} from './matchmakingTypes.js'

const MATCH_SIZE = 4

export type ReadyEntriesForStakeResult = {
  entries: MatchmakingQueueEntry[]
  shouldStartImmediately: boolean
  // How many bots may be added to fill the remaining seats (0 when not in bot-fill window).
  maxBots: number
}

export function getReadyEntriesForStake(
  allEntries: MatchmakingQueueEntry[],
  stake: MatchStake,
  now: number = Date.now(),
): ReadyEntriesForStakeResult {
  const searchingEntries = getSearchingEntriesByStake(allEntries, stake).sort(
    (a, b) => a.joinedAt - b.joinedAt,
  )

  if (searchingEntries.length === 0) {
    return { entries: [], shouldStartImmediately: false, maxBots: 0 }
  }

  // 4 humans available → start immediately, no bots needed.
  if (searchingEntries.length >= MATCH_SIZE) {
    return {
      entries: searchingEntries.slice(0, MATCH_SIZE),
      shouldStartImmediately: true,
      maxBots: 0,
    }
  }

  const oldestEntry = searchingEntries[0]
  if (!oldestEntry) {
    return { entries: [], shouldStartImmediately: false, maxBots: 0 }
  }

  const botFillWindowStart = oldestEntry.expiresAt - MATCHMAKING_BOT_FILL_WINDOW_MS

  // Before the bot-fill window opens: keep waiting for real humans.
  if (now < botFillWindowStart) {
    return { entries: [], shouldStartImmediately: false, maxBots: 0 }
  }

  // Inside (or past) the bot-fill window.
  // Allow one additional bot per MATCHMAKING_BOT_FILL_RATE_MS elapsed since window opened.
  // Capped at the number of open seats so we never exceed MATCH_SIZE.
  const msElapsedInWindow = now - botFillWindowStart
  const openSeats = MATCH_SIZE - searchingEntries.length
  const allowedBots = Math.min(
    openSeats,
    Math.floor(msElapsedInWindow / MATCHMAKING_BOT_FILL_RATE_MS) + 1,
  )

  // Only create the room when humans + allowedBots fills the table.
  // This prevents creating a room the moment the window opens with fewer bots than needed.
  if (searchingEntries.length + allowedBots < MATCH_SIZE) {
    return { entries: [], shouldStartImmediately: false, maxBots: 0 }
  }

  return {
    entries: searchingEntries,
    shouldStartImmediately: false,
    maxBots: allowedBots,
  }
}
