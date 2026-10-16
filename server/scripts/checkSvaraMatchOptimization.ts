/** Identical baseline/current workloads; timing excludes generation, serialization and checks. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as current from '../src/games/svara/engine/svaraMatch.js'
import { SVARA_ORDERED_DECK } from '../src/games/svara/engine/svaraCards.js'

export const BASELINE = 'eceed0bfc2abc5221830af3b51b7430b069454be'
const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const root = await mkdtemp(join(tmpdir(), 'pika-svara-optimization-'))
await writeFile(join(root, 'package.json'), '{"type":"module"}')
const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', BASELINE, 'server/src/games/svara/engine', 'server/src/games/svara/protocol/svaraSnapshotProtocol.ts'], { cwd: project, encoding: 'utf8' }).trim().split(/\r?\n/)
for (const path of paths) {
  const destination = join(root, path)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, execFileSync('git', ['show', `${BASELINE}:${path}`], { cwd: project }))
}
const old = await import(pathToFileURL(join(root, 'server/src/games/svara/engine/svaraMatch.ts')).href) as typeof current

async function differentialFixtures(): Promise<void> {
  const bridgePath = join(root, 'differential.mjs')
  const currentEngine = pathToFileURL(join(project, 'server/src/games/svara/engine/index.ts')).href
  const oldEngine = pathToFileURL(join(root, 'server/src/games/svara/engine/svaraMatch.ts')).href
  await writeFile(bridgePath, `
import assert from 'node:assert/strict'
import * as optimized from ${JSON.stringify(currentEngine)}
import * as reference from ${JSON.stringify(oldEngine)}
import { createSvaraMatchSnapshotMessage as snapshot } from ${JSON.stringify(pathToFileURL(join(project, 'server/src/games/svara/protocol/svaraSnapshotProtocol.ts')).href)}
import { createSvaraMatchSnapshotMessage as referenceSnapshot } from ${JSON.stringify(pathToFileURL(join(root, 'server/src/games/svara/protocol/svaraSnapshotProtocol.ts')).href)}
export * from ${JSON.stringify(currentEngine)}
const pairs = new WeakMap()
const retained = []
export const stats = { commands: 0, failures: 0, duplicates: 0, snapshots: 0, restored: 0 }
export function createSvaraMatch(input) {
  const state = optimized.createSvaraMatch(input)
  pairs.set(state, reference.createSvaraMatch(input))
  return state
}
export function applySvaraMatchCommand(state, command, env = {}) {
  const previous = JSON.stringify(state)
  const refState = pairs.get(state) ?? structuredClone(state)
  if (!pairs.has(state)) stats.restored++
  const randomValues = [], decks = []
  const random = env.random ?? optimized.createSeededSvaraRandomSourceForTests(119 + stats.commands)
  const capture = {
    random: { nextInt(n) { const value = random.nextInt(n); randomValues.push([n, value]); return value } },
    ...(env.createDeck ? { createDeck() { const deck = env.createDeck(); decks.push(structuredClone(deck)); return deck } } : {}),
  }
  let randomIndex = 0, deckIndex = 0
  const replay = {
    random: { nextInt(n) { const entry = randomValues[randomIndex++]; assert(entry); assert.equal(entry[0], n); return entry[1] } },
    ...(env.createDeck ? { createDeck() { assert(deckIndex < decks.length); return structuredClone(decks[deckIndex++]) } } : {}),
  }
  let before, after, beforeError, afterError
  try { before = reference.applySvaraMatchCommand(refState, command, capture) } catch (error) { beforeError = error }
  try { after = optimized.applySvaraMatchCommand(state, command, replay) } catch (error) { afterError = error }
  assert.equal(JSON.stringify(state), previous, 'command mutated its input')
  assert.equal(randomIndex, randomValues.length, 'random consumption changed')
  assert.equal(deckIndex, decks.length, 'deck consumption changed')
  stats.commands++
  if (beforeError || afterError) {
    assert(beforeError && afterError, 'only one engine rejected the command')
    assert.deepEqual([afterError.name, afterError.code, afterError.message], [beforeError.name, beforeError.code, beforeError.message])
    assert.equal(JSON.stringify(refState), previous, 'reference rejection changed input')
    stats.failures++
    throw afterError
  }
  assert.equal(JSON.stringify(after), JSON.stringify(before), 'full command result/state differs')
  pairs.set(after.state, before.state)
  if (after.status === 'duplicate') stats.duplicates++
  if (stats.commands % 17 === 0) retained.push([after.state, JSON.stringify(after.state)])
  for (const id of after.state.seats) {
    assert.equal(JSON.stringify(snapshot(after.state.config.tableId, after.state, id)), JSON.stringify(referenceSnapshot(before.state.config.tableId, before.state, id)), 'individual snapshot differs')
    stats.snapshots++
  }
  return after
}
export function verifyRetainedStates() {
  for (const [state, json] of retained) assert.equal(JSON.stringify(state), json, 'later command changed retained state')
  assert(stats.commands > 300 && stats.failures > 10 && stats.duplicates > 2 && stats.snapshots > 500)
  return { ...stats, retainedStates: retained.length }
}
`)
  const sourcePath = join(project, 'server/scripts/checkSvaraMatch2B2B.ts')
  let source = await readFile(sourcePath, 'utf8')
  // Reuse every deterministic rules fixture with BOTH engines; the full original
  // random suite and source-isolation check are run separately, unchanged.
  source = source.replace("'../src/games/svara/engine/index.js'", JSON.stringify(pathToFileURL(bridgePath).href))
  source = source.replace(/function check\(label: string, fn: \(\) => void\): void \{/, "$&\n  if (label.startsWith('I1.') || label.startsWith('J1.')) return")
  source = source.replace('if (failed > 0) process.exit(1)', "if (failed > 0) throw new Error('differential rules fixtures failed')")
  source = source.replace('void createShuffledSvaraDeck', `
check('OPT. late join after a repeated ordinary Svara tie preserves reference history aliases', () => {
  const t = tiedThree()
  t.run({ type: 'start-next-round' })
  t.run({ type: 'svara-start' }, { createDeck: () => buildSvaraDeckForHands(['b', 'a'], { b: TIE1, a: TIE2 }) })
  t.seen('b', { kind: 'bet', total: 10 })
  t.seen('a', { kind: 'call' })
  t.run({ type: 'start-next-round' })
  const previous = t.state
  const previousJson = JSON.stringify(previous)
  t.run({ type: 'svara-join', playerId: 'c' })
  assert(JSON.stringify(previous) === previousJson, 'late join mutated the previous version')
  assert(previous.history[1] !== t.state.history[1], 'live-linked history must be detached')
})
void createShuffledSvaraDeck`)
  assert(source.includes("if (label.startsWith('I1.')"), 'fixture transformation must match')
  const fixturePath = join(root, 'deterministicFixtures.ts')
  await writeFile(fixturePath, source)
  await import(pathToFileURL(fixturePath).href)
  const bridge = await import(pathToFileURL(bridgePath).href)
  const long = benchmark(bridge as typeof current, 500)
  assert.equal(long[0]!.history, 124)
  const games = ['one', 'two', 'three'].map((tableId) => {
    let state = bridge.createSvaraMatch({ tableId, creatorId: 'a', capacity: 2, entryFee: 10000, startMode: 'auto' })
    state = bridge.applySvaraMatchCommand(state, { type: 'join-seat', commandId: 'join', playerId: 'b' }, { random: { nextInt: () => 0 } }).state
    return state as current.SvaraMatchState
  })
  for (let i = 0; i < 150; i++) {
    const index = i % games.length
    const state = games[index]!
    const action: current.SvaraMatchCommand = !state.round
      ? { type: 'start-next-round', commandId: `step-${i}` }
      : { type: 'act', commandId: `step-${i}`, playerId: (state.round as Extract<current.SvaraRound, { kind: 'ordinary' }>).betting.toAct!, action: { kind: 'fold' } }
    games[index] = bridge.applySvaraMatchCommand(state, action, { createDeck: () => SVARA_ORDERED_DECK }).state
  }
  assert(games.every((state) => state.history.length === 25))
  console.log('PASS differential 500-command match (124 rounds), plus three interleaved matches')
  console.log('Differential comparison:', bridge.verifyRetainedStates())
}

function mutationChecks(): void {
  let state = current.createSvaraMatch({ tableId: 'mutation', creatorId: 'a', capacity: 2, entryFee: 1000, startMode: 'auto' })
  const apply = (command: current.SvaraMatchCommand) => { state = current.applySvaraMatchCommand(state, command, { random: { nextInt: () => 0 }, createDeck: () => SVARA_ORDERED_DECK }).state }
  apply({ type: 'join-seat', commandId: 'join', playerId: 'b' })
  apply({ type: 'start-next-round', commandId: 'deal' })
  const liveState = state, liveJson = JSON.stringify(state)
  apply({ type: 'act', commandId: 'fold', playerId: 'b', action: { kind: 'fold' } })
  const first = state, json = JSON.stringify(state)
  assert.throws(() => current.applySvaraMatchCommand(first, { type: 'start-next-round', commandId: 'failed-deal' }, { createDeck: () => [] }))
  assert.equal(JSON.stringify(first), json, 'failed deal changed state after drafting chip movements')
  apply({ type: 'start-next-round', commandId: 'deal2' })
  assert.equal(JSON.stringify(first), json); assert.equal(JSON.stringify(liveState), liveJson)
  assert.equal(first.history[0], state.history[0], 'completed history without live aliases is shared')
  assert.equal(first.ledger[0], state.ledger[0], 'ledger entries are shared')
  assert.equal(first.processedCommands.join, state.processedCommands.join, 'command results are shared')
  for (const mutate of [
    () => { first.history[0]!.participants.push('intruder') },
    () => { first.ledger[0]!.amount++ },
    () => { first.processedCommands.join!.outcome.completedRounds.push('intruder') },
  ]) assert.throws(mutate, TypeError)
  assert.equal(JSON.stringify(first), json)
  assert.notEqual(first.round, state.round)
  // Restored and externally/shallow-frozen data must be detached before sharing.
  const restored = JSON.parse(json) as current.SvaraMatchState
  Object.freeze(restored.history)
  const resumed = current.applySvaraMatchCommand(restored, { type: 'start-next-round', commandId: 'restore' }, { createDeck: () => SVARA_ORDERED_DECK }).state
  restored.history[0]!.participants.push('external')
  restored.ledger[0]!.amount++
  restored.processedCommands.join!.outcome.completedRounds.push('external')
  assert(!resumed.history[0]!.participants.includes('external'))
  assert.equal(resumed.ledger[0]!.amount, first.ledger[0]!.amount)
  assert(!resumed.processedCommands.join!.outcome.completedRounds.includes('external'))
  assert.equal(current.applySvaraMatchCommand(resumed, { type: 'join-seat', commandId: 'join', playerId: 'b' }).status, 'duplicate')
  current.assertSvaraMatchInvariants(resumed)
  const tampered = JSON.parse(JSON.stringify(resumed)) as current.SvaraMatchState
  tampered.ledger[0]!.amount++
  const tamperedJson = JSON.stringify(tampered)
  assert.throws(() => current.applySvaraMatchCommand(tampered, { type: 'look', playerId: 'a', commandId: 'tampered' }), (error: unknown) => error instanceof current.SvaraMatchError && error.code === 'invariant-violation')
  assert.equal(JSON.stringify(tampered), tamperedJson, 'failed accounting audit changed restored input')
  console.log('PASS archive sharing, nested mutation rejection, detached restore and old-ID replay')
}

type Row = { commands: number; meanMs: number; maxMs: number; bytes: number; ledger: number; history: number }
function benchmark(engine: typeof current, limit: number): Row[] {
  let state = engine.createSvaraMatch({ tableId: 'benchmark', creatorId: 'a', capacity: 4, entryFee: 10000, startMode: 'auto' })
  const env: current.SvaraMatchEnv = { random: { nextInt: () => 0 }, createDeck: () => SVARA_ORDERED_DECK }
  let count = 0, total = 0, max = 0, windowCount = 0
  const rows: Row[] = []
  const apply = (command: current.SvaraMatchCommand) => {
    const started = performance.now()
    const result = engine.applySvaraMatchCommand(state, command, env)
    const elapsed = performance.now() - started
    state = result.state
    total += elapsed; max = Math.max(max, elapsed); count++; windowCount++
    if ([500, 2000, 4000].includes(count)) {
      const bytes = Buffer.byteLength(JSON.stringify(state))
      rows.push({ commands: count, meanMs: total / windowCount, maxMs: max, bytes, ledger: state.ledger.length, history: state.history.length })
      total = 0; max = 0; windowCount = 0
    }
  }
  for (const playerId of ['b', 'c', 'd']) apply({ type: 'join-seat', commandId: `join-${playerId}`, playerId })
  while (count < limit) {
    const round = state.round
    const command: current.SvaraMatchCommand = !round
      ? { type: 'start-next-round', commandId: `command-${count}` }
      : { type: 'act', commandId: `command-${count}`, playerId: (round as Extract<current.SvaraRound, { kind: 'ordinary' }>).betting.toAct!, action: { kind: 'fold' } }
    apply(command)
  }
  engine.assertSvaraMatchInvariants(state)
  return rows
}

try {
  if (process.argv.includes('--baseline-only')) {
    console.log(JSON.stringify({ baseline: BASELINE, windows: benchmark(old, 2000) }, null, 2))
  } else if (process.argv.includes('--benchmark')) {
    const before = benchmark(old, 2000)
    const after = benchmark(current, 2000)
    console.table(before.map((row, index) => ({ commands: row.commands, beforeMs: row.meanMs, afterMs: after[index]!.meanMs, speedup: row.meanMs / after[index]!.meanMs, beforeMaxMs: row.maxMs, afterMaxMs: after[index]!.maxMs, bytes: row.bytes })))
    assert.deepEqual(after.map(({ meanMs, maxMs, ...rest }) => rest), before.map(({ meanMs, maxMs, ...rest }) => rest))
  } else {
    await differentialFixtures()
    mutationChecks()
  }
} finally {
  assert.equal(dirname(resolve(root)), resolve(tmpdir()))
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
}
