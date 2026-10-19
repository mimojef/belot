/** New-table admission policy and historical recovery; no wallets or network. */
import assert from 'node:assert/strict'
import { createSvaraLobby } from '../src/games/svara/createSvaraLobby.js'
import { createSvaraMatchRuntime } from '../src/games/svara/runtime/svaraMatchRuntime.js'
import { parseSvaraLobbyMessage, type SvaraLobbyClientMessage, type SvaraLobbyServerMessage } from '../src/games/svara/protocol/svaraLobbyProtocol.js'
import { getSvaraTableCreationOptions, SVARA_TEST_ENTRY_FEES } from '../src/games/svara/svaraTableCreationOptions.js'

const expectedFees = [5000, 8000, 15000, 20000, 35000, 50000, 60000, 80000, 100000, 130000, 150000, 180000, 200000]
assert.deepEqual([...SVARA_TEST_ENTRY_FEES], expectedFees)
const options = getSvaraTableCreationOptions()
assert.equal(options.entryPercent, 1)
assert.deepEqual(options.entries.map((entry) => entry.entryFee), expectedFees)
for (const entry of options.entries) {
  assert.equal(entry.startingChips, entry.entryFee / 10)
  assert.equal(entry.entryChips * 100, entry.startingChips)
}

const previousFlag = process.env.SVARA_TEST_ENABLED
process.env.SVARA_TEST_ENABLED = '1'
let matrix = 0
try {
  for (const entryFee of expectedFees) for (const capacity of [2, 3, 4] as const) for (const startMode of ['auto', 'manual'] as const) {
    const runtime = createSvaraMatchRuntime()
    const lobby = createSvaraLobby({ runtime, hasOtherGameCommitment: () => false })
    try {
      const frames = new Map<string, SvaraLobbyServerMessage[]>()
      for (const id of ['host', 'p1', 'p2', 'p3', 'outsider']) {
        frames.set(id, [])
        lobby.attachConnection(id, { profileId: id, getSession: () => ({ account: { role: 'admin' }, profile: { profileId: id } }),
          send: (frame) => frames.get(id)!.push(typeof frame === 'string' ? JSON.parse(frame) : frame) })
      }
      lobby.handle('host', { type: 'create_svara_table', requestId: 'create', capacity, entryFee, entryPercent: 1, startMode })
      const created = frames.get('host')!.findLast((frame) => frame.type === 'svara_table_updated')!
      assert.equal(created.type, 'svara_table_updated')
      if (created.type !== 'svara_table_updated') throw new Error('Missing table')
      const matchId = created.table.matchId
      const apply = (id: string, type: 'join_svara_table' | 'start_svara_table', requestId: string = type) => lobby.handle(id, { type, matchId, requestId })
      apply('host', 'start_svara_table', 'premature')
      assert.equal(runtime.getPublicTable(matchId).phase, 'lobby', 'No start before capacity')
      for (let i = 1; i < capacity; i++) apply(`p${i}`, 'join_svara_table')
      assert.equal(runtime.getPublicTable(matchId).phase, startMode === 'auto' ? 'in-progress' : 'lobby')
      if (startMode === 'manual') {
        apply('p1', 'start_svara_table', 'foreign')
        assert.equal(runtime.getPublicTable(matchId).phase, 'lobby')
        assert.equal(frames.get('p1')!.at(-1)!.type, 'svara_lobby_error')
        apply('host', 'start_svara_table', 'start')
      }
      const before = runtime.exportStoredMatchForServer(matchId)
      apply('host', 'start_svara_table', 'start')
      apply(`p${capacity - 1}`, 'join_svara_table')
      apply('outsider', 'join_svara_table')
      assert.deepEqual(runtime.exportStoredMatchForServer(matchId), before, 'Repeated or late requests changed the started table')
      assert.equal(before.state.config.entryPercent, 1)
      assert.equal(before.state.startingChips, entryFee / 10)
      assert.equal(before.state.entryChips, entryFee / 1000)
      assert.equal(before.state.totalChips, capacity * entryFee / 10)
      const antes = before.state.ledger.filter((entry) => entry.type === 'entry')
      assert.equal(antes.length, capacity)
      assert(antes.every((entry) => entry.amount === entryFee / 1000))
      const restored = createSvaraMatchRuntime()
      restored.restoreMatchesForServer([before])
      assert.deepEqual(restored.exportStoredMatchForServer(matchId), before, 'Recovery changed ante, configuration, cards or ledger')
      matrix++
    } finally { lobby.shutdown() }
  }

  const base = { type: 'create_svara_table', requestId: 'policy', capacity: 2, entryFee: 5000, startMode: 'auto' }
  assert.equal(parseSvaraLobbyMessage(base)?.type, 'create_svara_table', 'Missing percentage uses the server policy')
  for (const entryFee of [0, -5000, 10, 500, 1000, 10000, 5100, 200010, 1.5, '5000', null, true, NaN, Infinity]) {
    assert.equal(parseSvaraLobbyMessage({ ...base, entryFee }), null, `Accepted arbitrary fee ${String(entryFee)}`)
  }
  for (const entryPercent of [0, 2, 3, 4, 5, -1, 100, 1.5, '1', null, true, NaN, Infinity]) {
    const input = { ...base, entryPercent }
    assert.equal(parseSvaraLobbyMessage(input), null, `Accepted forged ante ${String(entryPercent)}`)
    const runtime = createSvaraMatchRuntime()
    const frames: SvaraLobbyServerMessage[] = []
    const lobby = createSvaraLobby({ runtime, hasOtherGameCommitment: () => false })
    try {
      lobby.attachConnection('host', { profileId: 'host', getSession: () => ({ account: { role: 'admin' }, profile: { profileId: 'host' } }),
        send: (frame) => frames.push(typeof frame === 'string' ? JSON.parse(frame) : frame) })
      lobby.handle('host', input as SvaraLobbyClientMessage)
      assert.equal(frames.at(-1)?.type, 'svara_lobby_error')
      const error = frames.at(-1)!
      assert(error.type === 'svara_lobby_error' && error.code === 'invalid_input')
      assert.deepEqual(runtime.listMatchIds(), [])
    } finally { lobby.shutdown() }
  }

  // Existing engine scenarios/archives may have other percentages. New-table
  // admission restrictions must never rewrite or invalidate those snapshots.
  const historical = createSvaraMatchRuntime()
  historical.registerMatch({ matchId: 'historical', creator: { playerId: 'host' }, capacity: 2, entryFee: 1000, entryPercent: 5, startMode: 'auto' })
  historical.executeParticipantCommand('historical', { playerId: 'guest' }, 'join', { type: 'join-seat' })
  const saved = historical.exportStoredMatchForServer('historical')
  const restored = createSvaraMatchRuntime()
  restored.restoreMatchesForServer([saved])
  assert.deepEqual(restored.exportStoredMatchForServer('historical'), saved)
  console.log(`PASS ${matrix}/78 create/start/recovery combinations; 13 server previews; arbitrary fees and forged antes rejected; historical 5% preserved`)
} finally {
  if (previousFlag === undefined) delete process.env.SVARA_TEST_ENABLED
  else process.env.SVARA_TEST_ENABLED = previousFlag
}
