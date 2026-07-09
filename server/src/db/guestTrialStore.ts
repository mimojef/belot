import { createHash, randomUUID } from 'node:crypto';
import { getSofiaDayBoundsUtc, toSqliteUtc } from './sofiaDayBounds.js';

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>;

export const GUEST_TRIAL_MAX_GAMES = 3;
export const GUEST_TRIAL_STAKE = 5000;

const GUEST_ID_COOKIE_NAME = 'belot_guest_id';
const GUEST_ID_COOKIE_TTL_MS = 1000 * 60 * 60 * 24 * 365;

export type GuestTrialSessionSnapshot = {
  guestId: string;
  gamesUsed: number;
  remaining: number;
  createdAt: string;
  lastSeenAt: string;
};

export type GuestTrialStore = {
  getOrCreateSession(guestId: string | null, ipHash: string | null, userAgentHash: string | null): GuestTrialSessionSnapshot;
  getSession(guestId: string): GuestTrialSessionSnapshot | null;
  registerTrialGameStarted(guestId: string): { ok: true; session: GuestTrialSessionSnapshot } | { ok: false; message: string; reason: 'guest_trial_limit_reached' };
  undoTrialGameStarted(guestId: string): void;
  recordTrialGameStart(guestId: string, roomId: string, stakeAmount: number): void;
  undoTrialGameStart(roomId: string): void;
  getGamesPlayedStats(now?: Date): { today: number; yesterday: number };
  close(): void;
};

type GuestTrialSessionRow = {
  guest_id: string;
  games_used: number;
  created_at: string;
  last_seen_at: string;
  ip_hash: string | null;
  user_agent_hash: string | null;
};

function toSnapshot(row: GuestTrialSessionRow): GuestTrialSessionSnapshot {
  return {
    guestId: row.guest_id,
    gamesUsed: row.games_used,
    remaining: Math.max(0, GUEST_TRIAL_MAX_GAMES - row.games_used),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function createGuestId(): string {
  return randomUUID();
}

export function hashGuestIdentitySignal(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function createGuestIdCookieHeader(guestId: string): string {
  return [
    `${GUEST_ID_COOKIE_NAME}=${guestId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(GUEST_ID_COOKIE_TTL_MS / 1000)}`,
  ].join('; ');
}

export function getGuestIdFromCookieHeader(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) {
    return null;
  }

  const cookies = cookieHeader.split(';');

  for (const cookie of cookies) {
    const [rawName, ...rawValueParts] = cookie.trim().split('=');

    if (rawName === GUEST_ID_COOKIE_NAME) {
      return rawValueParts.join('=') || null;
    }
  }

  return null;
}

function isValidGuestId(guestId: string | null): guestId is string {
  if (!guestId) {
    return false;
  }

  return /^[0-9a-f-]{10,64}$/i.test(guestId);
}

export async function createGuestTrialStore(databaseFilePath: string): Promise<GuestTrialStore> {
  const sqliteModule = await import('node:sqlite');
  const db: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath);
  db.exec('PRAGMA journal_mode = WAL;');

  const selectByGuestId = db.prepare(`
    SELECT guest_id, games_used, created_at, last_seen_at, ip_hash, user_agent_hash
    FROM guest_trial_sessions
    WHERE guest_id = ?
  `);

  const insertSession = db.prepare(`
    INSERT INTO guest_trial_sessions (guest_id, games_used, created_at, last_seen_at, ip_hash, user_agent_hash)
    VALUES (?, 0, ?, ?, ?, ?)
  `);

  const touchLastSeen = db.prepare(`
    UPDATE guest_trial_sessions
    SET last_seen_at = ?,
        ip_hash = COALESCE(?, ip_hash),
        user_agent_hash = COALESCE(?, user_agent_hash)
    WHERE guest_id = ?
  `);

  const incrementGamesUsed = db.prepare(`
    UPDATE guest_trial_sessions
    SET games_used = games_used + 1,
        last_seen_at = ?
    WHERE guest_id = ?
      AND games_used < ?
  `);

  const decrementGamesUsed = db.prepare(`
    UPDATE guest_trial_sessions
    SET games_used = games_used - 1
    WHERE guest_id = ?
      AND games_used > 0
  `);

  const insertGameStart = db.prepare(`
    INSERT OR IGNORE INTO guest_trial_game_starts (guest_id, room_id, stake_amount, started_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const deleteGameStartByRoomId = db.prepare(`
    DELETE FROM guest_trial_game_starts
    WHERE room_id = ?
  `);

  const countGameStartsInRange = db.prepare(`
    SELECT COUNT(*) AS n
    FROM guest_trial_game_starts
    WHERE started_at >= ? AND started_at < ?
  `);

  return {
    getOrCreateSession(guestId, ipHash, userAgentHash) {
      const now = new Date().toISOString();
      const normalizedGuestId = isValidGuestId(guestId) ? guestId : createGuestId();

      const existing = selectByGuestId.get(normalizedGuestId) as GuestTrialSessionRow | undefined;

      if (existing) {
        touchLastSeen.run(now, ipHash, userAgentHash, normalizedGuestId);
        const updated = selectByGuestId.get(normalizedGuestId) as GuestTrialSessionRow;
        return toSnapshot(updated);
      }

      insertSession.run(normalizedGuestId, now, now, ipHash, userAgentHash);
      const created = selectByGuestId.get(normalizedGuestId) as GuestTrialSessionRow;
      return toSnapshot(created);
    },
    getSession(guestId) {
      if (!isValidGuestId(guestId)) {
        return null;
      }

      const row = selectByGuestId.get(guestId) as GuestTrialSessionRow | undefined;
      return row ? toSnapshot(row) : null;
    },
    registerTrialGameStarted(guestId) {
      if (!isValidGuestId(guestId)) {
        return { ok: false, message: 'Невалидна гостова сесия.', reason: 'guest_trial_limit_reached' };
      }

      const now = new Date().toISOString();
      const result = incrementGamesUsed.run(now, guestId, GUEST_TRIAL_MAX_GAMES);

      if (result.changes === 0) {
        return {
          ok: false,
          message: 'Изиграхте своите пробни игри.',
          reason: 'guest_trial_limit_reached',
        };
      }

      const updated = selectByGuestId.get(guestId) as GuestTrialSessionRow;
      return { ok: true, session: toSnapshot(updated) };
    },
    undoTrialGameStarted(guestId) {
      if (!isValidGuestId(guestId)) {
        return;
      }

      decrementGamesUsed.run(guestId);
    },
    recordTrialGameStart(guestId, roomId, stakeAmount) {
      const now = toSqliteUtc(new Date());
      insertGameStart.run(guestId, roomId, stakeAmount, now, now);
    },
    undoTrialGameStart(roomId) {
      deleteGameStartByRoomId.run(roomId);
    },
    getGamesPlayedStats(now = new Date()) {
      const bounds = getSofiaDayBoundsUtc(now);
      const todayRow = countGameStartsInRange.get(bounds.todayStart, bounds.tomorrowStart) as { n: number } | undefined;
      const yesterdayRow = countGameStartsInRange.get(bounds.yesterdayStart, bounds.todayStart) as { n: number } | undefined;
      return {
        today: todayRow?.n ?? 0,
        yesterday: yesterdayRow?.n ?? 0,
      };
    },
    close() {
      db.close();
    },
  };
}
