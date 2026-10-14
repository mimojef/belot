// Belot hand journal — постоянен, структуриран диагностичен журнал за всяко
// раздаване (виж README-то в docs/belot-hand-journal.md за схемата, мястото
// на файловете и извличането от VPS).
//
// Съдържа пълните ръце на играчите — САМО за сървърна диагностика. Никога не
// се изпраща към клиенти, зрители или публични API. Не съдържа connectionId,
// IP, user-agent, session/reconnect токени или пароли.

import type { Seat, Team } from '../../core/serverTypes.js'

export const BELOT_HAND_JOURNAL_SCHEMA = 'belot-hand-journal'
// Увеличава се при несъвместима промяна на payload формата. Всеки ред носи
// версията си, затова старите редове/архиви остават четими.
export const BELOT_HAND_JOURNAL_SCHEMA_VERSION = 1

export type BelotHandJournalEventType =
  | 'hand_started'
  | 'bidding_completed'
  | 'hand_redeal'
  | 'trick_completed'
  | 'sweep_offered'
  | 'sweep_declined'
  | 'sweep_accept_rejected'
  | 'sweep_accepted'
  | 'hand_scored'
  | 'hand_abandoned'
  | 'match_ended'
  | 'anomaly'

export type BelotHandJournalSeverity = 'info' | 'anomaly'

export type BelotHandJournalAnomalyType =
  | 'deal_integrity'
  | 'card_not_in_hand'
  | 'illegal_card_play'
  | 'played_history_mismatch'
  | 'trick_winner_mismatch'
  | 'trick_sequence_invalid'
  | 'hand_cards_integrity'
  | 'raw_points_total_invalid'
  | 'scoring_recompute_mismatch'
  | 'raw_vs_awarded_unexplained'
  | 'capot_misapplied'
  | 'carry_over_misapplied'
  | 'match_total_mismatch'
  | 'unexplained_match_score_change'
  | 'duplicate_hand_scoring'
  | 'client_snapshot_mismatch'
  | 'sweep_recheck_failed'
  | 'journal_internal_error'

export type BelotHandJournalCheck = {
  name: string
  ok: boolean
  // Кратко описание какво е проверено / какво се е разминало.
  detail?: string
  anomalyType?: BelotHandJournalAnomalyType
  data?: Record<string, unknown>
}

// Как е стигнала промяната до главната нишка — нужно, за да различим
// решение на играч от изтекъл таймер / бот.
export type BelotHandJournalOrigin = 'direct_submit' | 'worker_tick'

export type BelotHandJournalEvent = {
  schema: typeof BELOT_HAND_JOURNAL_SCHEMA
  schemaVersion: number
  eventType: BelotHandJournalEventType
  severity: BelotHandJournalSeverity
  occurredAtMs: number
  occurredAt: string
  roomId: string
  matchId: string
  handId: string | null
  // Профилите на масата (само при hand_started) — за търсене по профил.
  profileIds?: string[]
  payload: Record<string, unknown>
}

export type BelotHandJournalSeatPlayer = {
  seat: Seat
  team: Team
  kind: 'human' | 'bot' | 'empty'
  profileId: string | null
  displayName: string | null
  botCode: string | null
  botDifficulty: string | null
  stateMode: 'human' | 'bot' | null
  controlledByBot: boolean
}

export type BelotHandJournalPlaySource =
  | 'human_manual'
  | 'human_timeout_auto'
  | 'bot_original'
  | 'bot_takeover'
  | 'unknown'
