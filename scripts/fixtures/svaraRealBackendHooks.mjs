// Imported explicitly by the isolated test child's private runner. No HTTP
// endpoint, auth override, fake game clock, RNG or runtime replacement.
import { Server } from 'node:http'

const nonce = process.env.SVARA_HARNESS_NONCE
if (process.env.NODE_ENV !== 'test' || !nonce || typeof process.send !== 'function'
  || Number(process.env.SVARA_HARNESS_PARENT_PID) !== process.ppid) {
  throw new Error('Svara harness hook requires test mode and a private parent IPC channel')
}
const send = (event, fields = {}) => process.send?.({ event, nonce, pid: process.pid, parentPid: process.ppid, ...fields })
const shutdown = () => {
  // A parent can disappear before the real server installs its signal handler.
  if (process.listenerCount('SIGTERM') === 0) process.exit(1)
  process.emit('SIGTERM', 'SIGTERM')
}
send('identity')
const listen = Server.prototype.listen
Server.prototype.listen = function (...args) {
  this.once('listening', () => send('listening', { address: this.address() }))
  return Reflect.apply(listen, this, args)
}
process.on('message', (message) => {
  if (message?.nonce === nonce && message.command === 'shutdown') shutdown()
})
process.once('disconnect', shutdown)
