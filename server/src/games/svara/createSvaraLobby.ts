// Single-owner adapter: checks + synchronous runtime mutations never yield to another request.
// Deploy on one process; multi-process hosting requires affinity/shared coordination first.
import { randomUUID } from 'node:crypto'
import { evaluateSvaraAccess, type SvaraAccessSession } from './svaraAccess.js'
import { SvaraMatchError } from './engine/svaraMatch.js'
import { createSvaraMatchRuntime, SvaraRuntimeError, type SvaraMatchRuntime } from './runtime/svaraMatchRuntime.js'
import { createSvaraCommandExecutor } from './runtime/createSvaraCommandExecutor.js'
import { createSvaraLifecycle, type SvaraClock } from './runtime/createSvaraLifecycle.js'
import type { SvaraMatchPersistence } from './runtime/svaraPersistence.js'
import { parseSvaraLobbyMessage, type SvaraLobbyClientMessage, type SvaraLobbyErrorCode, type SvaraLobbyServerMessage } from './protocol/svaraLobbyProtocol.js'
import { serializeSvaraSnapshotForClient } from './protocol/svaraSnapshotProtocol.js'

type Transport = {
  /** Handshake identity used only to skip unrelated connections during broadcast. */
  profileId: string | null
  /** Live, validated WS session; re-evaluated before every request and delivery. */
  getSession: () => SvaraAccessSession
  send: (message: SvaraLobbyServerMessage | string) => void
}

export function createSvaraLobby(deps: {
  hasOtherGameCommitment: (profileId: string) => boolean
  runtime?: SvaraMatchRuntime
  persistence?: SvaraMatchPersistence
  onError?: (error: unknown) => void
  onAdmission?: (profileId: string) => void
  clock?: SvaraClock
}) {
  // An injected runtime is a test/server-owned dependency. Production always supplies persistence.
  if (deps.runtime && deps.persistence) throw new Error('Provide persistence through the injected Svara runtime')
  if (!deps.runtime && !deps.persistence) throw new Error('Svara lobby requires durable persistence or an explicitly injected runtime')
  const runtime = deps.runtime ?? createSvaraMatchRuntime({ persistence: deps.persistence, now: deps.clock?.now })
  const commands = createSvaraCommandExecutor(runtime)
  const connections = new Map<string, Transport>()
  const subscribers = new Set<string>()
  const lifecycle = createSvaraLifecycle(runtime, {
    clock: deps.clock, onError: deps.onError,
    onChange: (matchId, before) => publish(matchId, before.players.map((p) => p.playerId), JSON.stringify(before) !== JSON.stringify(runtime.getPublicTable(matchId))),
  })
  let stopped = false

  function deliver(transport: Transport, payload: SvaraLobbyServerMessage | string) {
    try { transport.send(payload) } catch (cause) { deps.onError?.(cause) }
  }

  const publicTables = () => runtime.listMatchIds().map((id) => runtime.getPublicTable(id))
    .filter((table) => table.phase === 'lobby' || table.phase === 'in-progress')
  function findCommitment(profileId: string) {
    const current = publicTables().find((table) => table.players.some((p) => p.playerId === profileId && (p.status === 'active' || p.status === 'absent')))
    if (current) return current
    // No recovery yet: retain the durable commitment and never replace an orphaned active match.
    try {
      const matchId = deps.persistence?.findActiveMatchId(profileId)
      return matchId ? { matchId } : null
    } catch (cause) {
      deps.onError?.(cause)
      return { matchId: '' } // fail closed for cross-game admission if the store is unavailable
    }
  }
  function error(transport: Transport, code: SvaraLobbyErrorCode, requestId?: string, gameplay = false, commandId?: string) {
    // Fixed messages: never echo thrown engine errors, payloads, IDs or hidden state.
    const messages: Record<SvaraLobbyErrorCode, string> = {
      feature_disabled: 'Функцията не е достъпна.', unauthenticated: 'Трябва да влезеш в профила си.',
      forbidden_role: 'Нямаш достъп.', invalid_input: 'Невалидна заявка.',
      match_not_found: 'Масата не е намерена.', already_seated: 'Вече имаш място на масата.',
      table_full: 'Всички места са заети.', not_a_participant: 'Не участваш на тази маса.',
      not_allowed: 'Действието не е позволено.', wrong_phase: 'Действието не е позволено в този етап.',
      command_id_conflict: 'Идентификаторът вече е използван за друга команда.',
      other_game_commitment: 'Вече участваш в друга игра.', svara_commitment: 'Вече участваш на маса за Свара.',
      server_unavailable: 'Сървърът временно не е наличен.',
      stale_action: 'Играта вече е обновена. Поискай текущото състояние.',
      invalid_action: 'Невалидно игрово действие.', not_your_turn: 'Не е твоят ред.',
      insufficient_chips: 'Недостатъчно игрови чипове.', look_required: 'Първо погледни собствените си карти.',
      player_absent: 'Отсъстваш. Заяви връщане за следващото раздаване.',
    }
    if (gameplay) deliver(transport, { type: 'svara_command_error', code, message: messages[code], ...(commandId ? { commandId } : {}) })
    else deliver(transport, { type: 'svara_lobby_error', code, message: messages[code], ...(requestId ? { requestId } : {}) })
  }
  function snapshot(transport: Transport, matchId: string, playerId: string) {
    // Only the branded 2Б.3.2 builder output may cross the socket boundary.
    deliver(transport, serializeSvaraSnapshotForClient(runtime.getPlayerSnapshot(matchId, { playerId })))
    deliver(transport, lifecycle.timing(matchId))
  }
  function publish(matchId: string, previousPlayers: string[], publicChanged = true) {
    const table = runtime.getPublicTable(matchId)
    const tables = publicChanged ? publicTables() : []
    const recipients = new Set([...previousPlayers, ...table.players.map((p) => p.playerId)])
    for (const [connectionId, transport] of connections) {
      if (!subscribers.has(connectionId) && (transport.profileId === null || !recipients.has(transport.profileId))) continue
      const session = transport.getSession()
      if (!evaluateSvaraAccess(session).allowed || !session?.profile.profileId || session.profile.profileId !== transport.profileId) continue
      const playerId = session.profile.profileId
      const player = table.players.find((p) => p.playerId === playerId)
      if (player && player.status !== 'exited') {
        if (publicChanged) deliver(transport, { type: 'svara_table_updated', table })
        snapshot(transport, matchId, playerId)
      } else if (previousPlayers.includes(playerId)) {
        if (publicChanged) deliver(transport, { type: 'svara_table_left', matchId })
      }
      if (publicChanged && subscribers.has(connectionId)) deliver(transport, { type: 'svara_tables_list', tables })
    }
  }

  function progress(matchId: string) {
    if (stopped) return
    try { lifecycle.sync(matchId) } catch (cause) {
      // A participant command already committed must never be reported rejected
      // because a subsequent system transition failed. Preserve state for audit.
      deps.onError?.(cause)
    }
  }

  return {
    attachConnection(connectionId: string, transport: Transport) { connections.set(connectionId, transport) },
    reconnect(connectionId: string) {
      const transport = connections.get(connectionId)
      if (!transport || stopped) return
      const session = transport.getSession()
      if (!evaluateSvaraAccess(session).allowed || session?.profile.profileId !== transport.profileId || !transport.profileId) return
      const table = findCommitment(transport.profileId)
      if (!table || !runtime.hasMatch(table.matchId)) return
      progress(table.matchId)
      if (runtime.getPublicTable(table.matchId).players.some((p) => p.playerId === transport.profileId && p.status !== 'exited')) {
        snapshot(transport, table.matchId, transport.profileId)
      }
    },
    // Disconnect is NOT leave/exit: no runtime command and no membership change.
    disconnect(connectionId: string) { connections.delete(connectionId); subscribers.delete(connectionId) },
    shutdown() {
      stopped = true
      lifecycle.shutdown()
    },
    findCommitment,
    handle(connectionId: string, input: SvaraLobbyClientMessage, shuttingDown = false) {
      const transport = connections.get(connectionId)
      if (!transport) return
      const session = transport.getSession()
      const decision = evaluateSvaraAccess(session)
      const requestId = 'requestId' in input && typeof input.requestId === 'string' && input.requestId.trim() && input.requestId.length <= 64 ? input.requestId : undefined
      const isGameplay = input.type === 'submit_svara_command'
      const commandId = isGameplay && typeof input.commandId === 'string' && input.commandId.trim() && input.commandId.length <= 64 ? input.commandId : undefined
      const reject = (code: SvaraLobbyErrorCode) => error(transport, code, requestId, isGameplay, commandId)
      if (!decision.allowed) { reject(decision.reason); return }
      if (session?.profile.profileId !== transport.profileId) { reject('unauthenticated'); return }
      if (shuttingDown || stopped) { reject('server_unavailable'); return }
      // Defense in depth for direct callers as well as the network parser.
      const message = parseSvaraLobbyMessage(input)
      if (!message) { reject('invalid_input'); return }
      const playerId = session!.profile.profileId!
      try {
        // Expire due work before a command/read/reconnect, even if its Node
        // timer callback has not been dispatched. Admission stays synchronous.
        if ('matchId' in message && runtime.hasMatch(message.matchId)) lifecycle.sync(message.matchId)
        if (message.type === 'submit_svara_command') {
          if (!runtime.hasMatch(message.matchId)) { reject('match_not_found'); return }
          const before = runtime.getPublicTable(message.matchId)
          if (!before.players.some((p) => p.playerId === playerId)) { reject('not_a_participant'); return }
          const result = commands.execute({ playerId }, message)
          lifecycle.refresh(message.matchId)
          deliver(transport, result)
          if (result.status === 'duplicate') {
            if (before.players.some((p) => p.playerId === playerId && p.status !== 'exited')) snapshot(transport, message.matchId, playerId)
            return
          }
          const after = runtime.getPublicTable(message.matchId)
          publish(message.matchId, before.players.map((p) => p.playerId), JSON.stringify(before) !== JSON.stringify(after))
          progress(message.matchId)
          return
        }
        if (message.type === 'request_svara_tables_list') {
          subscribers.add(connectionId)
          deliver(transport, { type: 'svara_tables_list', tables: publicTables() })
          return
        }
        if (message.type === 'create_svara_table' || message.type === 'join_svara_table') {
          if (deps.hasOtherGameCommitment(playerId)) { error(transport, 'other_game_commitment', requestId); return }
          const commitment = findCommitment(playerId)
          if (commitment) {
            error(transport, message.type === 'join_svara_table' && commitment.matchId === message.matchId ? 'already_seated' : 'svara_commitment', requestId)
            return
          }
        }
        if (message.type === 'create_svara_table') {
          const matchId = randomUUID()
          runtime.registerMatch({ matchId, creator: { playerId }, capacity: message.capacity, entryFee: message.entryFee, entryPercent: message.entryPercent, startMode: message.startMode })
          deps.onAdmission?.(playerId)
          deliver(transport, { type: 'svara_table_updated', table: runtime.getPublicTable(matchId), requestId })
          publish(matchId, [])
          return
        }
        if (!runtime.hasMatch(message.matchId)) { error(transport, 'match_not_found', requestId); return }
        const before = runtime.getPublicTable(message.matchId)
        if (message.type === 'request_svara_table_state') {
          if (!before.players.some((p) => p.playerId === playerId && p.status !== 'exited')) {
            error(transport, 'not_a_participant'); return
          }
          snapshot(transport, message.matchId, playerId)
          return
        }
        if (message.type === 'join_svara_table' && before.phase === 'lobby' && before.players.length >= before.capacity) {
          error(transport, 'table_full', requestId); return
        }
        const type = message.type === 'join_svara_table' ? 'join-seat'
          : message.type === 'start_svara_table' ? 'start-match'
          : before.phase === 'lobby' ? 'leave-seat' : 'exit'
        runtime.executeParticipantCommand(message.matchId, { playerId }, message.requestId, { type })
        lifecycle.refresh(message.matchId)
        if (message.type === 'join_svara_table') deps.onAdmission?.(playerId)
        if (message.type === 'leave_svara_table') deliver(transport, { type: 'svara_table_left', matchId: message.matchId, requestId })
        else deliver(transport, { type: 'svara_table_updated', table: runtime.getPublicTable(message.matchId), requestId })
        publish(message.matchId, before.players.map((p) => p.playerId))
        progress(message.matchId)
      } catch (cause) {
        if (cause instanceof SvaraRuntimeError || cause instanceof SvaraMatchError) {
          const codes: Record<string, SvaraLobbyErrorCode> = {
            'invalid-input': 'invalid_input', 'invalid-command': 'invalid_input',
            'match-not-found': 'match_not_found', 'not-a-participant': 'not_a_participant',
            'not-allowed': 'not_allowed', 'command-not-allowed': 'not_allowed',
            'wrong-phase': 'wrong_phase', 'command-id-conflict': 'command_id_conflict',
            'stale-action': 'stale_action', 'betting:not-your-turn': 'not_your_turn',
            'betting:insufficient-chips': 'insufficient_chips', 'betting:look-required': 'look_required',
            'player-absent': 'player_absent',
          }
          reject(codes[cause.code] ?? (cause.code.startsWith('betting:') ? 'invalid_action' : 'server_unavailable'))
        } else {
          deps.onError?.(cause)
          reject('server_unavailable')
        }
      }
    },
  }
}
