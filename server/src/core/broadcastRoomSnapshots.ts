import { WebSocket } from 'ws'
import { createRoomSnapshotMessage } from '../protocol/createRoomSnapshotMessage.js'
import { sendSerializedJsonMessage } from './sendJsonMessage.js'
import { safeInvokeTimingHook, type MainThreadTimingHook } from '../monitoring/mainThreadTimingMetrics.js'
import {
  SERVER_SEAT_ORDER,
  type ConnectionId,
  type ServerRoom,
} from './serverTypes.js'

// Monitoring-only, best-effort hook — вика се веднъж на всяко broadcast
// събитие (не по получател, виж monitoring audit §4/§7 "room broadcast
// trigger"). Дефолтва към no-op.
let onBroadcastHook: (() => void) | null = null

export function setBroadcastRoomSnapshotsMonitoringHook(hook: (() => void) | null): void {
  onBroadcastHook = hook
}

// Belot Spectator Mode ("Гледай", Phase 2A) — централен spectator fan-out.
// Вика се веднъж на broadcast събитие, СЛЕД player snapshot-ите (които
// остават напълно непроменени) — така всичките 24 call site-а в index.ts
// автоматично покриват spectators без промяна. Wiring-ът (index.ts) подава
// broadcastBelotSpectatorSnapshot, който строи spectator payload-а максимум
// веднъж и само ако стаята има spectators. Дефолтва към no-op.
let spectatorFanoutHook: ((room: ServerRoom) => void) | null = null

export function setBroadcastRoomSnapshotsSpectatorHook(hook: ((room: ServerRoom) => void) | null): void {
  spectatorFanoutHook = hook
}

// Phase 0B — monitoring-only transport timings (label: build | stringify |
// send | spectatorFanout | total). Отделни от persistence stringify-а
// (roomSnapshotStringify в activeRoomSnapshotStore). null → без измерване.
let timingHook: MainThreadTimingHook | null = null

export function setBroadcastRoomSnapshotsTimingHook(hook: MainThreadTimingHook | null): void {
  timingHook = hook
}

export function broadcastRoomSnapshots(
  room: ServerRoom,
  socketRegistry: Map<ConnectionId, WebSocket>,
): void {
  onBroadcastHook?.()
  const hook = timingHook
  const broadcastStartedAt = hook !== null ? performance.now() : 0
  for (const seat of SERVER_SEAT_ORDER) {
    const participant = room.seats[seat].participant

    if (participant === null || participant.kind !== 'human') {
      continue
    }

    if (!participant.isConnected || participant.connectionId === null) {
      // Диагностика: room-level participant.isConnected е десинхронизирано
      // от connection-level status (виж submit_bid_action handler-а) —
      // snapshot никога не стига до този играч, без никаква грешка другаде.
      // Не логваме profileId/displayName — само roomId/seat/технически флаг.
      console.warn(
        `[room-snapshot] skip room=${room.id} seat=${seat}: participant not marked connected (isConnected=${participant.isConnected}, hasConnectionId=${participant.connectionId !== null})`,
      )
      continue
    }

    const socket = socketRegistry.get(participant.connectionId)

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      console.warn(
        `[room-snapshot] skip room=${room.id} seat=${seat}: socket not sendable (found=${socket !== undefined}, readyState=${socket?.readyState ?? 'n/a'})`,
      )
      continue
    }

    try {
      // Същото като sendJsonMessage(socket, createRoomSnapshotMessage(...)):
      // build → JSON.stringify → socket.send → monitoring hook с payload.type —
      // само разделено на стъпки, за да се мерят поотделно.
      const buildStartedAt = hook !== null ? performance.now() : 0
      const message = createRoomSnapshotMessage(room, seat)
      const stringifyStartedAt = hook !== null ? performance.now() : 0
      const serialized = JSON.stringify(message)
      const sendStartedAt = hook !== null ? performance.now() : 0
      sendSerializedJsonMessage(socket, serialized, message.type)
      if (hook !== null) {
        const sentAt = performance.now()
        safeInvokeTimingHook(hook, 'build', stringifyStartedAt - buildStartedAt)
        safeInvokeTimingHook(hook, 'stringify', sendStartedAt - stringifyStartedAt)
        safeInvokeTimingHook(hook, 'send', sentAt - sendStartedAt)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(
        `[room-snapshot] broadcast failed room=${room.id} connection=${participant.connectionId}: ${message}`,
      )
    }
  }

  if (spectatorFanoutHook !== null) {
    const spectatorStartedAt = hook !== null ? performance.now() : 0
    try {
      spectatorFanoutHook(room)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[room-snapshot] spectator fan-out failed room=${room.id}: ${message}`)
    }
    if (hook !== null) safeInvokeTimingHook(hook, 'spectatorFanout', performance.now() - spectatorStartedAt)
  }

  if (hook !== null) safeInvokeTimingHook(hook, 'total', performance.now() - broadcastStartedAt)
}
