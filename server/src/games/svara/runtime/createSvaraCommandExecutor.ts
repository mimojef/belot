import type { SvaraGameplayClientMessage } from '../protocol/svaraLobbyProtocol.js'
import type { SvaraMatchRuntime, SvaraTrustedActor } from './svaraMatchRuntime.js'

/** Single in-process owner today. No sockets, sessions, timers or raw state in
 * the command/result contract. A future IPC adapter must preserve ordering and
 * introduce admission reservations before making create/join asynchronous. */
export function createSvaraCommandExecutor(runtime: SvaraMatchRuntime) {
  return {
    execute(actor: SvaraTrustedActor, message: SvaraGameplayClientMessage) {
      const result = runtime.executeParticipantCommand(message.matchId, actor, message.commandId, message.command, message.expectedRevision)
      return { type: 'svara_command_result' as const, matchId: message.matchId,
        commandId: message.commandId, status: result.status,
        revision: runtime.getMatchRevision(message.matchId), phase: result.phase }
    },
    advanceOne(matchId: string): boolean {
      const command = runtime.getAutomaticCommand(matchId)
      if (!command) return false
      runtime.executeSystemCommand(matchId, `progress:${runtime.getMatchRevision(matchId)}:${command.type}`, command)
      return true
    },
  }
}
