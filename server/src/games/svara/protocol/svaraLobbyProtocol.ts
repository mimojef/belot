import type { SvaraEntryPercent, SvaraStartMode } from '../engine/svaraMatch.js'
import type { SvaraParticipantCommand } from '../runtime/svaraMatchRuntime.js'
import type { SvaraMatchSnapshotMessage, SvaraPublicTable } from './svaraSnapshotProtocol.js'
export type { SvaraPublicTable } from './svaraSnapshotProtocol.js'

export type SvaraLobbyClientMessage =
  | SvaraGameplayClientMessage
  | { type: 'request_svara_tables_list' }
  | { type: 'create_svara_table'; requestId: string; capacity: 2 | 3 | 4; entryFee: number; entryPercent: SvaraEntryPercent; startMode: SvaraStartMode }
  | { type: 'join_svara_table' | 'leave_svara_table' | 'start_svara_table'; matchId: string; requestId: string }
  | { type: 'request_svara_table_state'; matchId: string }

export type SvaraGameplayClientMessage = {
  type: 'submit_svara_command'
  matchId: string
  commandId: string
  expectedRevision: number
  command: Extract<SvaraParticipantCommand, { type: 'look' | 'act' | 'svara-join' | 'svara-decline' | 'request-return' | 'exit' }>
}

export type SvaraLobbyErrorCode =
  | 'feature_disabled' | 'unauthenticated' | 'forbidden_role'
  | 'invalid_input' | 'match_not_found' | 'already_seated' | 'table_full'
  | 'not_a_participant' | 'not_allowed' | 'wrong_phase' | 'command_id_conflict'
  | 'other_game_commitment' | 'svara_commitment' | 'server_unavailable'
  | 'stale_action' | 'invalid_action' | 'not_your_turn' | 'insufficient_chips' | 'look_required'
  | 'player_absent'

export type SvaraLobbyServerMessage =
  | { type: 'svara_match_timing'; matchId: string; revision: number; serverNow: number;
      deadlines: Array<{ kind: 'turn' | 'svara-joining' | 'presence-wait'; deadlineAt: number; remainingMs: number; playerId: string | null }> }
  | { type: 'svara_command_result'; matchId: string; commandId: string; status: 'applied' | 'duplicate'; revision: number; phase: SvaraPublicTable['phase'] }
  | { type: 'svara_command_error'; code: SvaraLobbyErrorCode; message: string; commandId?: string }
  | { type: 'svara_tables_list'; tables: SvaraPublicTable[] }
  | { type: 'svara_table_updated'; table: SvaraPublicTable; requestId?: string }
  | { type: 'svara_table_left'; matchId: string; requestId?: string }
  | { type: 'svara_lobby_error'; code: SvaraLobbyErrorCode; message: string; requestId?: string }
  | SvaraMatchSnapshotMessage

export const SVARA_LOBBY_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'request_svara_tables_list', 'create_svara_table', 'join_svara_table',
  'leave_svara_table', 'start_svara_table', 'request_svara_table_state',
  'submit_svara_command',
])

const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 64

/** Rebuild from a whitelist. Identity, system commands and engine state are never copied. */
export function parseSvaraLobbyMessage(input: Record<string, unknown>): SvaraLobbyClientMessage | null {
  if (input.type === 'submit_svara_command') {
    if (!validId(input.matchId) || !validId(input.commandId) || !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0) return null
    const command = input.command
    if (!command || typeof command !== 'object' || Array.isArray(command)) return null
    const c = command as Record<string, unknown>
    let normalized: SvaraGameplayClientMessage['command']
    if (c.type === 'look' || c.type === 'svara-join' || c.type === 'svara-decline' || c.type === 'request-return' || c.type === 'exit') normalized = { type: c.type }
    else if (c.type === 'act') {
      if (!c.action || typeof c.action !== 'object' || Array.isArray(c.action)) return null
      const a = c.action as Record<string, unknown>
      if (a.kind === 'bet' || a.kind === 'blind-bet') {
        if (typeof a.total !== 'number' || !Number.isSafeInteger(a.total) || a.total <= 0) return null
        normalized = { type: 'act', action: { kind: a.kind, total: a.total } }
      } else if (a.kind === 'fold' || a.kind === 'call' || a.kind === 'all-in' || a.kind === 'no-bet') {
        normalized = { type: 'act', action: { kind: a.kind } }
      } else return null
    } else return null
    return { type: input.type, matchId: input.matchId, commandId: input.commandId, expectedRevision: input.expectedRevision as number, command: normalized }
  }
  if (input.type === 'request_svara_tables_list') return { type: input.type }
  if (input.type === 'request_svara_table_state') {
    return validId(input.matchId) ? { type: input.type, matchId: input.matchId } : null
  }
  if (!validId(input.requestId)) return null
  if (input.type === 'create_svara_table') {
    if (input.capacity !== 2 && input.capacity !== 3 && input.capacity !== 4) return null
    if (typeof input.entryFee !== 'number' || !Number.isSafeInteger(input.entryFee) || input.entryFee <= 0 || input.entryFee % 10 !== 0) return null
    if (input.startMode !== 'auto' && input.startMode !== 'manual') return null
    const entryPercent = input.entryPercent === undefined ? 1 : input.entryPercent
    if (entryPercent !== 1 && entryPercent !== 2 && entryPercent !== 3 && entryPercent !== 5) return null
    return { type: input.type, requestId: input.requestId, capacity: input.capacity, entryFee: input.entryFee, entryPercent, startMode: input.startMode }
  }
  if (input.type === 'join_svara_table' || input.type === 'leave_svara_table' || input.type === 'start_svara_table') {
    return validId(input.matchId) ? { type: input.type, matchId: input.matchId, requestId: input.requestId } : null
  }
  return null
}
