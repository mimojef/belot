// ВРЕМЕННО — тестови ботове за Свара. Виж docs/svara-test-bots-local.md.
//
// Ботовете НЯМАТ профили в базата. Самоличността им е само игровият
// playerId в мача: `svara-test-bot:<слот>:<uuid>`. Името и аватарът се
// извеждат детерминистично от слота, затова оцеляват при рестарт без
// никакви записи извън snapshot-а на самия мач.

import { randomUUID } from 'node:crypto'

const BOT_ID_PREFIX = 'svara-test-bot:'
const BOT_ID_PATTERN = /^svara-test-bot:([0-7]):[0-9a-f-]{36}$/

const BOT_PROFILES: ReadonlyArray<{ displayName: string; avatarUrl: string }> = [
  { displayName: 'Бот Петър', avatarUrl: '/assets/avatars/male/male-avatar-01.webp' },
  { displayName: 'Бот Мария', avatarUrl: '/assets/avatars/female/female-avatar-01.webp' },
  { displayName: 'Бот Георги', avatarUrl: '/assets/avatars/male/male-avatar-02.webp' },
  { displayName: 'Бот Елена', avatarUrl: '/assets/avatars/female/female-avatar-02.webp' },
  { displayName: 'Бот Николай', avatarUrl: '/assets/avatars/male/male-avatar-03.webp' },
  { displayName: 'Бот Десислава', avatarUrl: '/assets/avatars/female/female-avatar-03.webp' },
  { displayName: 'Бот Стоян', avatarUrl: '/assets/avatars/male/male-avatar-04.webp' },
  { displayName: 'Бот Ивана', avatarUrl: '/assets/avatars/female/female-avatar-04.webp' },
]

export function isSvaraTestBotId(playerId: unknown): playerId is string {
  return typeof playerId === 'string' && BOT_ID_PATTERN.test(playerId)
}

export function getSvaraTestBotProfile(playerId: string): { displayName: string; avatarUrl: string } | null {
  const match = BOT_ID_PATTERN.exec(playerId)
  return match ? BOT_PROFILES[Number(match[1])]! : null
}

/** Нови bot id-та с имена, които още не се ползват на тази маса. */
export function createSvaraTestBotIds(existingPlayerIds: readonly string[], count: number, random: () => number = Math.random): string[] {
  const usedSlots = new Set(existingPlayerIds.flatMap((id) => {
    const match = BOT_ID_PATTERN.exec(id)
    return match ? [Number(match[1])] : []
  }))
  const free = BOT_PROFILES.map((_, slot) => slot).filter((slot) => !usedSlots.has(slot))
  const ids: string[] = []
  while (ids.length < count && free.length > 0) {
    const [slot] = free.splice(Math.floor(random() * free.length), 1)
    ids.push(`${BOT_ID_PREFIX}${slot}:${randomUUID()}`)
  }
  return ids
}
