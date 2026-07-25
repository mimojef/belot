/**
 * Server-side ordering/pagination за страница "Играчи".
 *
 * Чисти, DOM- и DB-независими функции — не зареждат нищо сами, само
 * подреждат вече заявени леки {profileId, isBot} записи. Използвани от
 * handlePlayersRequest (server/src/index.ts) заедно с playerProgressStore-
 * функциите listEligibleProfileKinds/getProfileSnapshotsByIds, за да не се
 * налага да се зарежда пълния профил (wallet/progress/gallery joins) за
 * ВСИЧКИ допустими профили — само подредба по ID, после detail lookup само
 * за текущата страница.
 *
 * Резултатът от computePlayersPageOrder се изчислява ЕДНЪЖ (при прясно
 * отваряне на директорията) и се замразява в playersPageSnapshotStore —
 * seed-ът тук е чисто вътрешен детайл на еднократното изчисление, никога
 * не се излага към клиента (виж playersPageSnapshotStore.ts).
 */

export type EligiblePlayerForOrdering = {
  profileId: string
  isBot: boolean
}

/** FNV-1a 32-bit хеш на `${seed}:${profileId}` — детерминиран, стабилен за дадена (seed, profileId) двойка. */
function seededSortHash(seed: string, profileId: string): number {
  let hash = 0x811c9dc5
  const str = `${seed}:${profileId}`
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function shuffleBySeed<T extends EligiblePlayerForOrdering>(items: readonly T[], seed: string): T[] {
  return [...items].sort((a, b) => seededSortHash(seed, a.profileId) - seededSortHash(seed, b.profileId))
}

/**
 * Връща пълния подреден списък от profileId-та (всички допустими профили,
 * не само текущата страница) — пагинацията (offset/limit slice) се прилага
 * от извикващия код върху резултата.
 *
 * Non-admin: реални играчи (разбъркани) → ботове (разбъркани).
 * Admin: СОБСТВЕНИЯТ профил (ако е сред допустимите) — винаги първи,
 *        изключен от останалите bucket-и → онлайн реални играчи
 *        (разбъркани) → офлайн реални играчи (разбъркани) → ботове
 *        (разбъркани).
 */
export function computePlayersPageOrder(
  eligible: readonly EligiblePlayerForOrdering[],
  opts: {
    isAdmin: boolean
    onlineProfileIds: ReadonlySet<string>
    seed: string
    ownProfileId?: string | null
  },
): string[] {
  if (!opts.isAdmin) {
    const humans = eligible.filter((p) => !p.isBot)
    const bots = eligible.filter((p) => p.isBot)
    return [
      ...shuffleBySeed(humans, opts.seed).map((p) => p.profileId),
      ...shuffleBySeed(bots, opts.seed).map((p) => p.profileId),
    ]
  }

  const ownProfileId = opts.ownProfileId ?? null
  const ownEntry = ownProfileId
    ? eligible.find((p) => p.profileId === ownProfileId && !p.isBot)
    : undefined

  // Изключваме own от останалите bucket-и, за да не се дублира.
  const rest = ownEntry ? eligible.filter((p) => p.profileId !== ownProfileId) : eligible

  const onlineHumans = rest.filter((p) => !p.isBot && opts.onlineProfileIds.has(p.profileId))
  const offlineHumans = rest.filter((p) => !p.isBot && !opts.onlineProfileIds.has(p.profileId))
  const bots = rest.filter((p) => p.isBot)

  return [
    ...(ownEntry ? [ownEntry.profileId] : []),
    ...shuffleBySeed(onlineHumans, opts.seed).map((p) => p.profileId),
    ...shuffleBySeed(offlineHumans, opts.seed).map((p) => p.profileId),
    ...shuffleBySeed(bots, opts.seed).map((p) => p.profileId),
  ]
}

/** Нов случаен seed за еднократното изчисление при създаване на нов snapshot. */
export function generatePlayersPageSeed(): string {
  return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
}
