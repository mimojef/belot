// ВРЕМЕННА production диагностика за Ludo lifecycle race/re-investigation
// (виж task-а "temporary 24h Ludo diagnostics") — цел: reconstruct-ване на
// request -> authoritative state -> accepted/rejected -> finished -> cleanup
// последователността за ВСИЧКИ реални Ludo игри, за да хванем рядкия
// "Зарът не може да бъде хвърлен сега." lobby-bleed race.
//
// НЕ Е permanent infrastructure — activation е изцяло gate-нат от
// LUDO_DIAGNOSTICS_UNTIL env var (absolute UTC ISO timestamp), fail-closed
// при липсващ/malformed/expired env (виж isLudoDiagnosticsEnabled по-долу).
// Append-only JSONL, event-driven (никакви timers/polling/snapshot-per-tick
// логове), fire-and-forget writes — виж writeLudoDiagnosticEvent за пълния
// fail-safe rationale (diagnostic write failure никога не бива да пипа
// gameplay control flow).
//
// Path: server/database/diagnostics/ludo-diagnostics.jsonl — resolve-нат
// спрямо ТОЗИ файл (mirror на getServerRootPath() pattern в
// ensureServerDatabaseReady.ts), НЕ спрямо process.cwd() — стабилен
// независимо от deploy working directory. server/database/ вече е
// established application-owned persistent директория (виж
// server/database/backups/, server/database/data/ — и двете
// .gitignore-нати като "runtime"/"generated на сървъра, не в git"),
// извън всякаква timestamped release/deploy директория.

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type LudoDiagnosticEvent =
  | 'ludo_match_started'
  | 'ludo_roll_request_received'
  | 'ludo_roll_accepted'
  | 'ludo_roll_rejected'
  | 'ludo_move_request_received'
  | 'ludo_move_accepted'
  | 'ludo_move_rejected'
  | 'ludo_state_request_received'
  | 'ludo_state_request_rejected'
  | 'ludo_match_finished'
  | 'ludo_match_cleanup_scheduled'
  | 'ludo_match_removed'

// Само полета, изрично поискани в task spec §3 — умишлено НЕ включва
// connectionId/IP/user-agent/session/auth token/каквото и да е извън тесния
// gameplay-correlation набор (виж task spec §1 "не логвай").
export type LudoDiagnosticFields = {
  matchId?: string
  ludoRoomId?: string
  profileId?: string
  requestType?: string
  requestRevision?: number
  authoritativeRevision?: number
  matchStatus?: 'in_progress' | 'finished'
  currentTurnColor?: string
  currentTurnProfileId?: string
  turnPhase?: string
  result?: 'accepted' | 'rejected'
  errorCode?: string
  winnerProfileId?: string | null
}

const __dirname = dirname(fileURLToPath(import.meta.url))
// server/src/diagnostics/ -> ../.. -> server/
const SERVER_ROOT_PATH = resolve(__dirname, '..', '..')
const DIAGNOSTICS_LOG_PATH = join(SERVER_ROOT_PATH, 'database', 'diagnostics', 'ludo-diagnostics.jsonl')

// Parse-ва LUDO_DIAGNOSTICS_UNTIL при ВСЕКИ log attempt (не кешира при
// module load) — established конвенция в repo-то (виж
// resolveServerBotActionDelayMs в serverTimerStateHelpers.ts за same
// "чети process.env всеки път, не кеширай" pattern), позволява env
// промяна/restart да влезе в сила веднага без redeploy на самия код.
// Fail-closed на ВСЯКА неяснота (виж task spec §5): липсващ env, malformed
// ISO string, или Date.now() >= UNTIL -> disabled. Никога не хвърля.
export function isLudoDiagnosticsEnabled(now: number = Date.now()): boolean {
  const raw = process.env.LUDO_DIAGNOSTICS_UNTIL
  if (!raw || raw.trim() === '') return false
  const untilMs = Date.parse(raw)
  if (Number.isNaN(untilMs)) return false
  return now < untilMs
}

function nowIso(): string {
  return new Date().toISOString()
}

// Сериализира един diagnostic event като точно ЕДИН JSONL ред (обект,
// последван от \n) — изолирано, pure (не пипа файлова система), за да е
// safe за unit test без production path (виж task spec §10 "изолирай
// serializer/writer достатъчно чисто, за да може да се тества без
// production path").
export function serializeLudoDiagnosticEvent(
  event: LudoDiagnosticEvent,
  fields: LudoDiagnosticFields = {},
): string {
  const entry: Record<string, unknown> = { timestamp: nowIso(), event }
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) entry[key] = value
  }
  return `${JSON.stringify(entry)}\n`
}

// Изолиран, testable write step — appendFile към произволен path, без да
// пипа env/isLudoDiagnosticsEnabled/production DIAGNOSTICS_LOG_PATH (виж
// task spec §10 "изолирай serializer/writer достатъчно чисто, за да може да
// се тества без production path"). Никога не хвърля извън себе си —
// caller-ят (writeLudoDiagnosticLine по-долу) прихваща.
async function appendDiagnosticLine(filePath: string, line: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await appendFile(filePath, line, 'utf8')
}

// Fire-and-forget append към production path — ГАРАНТИРАНО никога не
// хвърля/reject-ва навън (виж task spec §7 "diagnostic logging никога не
// трябва да... crash-ва server process"). Caller-ите (index.ts gameplay
// handler-ите) извикват това БЕЗ await в hot path-а — diagnostic write
// latency никога не бави gameplay response-а. Write failure -> единичен
// console.error (established defense-in-depth конвенция в целия този
// файл/index.ts, виж persistLudoMatchSnapshot и sibling try/catch
// блоковете), без retry/recursion, без по-нататъшен ефект върху control
// flow.
export function logLudoDiagnosticEvent(
  event: LudoDiagnosticEvent,
  fields: LudoDiagnosticFields = {},
): void {
  if (!isLudoDiagnosticsEnabled()) return
  const line = serializeLudoDiagnosticEvent(event, fields)
  void appendDiagnosticLine(DIAGNOSTICS_LOG_PATH, line).catch((error: unknown) => {
    console.error('[ludo-diagnostics] write failed (gameplay unaffected)', error)
  })
}

// Test-only entry point — реален file-I/O round-trip към произволен
// (temp-dir) path, БЕЗ да минава през isLudoDiagnosticsEnabled/env/
// production DIAGNOSTICS_LOG_PATH. Production кодът никога не вика това
// директно (винаги logLudoDiagnosticEvent, gate-нат от env).
export async function writeLudoDiagnosticLineForTest(filePath: string, line: string): Promise<void> {
  await appendDiagnosticLine(filePath, line)
}

export const __internal = {
  DIAGNOSTICS_LOG_PATH,
}
