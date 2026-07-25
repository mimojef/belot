import { randomUUID } from 'node:crypto'

/**
 * In-memory store за замразена (snapshot) глобална подредба на страница
 * "Играчи" — създава се веднъж при прясно отваряне на директорията,
 * преизползва се от всички следващи page заявки в рамките на същата
 * browsing сесия (виж handlePlayersRequest, server/src/index.ts).
 *
 * Защо: seed-базираният hash shuffle сам по себе си стабилизира РЕДА в
 * рамките на bucket-ите, но НЕ и самата принадлежност към online/offline
 * bucket-ите — ако статус на играч се смени между зареждане на страница 1
 * и страница 2, границата на bucket-а се мести и профил може да се
 * дублира/пропусне между страниците. Snapshot-ът замразява ЦЕЛИЯ подреден
 * списък от profileId-та (не и показвания isOnline статус на картите,
 * който продължава да се смята "на живо" при всяка заявка).
 *
 * Token-ът е непрозрачен (randomUUID) и е обвързан с (isAdmin, viewerProfileId)
 * от момента на създаването му — заявка с грешен viewer/admin статус се
 * третира като невалиден snapshot (без mixing между admin и user подредби).
 */

export type PlayersPageSnapshotStore = {
  create: (
    orderedProfileIds: string[],
    isAdmin: boolean,
    viewerProfileId: string | null,
    now?: number,
  ) => string
  get: (
    token: string,
    isAdmin: boolean,
    viewerProfileId: string | null,
    now?: number,
  ) => string[] | null
  size: () => number
}

const DEFAULT_TTL_MS = 30 * 60 * 1000
const DEFAULT_MAX_ENTRIES = 500
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000

type SnapshotEntry = {
  orderedProfileIds: string[]
  isAdmin: boolean
  viewerProfileId: string | null
  createdAt: number
}

export function createPlayersPageSnapshotStore(options?: {
  ttlMs?: number
  maxEntries?: number
  cleanupIntervalMs?: number
}): PlayersPageSnapshotStore {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES
  const cleanupIntervalMs = options?.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS

  const entries = new Map<string, SnapshotEntry>()
  let lastCleanupAt = 0

  function cleanup(now: number): void {
    if (now - lastCleanupAt < cleanupIntervalMs && entries.size <= maxEntries) {
      return
    }
    lastCleanupAt = now

    for (const [token, entry] of entries) {
      if (now - entry.createdAt > ttlMs) {
        entries.delete(token)
      }
    }

    if (entries.size > maxEntries) {
      // Map пази ред на вмъкване — най-старите записи (никога не се
      // презаписват) идват първи при итерация.
      let excess = entries.size - maxEntries
      for (const token of entries.keys()) {
        if (excess <= 0) break
        entries.delete(token)
        excess--
      }
    }
  }

  function create(
    orderedProfileIds: string[],
    isAdmin: boolean,
    viewerProfileId: string | null,
    now: number = Date.now(),
  ): string {
    const token = randomUUID()
    entries.set(token, { orderedProfileIds, isAdmin, viewerProfileId, createdAt: now })
    // Cleanup СЛЕД вмъкването — size cap-ът трябва да важи веднага, не със
    // закъснение от едно следващо повикване.
    cleanup(now)
    return token
  }

  function get(
    token: string,
    isAdmin: boolean,
    viewerProfileId: string | null,
    now: number = Date.now(),
  ): string[] | null {
    cleanup(now)
    const entry = entries.get(token)
    if (!entry) return null

    if (now - entry.createdAt > ttlMs) {
      entries.delete(token)
      return null
    }

    if (entry.isAdmin !== isAdmin || entry.viewerProfileId !== viewerProfileId) {
      return null
    }

    return entry.orderedProfileIds
  }

  function size(): number {
    return entries.size
  }

  return { create, get, size }
}
