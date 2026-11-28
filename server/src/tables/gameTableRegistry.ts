// Общ регистър на игрите с частни маси (чакалня) — Етап 1 на общата система
// за маси, чакални, текстов и гласов чат.
//
// Всяка игра се регистрира с малък сървърен адаптер, който отговаря САМО от
// авторитетното си състояние (никога от подадените от клиента gameId/tableId):
// на коя маса участва дадена връзка в момента и кои връзки получават
// съобщенията на тази маса. Общите услуги (текстовият чат; по-късно гласът и
// навигацията) работят само през адаптера — без код, специфичен за играта.
//
// Нова игра = нов адаптер в регистрацията (index.ts). Непознат gameId -> няма
// адаптер -> отказ (без разкриване дали масата съществува).

/** Идентификатор на игра: малки латински букви/цифри, напр. 'belot', 'svara', 'ludo'. */
export const GAME_TABLE_GAME_ID_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/

/** Горна граница за tableId от клиента (структурна проверка; истината е в адаптера). */
export const GAME_TABLE_ID_MAX_LENGTH = 128

export function isGameTableGameId(value: unknown): value is string {
  return typeof value === 'string' && GAME_TABLE_GAME_ID_PATTERN.test(value)
}

/**
 * Участието на връзката в масата — изведено от авторитетното състояние на
 * играта в един и същ момент (същият снимков обект), за да не се разминават
 * членството и получателите.
 */
export type GameTableMembership = {
  tableId: string
  /** Седналият участник, на когото принадлежи връзката. */
  member: { profileId: string | null; displayName: string }
  /** Текущите връзки на всички седнали реални участници (вкл. самата връзка). */
  recipientConnectionIds: readonly string[]
}

export type GameTableAdapter = {
  gameId: string
  /**
   * Масата, на която тази връзка участва В МОМЕНТА (седнал реален участник),
   * или null. Само от сървърното състояние; без доверие на клиента.
   */
  findMembership: (connectionId: string) => GameTableMembership | null
  /**
   * Формат на доставката на чат съобщенията към участниците:
   *  - 'legacy-private-room' — само за Белот: private_room_chat_message, който
   *    разбират и кешираните PWA клиенти;
   *  - 'table' — общият table_chat_message.
   */
  chatDelivery: 'legacy-private-room' | 'table'
}

export type GameTableRegistry = {
  get: (gameId: string) => GameTableAdapter | null
  gameIds: () => readonly string[]
}

export function createGameTableRegistry(adapters: readonly GameTableAdapter[]): GameTableRegistry {
  const byGameId = new Map<string, GameTableAdapter>()
  for (const adapter of adapters) {
    if (!isGameTableGameId(adapter.gameId)) throw new Error(`game_table_invalid_game_id:${adapter.gameId}`)
    if (byGameId.has(adapter.gameId)) throw new Error(`game_table_duplicate_game_id:${adapter.gameId}`)
    byGameId.set(adapter.gameId, adapter)
  }
  const ids = Object.freeze([...byGameId.keys()])
  return {
    get: (gameId) => byGameId.get(gameId) ?? null,
    gameIds: () => ids,
  }
}
