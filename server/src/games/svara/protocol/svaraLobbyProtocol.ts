import type { SvaraEntryPercent, SvaraStartMode } from '../engine/svaraMatch.js'
import type { SvaraMatchSnapshotMessage, SvaraPublicTable } from './svaraSnapshotProtocol.js'
export type { SvaraPublicTable } from './svaraSnapshotProtocol.js'

export type SvaraLobbyClientMessage =
  | { type: 'request_svara_tables_list' }
  | { type: 'create_svara_table'; requestId: string; capacity: 2 | 3 | 4; entryFee: number; entryPercent: SvaraEntryPercent; startMode: SvaraStartMode }
  | { type: 'join_svara_table' | 'leave_svara_table' | 'start_svara_table'; matchId: string; requestId: string }
  | { type: 'request_svara_table_state'; matchId: string }

export type SvaraLobbyErrorCode =
  | 'feature_disabled' | 'unauthenticated' | 'forbidden_role'
  | 'invalid_input' | 'match_not_found' | 'already_seated' | 'table_full'
  | 'not_a_participant' | 'not_allowed' | 'wrong_phase' | 'command_id_conflict'
  | 'other_game_commitment' | 'svara_commitment' | 'server_unavailable'

export type SvaraLobbyServerMessage =
  | { type: 'svara_tables_list'; tables: SvaraPublicTable[] }
  | { type: 'svara_table_updated'; table: SvaraPublicTable; requestId?: string }
  | { type: 'svara_table_left'; matchId: string; requestId?: string }
  | { type: 'svara_lobby_error'; code: SvaraLobbyErrorCode; message: string; requestId?: string }
  | SvaraMatchSnapshotMessage

export const SVARA_LOBBY_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'request_svara_tables_list', 'create_svara_table', 'join_svara_table',
  'leave_svara_table', 'start_svara_table', 'request_svara_table_state',
])

const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 64

/** Rebuild from a whitelist. Identity, system commands and engine state are never copied. */
export function parseSvaraLobbyMessage(input: Record<string, unknown>): SvaraLobbyClientMessage | null {
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
