import type { ServerState } from './serverTypes.js'

export function createInitialServerState(): ServerState {
  return {
    startedAt: Date.now(),
    connections: {},
    rooms: {},
  }
}