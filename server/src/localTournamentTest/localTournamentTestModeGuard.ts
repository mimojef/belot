// Централен guard за строго локалния турнирен тестов режим (виж
// docs/local-tournament-test.md). ЕДИНСТВЕНОТО място, което чете
// BELOT_LOCAL_TOURNAMENT_TEST_MODE/NODE_ENV — всички други модули минават
// през isLocalTournamentTestModeEnabled()/isLocalTournamentTestRequestAllowed(),
// вместо да проверяват env директно (виж §7 в task spec-а: "Не разпръсквай
// проверки на env из много файлове").
//
// Режимът е активен само когато И ДВЕТЕ условия са изпълнени:
//  - BELOT_LOCAL_TOURNAMENT_TEST_MODE е точно "1"
//  - NODE_ENV не е "production"
// Заявките към dev endpoint-ите допълнително трябва да идват от loopback
// адрес (127.0.0.1/::1) — заявка от чужд IP се третира като непозната, дори
// ако флагът е включен (защита срещу случайно public bind).

import type { IncomingMessage } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENV_FLAG_NAME = 'BELOT_LOCAL_TOURNAMENT_TEST_MODE'
const ENV_FLAG_ENABLED_VALUE = '1'

export function isLocalTournamentTestModeEnabled(): boolean {
  return (
    process.env[ENV_FLAG_NAME] === ENV_FLAG_ENABLED_VALUE &&
    process.env.NODE_ENV !== 'production'
  )
}

const LOOPBACK_REMOTE_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export function isLoopbackRequest(req: Pick<IncomingMessage, 'socket'>): boolean {
  const remoteAddress = req.socket.remoteAddress
  return remoteAddress !== undefined && remoteAddress !== null && LOOPBACK_REMOTE_ADDRESSES.has(remoteAddress)
}

/** Единствената проверка, която dev HTTP/WS входните точки трябва да викат. */
export function isLocalTournamentTestRequestAllowed(req: Pick<IncomingMessage, 'socket'>): boolean {
  return isLocalTournamentTestModeEnabled() && isLoopbackRequest(req)
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return parsed
}

export type LocalTournamentTestTimingOverrides = {
  attendanceFirstMatchMs: number
  attendanceTransitionMs: number
  botActionMinMs: number
  botActionMaxMs: number
}

const DEFAULT_ATTENDANCE_FIRST_MATCH_MS = 180_000
const DEFAULT_ATTENDANCE_TRANSITION_MS = 20_000
const DEFAULT_BOT_ACTION_MIN_MS = 100
const DEFAULT_BOT_ACTION_MAX_MS = 300

/**
 * Изчислява override-натите таймери САМО когато local test mode е активен —
 * извикващите модули (tournamentCoordinator.ts, serverTimingConfig.ts)
 * решават сами дали да викат тази функция, но самата тя е безопасна да се
 * извика винаги: без флага връща точно production стойностите.
 */
export function getLocalTournamentTestTimingOverrides(): LocalTournamentTestTimingOverrides {
  if (!isLocalTournamentTestModeEnabled()) {
    return {
      attendanceFirstMatchMs: DEFAULT_ATTENDANCE_FIRST_MATCH_MS,
      attendanceTransitionMs: DEFAULT_ATTENDANCE_TRANSITION_MS,
      botActionMinMs: DEFAULT_BOT_ACTION_MIN_MS,
      botActionMaxMs: DEFAULT_BOT_ACTION_MAX_MS,
    }
  }

  const attendanceFirstMatchMs = parsePositiveIntEnv(
    'BELOT_LOCAL_TOURNAMENT_ATTENDANCE_MS',
    DEFAULT_ATTENDANCE_FIRST_MATCH_MS,
  )
  const attendanceTransitionMs = parsePositiveIntEnv(
    'BELOT_LOCAL_TOURNAMENT_TRANSITION_MS',
    DEFAULT_ATTENDANCE_TRANSITION_MS,
  )
  const botActionMinMs = parsePositiveIntEnv('BELOT_LOCAL_BOT_ACTION_MIN_MS', DEFAULT_BOT_ACTION_MIN_MS)
  const botActionMaxMsRaw = parsePositiveIntEnv('BELOT_LOCAL_BOT_ACTION_MAX_MS', DEFAULT_BOT_ACTION_MAX_MS)
  const botActionMaxMs = Math.max(botActionMinMs, botActionMaxMsRaw)

  return { attendanceFirstMatchMs, attendanceTransitionMs, botActionMinMs, botActionMaxMs }
}

export function pickLocalTournamentTestBotActionDelayMs(
  overrides: LocalTournamentTestTimingOverrides,
): number {
  const { botActionMinMs, botActionMaxMs } = overrides
  if (botActionMaxMs <= botActionMinMs) return botActionMinMs
  return botActionMinMs + Math.floor(Math.random() * (botActionMaxMs - botActionMinMs + 1))
}

// ─── Тестова DB пътека ──────────────────────────────────────────────────────

const DEFAULT_TEST_DATABASE_FILENAME = 'belot-v2-tournament-test.sqlite'
const PRODUCTION_DATABASE_FILENAME = 'belot-v2.sqlite'
/** Маркер, който всяка местна тестова база трябва да съдържа в пътя си —
 * прави невъзможно случайно сочене към споделената production/development
 * база (виж §4 в task spec-а: "спира, ако target DB path сочи към
 * production или обичайната development база"). */
const REQUIRED_PATH_MARKER = 'tournament-test'

function getServerRootPath(): string {
  const currentFilePath = fileURLToPath(import.meta.url)
  // server/src/localTournamentTest/.. .. = server/
  return resolve(dirname(currentFilePath), '..', '..')
}

export function getDefaultLocalTournamentTestDatabaseFilePath(): string {
  return join(getServerRootPath(), 'database', 'data', DEFAULT_TEST_DATABASE_FILENAME)
}

/** Хвърля, ако candidatePath сочи към споделената production/development база
 * или не носи еднозначния "tournament-test" маркер в пътя си. Ползва се и от
 * server startup wiring-а, и от reset/seed скриптовете — единствената
 * validation точка (виж §4/§15 в task spec-а). */
export function assertSafeLocalTournamentTestDatabasePath(candidatePath: string): void {
  const normalized = candidatePath.replace(/\\/g, '/').toLowerCase()
  if (normalized.endsWith(`/${PRODUCTION_DATABASE_FILENAME}`) || normalized === PRODUCTION_DATABASE_FILENAME) {
    throw new Error(
      `Refusing to use "${candidatePath}" as the local tournament test database — this is the shared ` +
        `production/development database file. Set BELOT_LOCAL_TOURNAMENT_TEST_DB_PATH to a dedicated file.`,
    )
  }
  if (!normalized.includes(REQUIRED_PATH_MARKER)) {
    throw new Error(
      `Refusing to use "${candidatePath}" as the local tournament test database — the path must contain ` +
        `"${REQUIRED_PATH_MARKER}" so it is unambiguously a disposable test database.`,
    )
  }
}

/** Резолвва пътя до тестовата база (BELOT_LOCAL_TOURNAMENT_TEST_DB_PATH или
 * default-а по-горе) и я валидира. Хвърля при опасен път — извикващият
 * (index.ts startup) трябва да остави грешката да спре стартирането, а не
 * да я поглъща (виж §4: "спира, ако..."). */
export function getLocalTournamentTestDatabaseFilePath(): string {
  const override = process.env.BELOT_LOCAL_TOURNAMENT_TEST_DB_PATH
  const candidate =
    override !== undefined && override.trim() !== ''
      ? resolve(override.trim())
      : getDefaultLocalTournamentTestDatabaseFilePath()
  assertSafeLocalTournamentTestDatabasePath(candidate)
  return candidate
}
