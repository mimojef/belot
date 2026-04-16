import { randomUUID } from 'node:crypto'
import type {
  BotDifficulty,
  BotRoomParticipant,
  PlayerId,
  PlayerIdentitySnapshot,
} from './serverTypes.js'

type CreateBotParticipantOptions = {
  playerId?: PlayerId
  botCode?: string
  difficulty?: BotDifficulty
  identity?: Partial<PlayerIdentitySnapshot>
}

function createDefaultBotIdentity(botCode: string): PlayerIdentitySnapshot {
  return {
    accountId: null,
    profileId: null,
    username: botCode.toLowerCase(),
    displayName: botCode,
    avatarUrl: null,
    level: null,
    rankTitle: null,
    skillRating: null,
  }
}

export function createBotParticipant(
  options: CreateBotParticipantOptions = {},
): BotRoomParticipant {
  const now = Date.now()
  const botCode = options.botCode ?? 'BOT'

  return {
    kind: 'bot',
    playerId: options.playerId ?? randomUUID(),
    joinedAt: now,
    botCode,
    difficulty: options.difficulty ?? 'normal',
    identity: {
      ...createDefaultBotIdentity(botCode),
      ...options.identity,
    },
  }
}