// Imported ONLY by wrappers generated inside the harness's private server copy.
// No production module imports this file; no env flag or public endpoint enables it.
import { randomInt } from 'node:crypto'
import { SVARA_ORDERED_DECK, svaraCardCode } from './server/dist/games/svara/engine/svaraCards.js'

let configured = false, nonce, now, lostAck = null, blocked = false, service, runtime, shuffleRemaining = 0
const jobs = [], decks = [], swaps = []
const notify = (message) => process.send?.({ nonce, pid: process.pid, parentPid: process.ppid, ...message })
export const clock = {
  now: () => now,
  schedule(callback, delay) {
    const job = { at: now + delay, callback, active: true }; jobs.push(job)
    return () => { job.active = false }
  },
  defer(callback) { return clock.schedule(callback, 0) },
}
export const random = {
  nextInt(max) {
    if (max === 32) shuffleRemaining = 31
    if (max === 32 && decks.length) {
      const target = decks.shift(), work = SVARA_ORDERED_DECK.map(svaraCardCode)
      for (let i = 31; i > 0; i--) {
        const j = work.indexOf(target[i]); if (j < 0 || j > i) throw new Error('Invalid private deck fixture')
        swaps.push(j); [work[i], work[j]] = [work[j], work[i]]
      }
    }
    if (swaps.length) { if (max !== swaps.length + 1) throw new Error('Invalid private RNG sequence'); shuffleRemaining--; return swaps.shift() }
    if (shuffleRemaining > 0) { shuffleRemaining--; return randomInt(max) }
    return 0 // pin the first dealer outside a shuffle
  },
}
export function observeRuntime(value) { runtime = value; return value }

export function decorateService(value) {
  if (!configured) throw new Error('Private restart harness is not configured')
  service = value
  const initialize = value.lobby.initializeRecovery.bind(value.lobby)
  value.lobby.initializeRecovery = () => { const status = initialize(); notify({ event: 'recovery', status }); return status }
  const attach = value.lobby.attachConnection.bind(value.lobby)
  value.lobby.attachConnection = (connectionId, transport) => attach(connectionId, { ...transport, send(message) {
    if (blocked) return
    const frame = typeof message === 'string' ? JSON.parse(message) : message
    if (frame.type === 'svara_command_result' && frame.commandId === lostAck) {
      blocked = true
      // This transport boundary runs strictly AFTER the real SQLite commit.
      // Notify only metadata, block before send/fan-out/progression, then let the
      // parent kill its verified child. Never return to gameplay on a timeout.
      notify({ event: 'ack-blocked', commandId: frame.commandId, status: frame.status, revision: frame.revision })
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000)
      process.exit(86)
    }
    transport.send(message)
  } })
  const shutdown = value.lobby.shutdown.bind(value.lobby)
  value.lobby.shutdown = () => { shutdown(); notify({ event: 'lifecycle-stopped', pending: jobs.filter((j) => j.active).length }) }
  return value
}

export function configure(config) {
  if (process.env.NODE_ENV !== 'test' || configured || !process.send || !process.connected || process.ppid !== config.parentPid || typeof config.nonce !== 'string' || config.nonce.length < 32 ||
    !Number.isSafeInteger(config.now)) throw new Error('Refusing non-harness execution')
  configured = true; nonce = config.nonce; now = config.now
  decks.push(...(config.decks ?? []))
  process.on('message', (message) => {
    if (message?.nonce !== nonce || typeof message.id !== 'string') return
    try {
      let result
      switch (message.command) {
        case 'runtime-status': {
          if (!runtime) throw new Error('No observed private runtime')
          result = { matchIds: runtime.listMatchIds() }; break
        }
        case 'decks': decks.push(...message.decks); result = { queued: decks.length }; break
        case 'arm-ack': lostAck = message.commandId; result = { armed: true }; break
        case 'clock': {
          if (!Number.isSafeInteger(message.delta) || message.delta < 0) throw new Error('Invalid clock step')
          const end = now + message.delta
          for (let count = 0; ; count++) {
            if (count > 1024) throw new Error('Private clock transition budget exceeded')
            const job = jobs.filter((j) => j.active && j.at <= end).sort((a, b) => a.at - b.at)[0]
            if (!job) break
            now = job.at; job.active = false; job.callback()
          }
          now = end; result = { now, pending: jobs.filter((j) => j.active).length }; break
        }
        case 'shutdown': {
          if (!service || process.listenerCount('SIGTERM') === 0) throw new Error('Backend is not ready for shutdown')
          notify({ reply: message.id, result: { shutdown: true } })
          setImmediate(() => process.emit('SIGTERM', 'SIGTERM')) // real registered graceful handler, including on Windows
          return
        }
        default: throw new Error('Unknown private harness command')
      }
      notify({ reply: message.id, result })
    } catch { notify({ reply: message.id, error: 'private-harness-command-failed' }) }
  })
  notify({ event: 'identity', parentPid: process.ppid })
}
