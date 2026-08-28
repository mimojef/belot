import type { WebSocket } from 'ws'

// Monitoring-only, best-effort hook — вика се на всяко outbound WS съобщение
// (единствен choke point за целия сървър, виж monitoring audit §4). Не
// пипа съдържанието, само таг по payload.type (bounded enum, никакъв raw
// съдържание). Дефолтва към no-op, ако не е зашита от index.ts wiring-а.
let onSentHook: ((messageType: string) => void) | null = null

export function setSendJsonMessageMonitoringHook(hook: ((messageType: string) => void) | null): void {
  onSentHook = hook
}

function extractMessageType(payload: unknown): string | null {
  if (payload !== null && typeof payload === 'object' && 'type' in payload) {
    const type = (payload as { type: unknown }).type
    return typeof type === 'string' ? type : null
  }
  return null
}

export function sendJsonMessage<T>(socket: WebSocket, payload: T): void {
  socket.send(JSON.stringify(payload))
  if (onSentHook !== null) {
    const messageType = extractMessageType(payload)
    if (messageType !== null) onSentHook(messageType)
  }
}
