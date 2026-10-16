// Single-owner adapter: checks + synchronous runtime mutations never yield to another request.
// Deploy on one process; multi-process hosting requires affinity/shared coordination first.
import { randomUUID } from 'node:crypto'
import { evaluateSvaraAccess, type SvaraAccessSession } from './svaraAccess.js'
import { SvaraMatchError } from './engine/svaraMatch.js'
import { createSvaraMatchRuntime, SvaraRuntimeError, type SvaraMatchRuntime } from './runtime/svaraMatchRuntime.js'
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
  onError?: (error: unknown) => void
  onAdmission?: (profileId: string) => void
}) {
  const runtime = deps.runtime ?? createSvaraMatchRuntime()
  const connections = new Map<string, Transport>()
  const subscribers = new Set<string>()

  const publicTables = () => runtime.listMatchIds().map((id) => runtime.getPublicTable(id))
    .filter((table) => table.phase === 'lobby' || table.phase === 'in-progress')
  function findCommitment(profileId: string) {
    return publicTables().find((table) => table.players.some((p) => p.playerId === profileId && (p.status === 'active' || p.status === 'absent'))) ?? null
  }
  function error(transport: Transport, code: SvaraLobbyErrorCode, requestId?: string) {
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
    }
    transport.send({ type: 'svara_lobby_error', code, message: messages[code], ...(requestId ? { requestId } : {}) })
  }
  function snapshot(transport: Transport, matchId: string, playerId: string) {
    // Only the branded 2Б.3.2 builder output may cross the socket boundary.
    transport.send(serializeSvaraSnapshotForClient(runtime.getPlayerSnapshot(matchId, { playerId })))
  }
  function publish(matchId: string, previousPlayers: string[]) {
    const table = runtime.getPublicTable(matchId)
    const tables = publicTables()
    const recipients = new Set([...previousPlayers, ...table.players.map((p) => p.playerId)])
    for (const [connectionId, transport] of connections) {
      if (!subscribers.has(connectionId) && (transport.profileId === null || !recipients.has(transport.profileId))) continue
      const session = transport.getSession()
      if (!evaluateSvaraAccess(session).allowed || !session?.profile.profileId) continue
      const playerId = session.profile.profileId
      const player = table.players.find((p) => p.playerId === playerId)
      if (player && player.status !== 'exited') {
        transport.send({ type: 'svara_table_updated', table })
        snapshot(transport, matchId, playerId)
      } else if (previousPlayers.includes(playerId)) {
        transport.send({ type: 'svara_table_left', matchId })
      }
      if (subscribers.has(connectionId)) transport.send({ type: 'svara_tables_list', tables })
    }
  }

  return {
    attachConnection(connectionId: string, transport: Transport) { connections.set(connectionId, transport) },
    // Disconnect is NOT leave/exit: no runtime command and no membership change.
    disconnect(connectionId: string) { connections.delete(connectionId); subscribers.delete(connectionId) },
    findCommitment,
    handle(connectionId: string, input: SvaraLobbyClientMessage, shuttingDown = false) {
      const transport = connections.get(connectionId)
      if (!transport) return
      const session = transport.getSession()
      const decision = evaluateSvaraAccess(session)
      const requestId = 'requestId' in input ? input.requestId : undefined
      if (!decision.allowed) { error(transport, decision.reason, requestId); return }
      if (shuttingDown) { error(transport, 'server_unavailable', requestId); return }
      // Defense in depth for direct callers as well as the network parser.
      const message = parseSvaraLobbyMessage(input)
      if (!message) { error(transport, 'invalid_input'); return }
      const playerId = session!.profile.profileId!
      try {
        if (message.type === 'request_svara_tables_list') {
          subscribers.add(connectionId)
          transport.send({ type: 'svara_tables_list', tables: publicTables() })
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
          transport.send({ type: 'svara_table_updated', table: runtime.getPublicTable(matchId), requestId })
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
        if (message.type === 'join_svara_table') deps.onAdmission?.(playerId)
        if (message.type === 'leave_svara_table') transport.send({ type: 'svara_table_left', matchId: message.matchId, requestId })
        else transport.send({ type: 'svara_table_updated', table: runtime.getPublicTable(message.matchId), requestId })
        publish(message.matchId, before.players.map((p) => p.playerId))
      } catch (cause) {
        if (cause instanceof SvaraRuntimeError || cause instanceof SvaraMatchError) {
          const codes: Record<string, SvaraLobbyErrorCode> = {
            'invalid-input': 'invalid_input', 'invalid-command': 'invalid_input',
            'match-not-found': 'match_not_found', 'not-a-participant': 'not_a_participant',
            'not-allowed': 'not_allowed', 'command-not-allowed': 'not_allowed',
            'wrong-phase': 'wrong_phase', 'command-id-conflict': 'command_id_conflict',
          }
          error(transport, codes[cause.code] ?? 'server_unavailable', requestId)
        } else {
          deps.onError?.(cause)
          error(transport, 'server_unavailable', requestId)
        }
      }
    },
  }
}
