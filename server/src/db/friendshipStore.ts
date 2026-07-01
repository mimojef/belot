import { randomUUID } from 'node:crypto'
import type {
  PlayerPublicProfileSnapshot,
  ProfileId,
} from '../core/serverTypes.js'
import type { PlayerProgressStore } from './playerProgressStore.js'
import { dbDateToUtc } from './dbDate.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type FriendshipStatus = 'pending' | 'accepted'
export type FriendshipDirection = 'incoming' | 'outgoing' | 'accepted'

export type FriendRelationshipSnapshot = {
  friendshipId: string
  status: FriendshipStatus
  direction: FriendshipDirection
  profile: PlayerPublicProfileSnapshot
  createdAt: string
  updatedAt: string
}

export type FriendshipsSnapshot = {
  incomingPending: FriendRelationshipSnapshot[]
  outgoingPending: FriendRelationshipSnapshot[]
  friends: FriendRelationshipSnapshot[]
}

export type UnreadAcceptanceNotification = {
  friendshipId: string
  friendProfile: PlayerPublicProfileSnapshot
}

export type MarkAcceptanceReadResult =
  | { ok: true; status: 'marked' }
  | { ok: true; status: 'already_read' }
  | { ok: false; reason: 'invalid_id' }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'wrong_status' }

export type FriendshipStore = {
  listForProfile: (profileId: ProfileId) => FriendshipsSnapshot
  getUnreadAcceptances: (requesterProfileId: ProfileId) => UnreadAcceptanceNotification[]
  markAcceptanceRead: (
    requesterProfileId: ProfileId,
    friendshipId: string,
  ) => MarkAcceptanceReadResult
  sendRequest: (
    requesterProfileId: ProfileId,
    addresseeProfileId: ProfileId,
  ) =>
    | { ok: true; friendships: FriendshipsSnapshot; friendshipId: string }
    | { ok: false; message: string }
  acceptRequest: (
    profileId: ProfileId,
    friendshipId: string,
  ) =>
    | { ok: true; friendships: FriendshipsSnapshot; requesterProfileId: ProfileId | null }
    | { ok: false; message: string }
  rejectRequest: (
    profileId: ProfileId,
    friendshipId: string,
  ) =>
    | { ok: true; friendships: FriendshipsSnapshot; requesterProfileId: ProfileId | null }
    | { ok: false; message: string }
  cancelRequest: (
    profileId: ProfileId,
    friendshipId: string,
  ) =>
    | { ok: true; friendships: FriendshipsSnapshot; addresseeProfileId: ProfileId }
    | { ok: false; message: string }
  removeRelationship: (
    profileId: ProfileId,
    friendshipId: string,
  ) =>
    | { ok: true; friendships: FriendshipsSnapshot }
    | { ok: false; message: string }
  close: () => void
}

type FriendshipRow = {
  friendship_id: string
  requester_profile_id: string
  addressee_profile_id: string
  status: string
  created_at: string
  updated_at: string
}

function createProfilePair(
  leftProfileId: ProfileId,
  rightProfileId: ProfileId,
): { lowerProfileId: ProfileId; higherProfileId: ProfileId } {
  return leftProfileId.localeCompare(rightProfileId, 'en') <= 0
    ? {
        lowerProfileId: leftProfileId,
        higherProfileId: rightProfileId,
      }
    : {
        lowerProfileId: rightProfileId,
        higherProfileId: leftProfileId,
      }
}

function createEmptyFriendshipsSnapshot(): FriendshipsSnapshot {
  return {
    incomingPending: [],
    outgoingPending: [],
    friends: [],
  }
}

function getFriendshipDirection(
  row: FriendshipRow,
  ownProfileId: ProfileId,
): FriendshipDirection {
  if (row.status === 'accepted') {
    return 'accepted'
  }

  return row.addressee_profile_id === ownProfileId ? 'incoming' : 'outgoing'
}

function getCounterpartProfileId(
  row: FriendshipRow,
  ownProfileId: ProfileId,
): ProfileId {
  return row.requester_profile_id === ownProfileId
    ? row.addressee_profile_id
    : row.requester_profile_id
}

function toRelationshipSnapshot(input: {
  row: FriendshipRow
  ownProfileId: ProfileId
  profile: PlayerPublicProfileSnapshot
}): FriendRelationshipSnapshot {
  return {
    friendshipId: input.row.friendship_id,
    status: input.row.status as FriendshipStatus,
    direction: getFriendshipDirection(input.row, input.ownProfileId),
    profile: input.profile,
    createdAt: dbDateToUtc(input.row.created_at),
    updatedAt: dbDateToUtc(input.row.updated_at),
  }
}

export async function createFriendshipStore(
  databaseFilePath: string,
  playerProgressStore: PlayerProgressStore,
): Promise<FriendshipStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')

  const selectRegisteredHumanProfileStatement = database.prepare(`
    SELECT profile_id
    FROM profiles
    WHERE profile_id = ?
      AND profile_kind = 'human'
      AND status = 'active'
      AND account_id IS NOT NULL
    LIMIT 1;
  `)

  const selectFriendshipByPairStatement = database.prepare(`
    SELECT
      friendship_id,
      requester_profile_id,
      addressee_profile_id,
      status,
      created_at,
      updated_at
    FROM profile_friendships
    WHERE lower_profile_id = ?
      AND higher_profile_id = ?
      AND status != 'blocked'
    LIMIT 1;
  `)

  const selectFriendshipsForProfileStatement = database.prepare(`
    SELECT
      friendship_id,
      requester_profile_id,
      addressee_profile_id,
      status,
      created_at,
      updated_at
    FROM profile_friendships
    WHERE (requester_profile_id = ? OR addressee_profile_id = ?)
      AND status != 'blocked'
    ORDER BY updated_at DESC, created_at DESC;
  `)

  const insertFriendshipStatement = database.prepare(`
    INSERT INTO profile_friendships (
      friendship_id,
      requester_profile_id,
      addressee_profile_id,
      lower_profile_id,
      higher_profile_id,
      status
    ) VALUES (?, ?, ?, ?, ?, 'pending');
  `)

  const acceptFriendshipStatement = database.prepare(`
    UPDATE profile_friendships
    SET
      status = 'accepted',
      updated_at = CURRENT_TIMESTAMP,
      responded_at = CURRENT_TIMESTAMP
    WHERE friendship_id = ?
      AND addressee_profile_id = ?
      AND status = 'pending';
  `)

  const deletePendingFriendshipStatement = database.prepare(`
    DELETE FROM profile_friendships
    WHERE friendship_id = ?
      AND addressee_profile_id = ?
      AND status = 'pending';
  `)

  const selectOutgoingPendingFriendshipStatement = database.prepare(`
    SELECT
      friendship_id,
      requester_profile_id,
      addressee_profile_id,
      status,
      created_at,
      updated_at
    FROM profile_friendships
    WHERE friendship_id = ?
      AND requester_profile_id = ?
      AND status = 'pending'
    LIMIT 1;
  `)

  const deleteOutgoingPendingFriendshipStatement = database.prepare(`
    DELETE FROM profile_friendships
    WHERE friendship_id = ?
      AND requester_profile_id = ?
      AND status = 'pending';
  `)

  const deleteAcceptedFriendshipStatement = database.prepare(`
    DELETE FROM profile_friendships
    WHERE friendship_id = ?
      AND status = 'accepted'
      AND (
        requester_profile_id = ?
        OR addressee_profile_id = ?
      );
  `)

  const selectUnreadAcceptancesStatement = database.prepare(`
    SELECT
      friendship_id,
      requester_profile_id,
      addressee_profile_id,
      status,
      created_at,
      updated_at
    FROM profile_friendships
    WHERE requester_profile_id = ?
      AND status = 'accepted'
      AND requester_acceptance_read_at IS NULL
    ORDER BY updated_at DESC;
  `)

  const selectFriendshipForReadStatement = database.prepare(`
    SELECT
      friendship_id,
      requester_profile_id,
      status,
      requester_acceptance_read_at
    FROM profile_friendships
    WHERE friendship_id = ?
    LIMIT 1;
  `)

  const markAcceptanceReadStatement = database.prepare(`
    UPDATE profile_friendships
    SET requester_acceptance_read_at = CURRENT_TIMESTAMP
    WHERE friendship_id = ?
      AND requester_profile_id = ?
      AND status = 'accepted'
      AND requester_acceptance_read_at IS NULL;
  `)

  function isRegisteredHumanProfile(profileId: ProfileId): boolean {
    const row = selectRegisteredHumanProfileStatement.get(profileId) as
      | { profile_id: string }
      | undefined

    return row !== undefined
  }

  function listForProfile(profileId: ProfileId): FriendshipsSnapshot {
    const rows = selectFriendshipsForProfileStatement.all(
      profileId,
      profileId,
    ) as FriendshipRow[]
    const snapshot = createEmptyFriendshipsSnapshot()

    for (const row of rows) {
      const counterpartProfileId = getCounterpartProfileId(row, profileId)
      const profile = playerProgressStore.getPublicProfile(counterpartProfileId)

      if (profile === null) {
        continue
      }

      const relationship = toRelationshipSnapshot({
        row,
        ownProfileId: profileId,
        profile,
      })

      if (relationship.direction === 'incoming') {
        snapshot.incomingPending.push(relationship)
      } else if (relationship.direction === 'outgoing') {
        snapshot.outgoingPending.push(relationship)
      } else {
        snapshot.friends.push(relationship)
      }
    }

    return snapshot
  }

  function getUnreadAcceptances(requesterProfileId: ProfileId): UnreadAcceptanceNotification[] {
    const rows = selectUnreadAcceptancesStatement.all(requesterProfileId) as FriendshipRow[]
    const result: UnreadAcceptanceNotification[] = []

    for (const row of rows) {
      const friendProfileId = row.addressee_profile_id
      const profile = playerProgressStore.getPublicProfile(friendProfileId)
      if (profile === null) continue
      result.push({ friendshipId: row.friendship_id, friendProfile: profile })
    }

    return result
  }

  function markAcceptanceRead(
    requesterProfileId: ProfileId,
    friendshipId: string,
  ): MarkAcceptanceReadResult {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(friendshipId)) {
      return { ok: false, reason: 'invalid_id' }
    }

    const row = selectFriendshipForReadStatement.get(friendshipId) as
      | { friendship_id: string; requester_profile_id: string; status: string; requester_acceptance_read_at: string | null }
      | undefined

    if (row === undefined) {
      return { ok: false, reason: 'not_found' }
    }

    if (row.requester_profile_id !== requesterProfileId) {
      return { ok: false, reason: 'forbidden' }
    }

    if (row.status !== 'accepted') {
      return { ok: false, reason: 'wrong_status' }
    }

    if (row.requester_acceptance_read_at !== null) {
      return { ok: true, status: 'already_read' }
    }

    markAcceptanceReadStatement.run(friendshipId, requesterProfileId)
    return { ok: true, status: 'marked' }
  }

  function sendRequest(
    requesterProfileId: ProfileId,
    addresseeProfileId: ProfileId,
  ):
    | { ok: true; friendships: FriendshipsSnapshot; friendshipId: string }
    | { ok: false; message: string } {
    if (requesterProfileId === addresseeProfileId) {
      return {
        ok: false,
        message: 'Не можеш да изпратиш покана за приятел към себе си.',
      }
    }

    if (!isRegisteredHumanProfile(requesterProfileId)) {
      return {
        ok: false,
        message: 'Трябва да влезеш в профила си.',
      }
    }

    if (!isRegisteredHumanProfile(addresseeProfileId)) {
      return {
        ok: false,
        message: 'Играчът не беше намерен.',
      }
    }

    const pair = createProfilePair(requesterProfileId, addresseeProfileId)
    const existingRow = selectFriendshipByPairStatement.get(
      pair.lowerProfileId,
      pair.higherProfileId,
    ) as FriendshipRow | undefined

    if (existingRow) {
      if (existingRow.status === 'accepted') {
        return {
          ok: false,
          message: 'Вече сте приятели.',
        }
      }

      if (existingRow.requester_profile_id === requesterProfileId) {
        return {
          ok: false,
          message: 'Поканата вече е изпратена.',
        }
      }

      return {
        ok: false,
        message: 'Този играч вече ти е изпратил покана. Отвори панела с приятели.',
      }
    }

    const newFriendshipId = randomUUID()
    insertFriendshipStatement.run(
      newFriendshipId,
      requesterProfileId,
      addresseeProfileId,
      pair.lowerProfileId,
      pair.higherProfileId,
    )

    return {
      ok: true,
      friendships: listForProfile(requesterProfileId),
      friendshipId: newFriendshipId,
    }
  }

  function acceptRequest(
    profileId: ProfileId,
    friendshipId: string,
  ):
    | { ok: true; friendships: FriendshipsSnapshot; requesterProfileId: ProfileId | null }
    | { ok: false; message: string } {
    // Read the row before updating so we know who the requester is.
    const existingRow = (database.prepare(`
      SELECT requester_profile_id
      FROM profile_friendships
      WHERE friendship_id = ?
        AND addressee_profile_id = ?
        AND status = 'pending'
      LIMIT 1;
    `).get(friendshipId, profileId)) as { requester_profile_id: string } | undefined

    const result = acceptFriendshipStatement.run(
      friendshipId,
      profileId,
    ) as { changes?: number }

    if ((result.changes ?? 0) === 0) {
      return {
        ok: false,
        message: 'Поканата не беше намерена или вече е обработена.',
      }
    }

    return {
      ok: true,
      friendships: listForProfile(profileId),
      requesterProfileId: existingRow?.requester_profile_id ?? null,
    }
  }

  function rejectRequest(
    profileId: ProfileId,
    friendshipId: string,
  ):
    | { ok: true; friendships: FriendshipsSnapshot; requesterProfileId: ProfileId | null }
    | { ok: false; message: string } {
    // Read requester before deleting so we can notify them via WS.
    const existingRow = database.prepare(`
      SELECT requester_profile_id
      FROM profile_friendships
      WHERE friendship_id = ?
        AND addressee_profile_id = ?
        AND status = 'pending'
      LIMIT 1;
    `).get(friendshipId, profileId) as { requester_profile_id: string } | undefined

    const result = deletePendingFriendshipStatement.run(
      friendshipId,
      profileId,
    ) as { changes?: number }

    if ((result.changes ?? 0) === 0) {
      return {
        ok: false,
        message: 'Поканата не беше намерена или вече е обработена.',
      }
    }

    return {
      ok: true,
      friendships: listForProfile(profileId),
      requesterProfileId: existingRow?.requester_profile_id ?? null,
    }
  }

  function cancelRequest(
    profileId: ProfileId,
    friendshipId: string,
  ):
    | { ok: true; friendships: FriendshipsSnapshot; addresseeProfileId: ProfileId }
    | { ok: false; message: string } {
    const row = selectOutgoingPendingFriendshipStatement.get(
      friendshipId,
      profileId,
    ) as FriendshipRow | undefined

    if (row === undefined) {
      return {
        ok: false,
        message: 'Поканата не беше намерена или вече е обработена.',
      }
    }

    const result = deleteOutgoingPendingFriendshipStatement.run(
      friendshipId,
      profileId,
    ) as { changes?: number }

    if ((result.changes ?? 0) === 0) {
      return {
        ok: false,
        message: 'Поканата не беше намерена или вече е обработена.',
      }
    }

    return {
      ok: true,
      friendships: listForProfile(profileId),
      addresseeProfileId: row.addressee_profile_id,
    }
  }

  function removeRelationship(
    profileId: ProfileId,
    friendshipId: string,
  ):
    | { ok: true; friendships: FriendshipsSnapshot }
    | { ok: false; message: string } {
    const result = deleteAcceptedFriendshipStatement.run(
      friendshipId,
      profileId,
      profileId,
    ) as { changes?: number }

    if ((result.changes ?? 0) === 0) {
      return {
        ok: false,
        message: 'Приятелството не беше намерено.',
      }
    }

    return {
      ok: true,
      friendships: listForProfile(profileId),
    }
  }

  function close(): void {
    database.close()
  }

  return {
    listForProfile,
    getUnreadAcceptances,
    markAcceptanceRead,
    sendRequest,
    acceptRequest,
    rejectRequest,
    cancelRequest,
    removeRelationship,
    close,
  }
}
