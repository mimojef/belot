/** Public waiting-room presentation must never change durable game state. */
import assert from 'node:assert/strict'
import { createSvaraLobby } from '../src/games/svara/createSvaraLobby.js'
import { createSvaraMatchRuntime } from '../src/games/svara/runtime/svaraMatchRuntime.js'
import type { SvaraLobbyClientMessage, SvaraLobbyServerMessage } from '../src/games/svara/protocol/svaraLobbyProtocol.js'

const flag = process.env.SVARA_TEST_ENABLED
process.env.SVARA_TEST_ENABLED = '1'
const runtime = createSvaraMatchRuntime()
const profiles = new Map([
  ['owner', { displayName: 'Истински създател', avatarUrl: '/uploads/owner.webp', email: 'private@example.test', wallet: 999 }],
  ['guest', { displayName: 'Друг участник', avatarUrl: null, email: 'secret@example.test', wallet: 123 }],
])
const frames = new Map<string, SvaraLobbyServerMessage[]>()
const errors: unknown[] = []
let failLookup = false
const lobby = createSvaraLobby({ runtime, hasOtherGameCommitment: () => false,
  getPublicProfile: (id) => { if (failLookup) throw new Error('Profile store unavailable'); return profiles.get(id) ?? null },
  onError: (error) => errors.push(error) })
function attach(id: string, role = 'admin') {
  frames.set(id, [])
  lobby.attachConnection(id, { profileId: id, getSession: () => ({ account: { role }, profile: { profileId: id } }),
    send: (frame) => frames.get(id)!.push(typeof frame === 'string' ? JSON.parse(frame) : frame) })
}
const send = (id: string, message: SvaraLobbyClientMessage) => lobby.handle(id, message)
function listed(id: string) {
  send(id, { type: 'request_svara_tables_list' })
  const last = frames.get(id)!.at(-1)!
  assert.equal(last.type, 'svara_tables_list')
  if (last.type !== 'svara_tables_list') throw new Error('No list')
  return last.tables[0]!
}
try {
  attach('owner'); attach('guest'); attach('missing'); attach('denied', 'user')
  // Untrusted profile fields in a raw command cannot replace server metadata.
  send('owner', { type: 'create_svara_table', requestId: 'create', capacity: 4, entryFee: 20000, entryPercent: 1,
    startMode: 'manual', displayName: 'Forged', avatarUrl: '/forged.png' } as SvaraLobbyClientMessage)
  const table = listed('owner')
  const matchId = table.matchId
  assert.deepEqual(table.players[0], { playerId: 'owner', status: 'active', displayName: 'Истински създател', avatarUrl: '/uploads/owner.webp' })
  send('guest', { type: 'join_svara_table', requestId: 'join', matchId })
  send('missing', { type: 'join_svara_table', requestId: 'join', matchId })
  const durable = runtime.exportStoredMatchForServer(matchId)
  const publicTable = listed('guest')
  assert.deepEqual(publicTable.players[1], { playerId: 'guest', status: 'active', displayName: 'Друг участник', avatarUrl: null })
  assert.deepEqual(publicTable.players[2], { playerId: 'missing', status: 'active', displayName: null, avatarUrl: null })
  for (const player of publicTable.players) assert.deepEqual(Object.keys(player).sort(), ['avatarUrl', 'displayName', 'playerId', 'status'])
  assert(!JSON.stringify(publicTable).includes('private@example.test'))
  assert(!JSON.stringify(publicTable).includes('wallet'))
  assert(runtime.getPublicTable(matchId).players.every((player) => !('displayName' in player)), 'Presentation mutated the runtime')
  profiles.get('guest')!.displayName = 'Обновено име'
  profiles.get('owner')!.avatarUrl = '/uploads/new-avatar.webp'
  lobby.disconnect('guest'); attach('guest'); lobby.reconnect('guest')
  assert.equal(listed('guest').players[1]!.displayName, 'Обновено име')
  assert.equal(listed('owner').players[0]!.avatarUrl, '/uploads/new-avatar.webp')
  assert.deepEqual(runtime.exportStoredMatchForServer(matchId), durable, 'List/reconnect/profile update changed persistence state')
  const count = frames.get('denied')!.length
  send('denied', { type: 'request_svara_tables_list' })
  assert.equal(frames.get('denied')!.length, count + 1)
  assert.equal(frames.get('denied')!.at(-1)!.type, 'svara_lobby_error')
  failLookup = true
  assert(listed('owner').players.every((player) => player.displayName === null && player.avatarUrl === null))
  assert.equal(errors.length, 3)
  assert.deepEqual(runtime.exportStoredMatchForServer(matchId), durable)
  failLookup = false
  send('guest', { type: 'leave_svara_table', requestId: 'leave', matchId })
  assert(!listed('owner').players.some((player) => player.playerId === 'guest'))
  send('guest', { type: 'join_svara_table', requestId: 'rejoin', matchId })
  assert.equal(listed('owner').players.find((player) => player.playerId === 'guest')!.displayName, 'Обновено име')
  console.log('PASS waiting profiles: authoritative names/avatar, explicit public whitelist, missing/unavailable store, role gate, refreshed metadata, join/leave, unchanged runtime/persistence')
} finally {
  lobby.shutdown()
  if (flag === undefined) delete process.env.SVARA_TEST_ENABLED
  else process.env.SVARA_TEST_ENABLED = flag
}
