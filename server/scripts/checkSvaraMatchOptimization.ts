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

// 2Б.3.7.1А: rolled forward from the original 'eceed0bf...' (2455221^, the
// commit right before the archive-sharing optimization itself). That
// baseline predates 2Б.3.5 (new lifecycle commands/fields: request-return,
// activate-returns, turn-timeout, close-svara-joining, finish-presence-wait,
// pendingReturns/finishReason, you.returnPending/svaraDecision,
// result.aborted/reason/message) AND 2Б.3.7.0 (blind-phase transfer-on-fold
// changed `blind.status` transitions). Those are intentional, already-tested
// behavior/shape changes, not optimization regressions - but a differential
// replay against an engine that predates them necessarily "fails" on every
// affected fixture for reasons that have nothing to do with the optimization
// this test exists to protect. '4c2a280...' is the commit immediately before
// THIS stage's reveal/hide choice (2Б.3.7.1) and already includes every one
// of the above; it is the newest commit that still differs from current HEAD
// by exactly one well-understood, narrowly-excludable feature (below), so it
// is the safest baseline that still exercises the optimization meaningfully.
export const BASELINE = '4c2a280e15afeb44def99e3161c1a6ae3fe626de'
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
export const stats = { commands: 0, failures: 0, duplicates: 0, snapshots: 0, restored: 0, revealChoiceOnly: 0 }
export function createSvaraMatch(input) {
  const state = optimized.createSvaraMatch(input)
  pairs.set(state, reference.createSvaraMatch(input))
  return state
}
// 2Б.3.7.1 (after BASELINE) added a reveal/hide choice for a sole-remaining
// winner: four new command types the reference engine has never heard of,
// plus a new you.revealChoice snapshot field. Neither is an optimization
// regression; both are this stage's own, already-tested behavior/shape
// addition. Comparing them against an engine that cannot model them would
// either crash (unknown command) or flag a fabricated "difference" that is
// really just a field the old engine was never given. Excluded here,
// narrowly and explicitly - never silently, and nothing else is stripped:
// BASELINE already matches current HEAD's state/snapshot shape otherwise.
const REVEAL_CHOICE_COMMAND_TYPES = new Set(['reveal-cards', 'hide-cards', 'expire-reveal-choice', 'close-reveal-display'])
function withoutRevealChoiceSnapshotField(message) {
  const { revealChoice, ...you } = message.you
  return { ...message, you }
}
// 2Б.3.7.4Б (also after BASELINE) added a server-side dealing-presentation
// phase: a new 'finish-dealing' command type the reference engine has never
// heard of, plus a new round.dealing field (state AND snapshot) the
// reference engine never produces. Same narrow, explicit exclusion pattern
// as the 2Б.3.7.1 reveal/hide choice above - not an optimization regression.
const DEALING_PHASE_COMMAND_TYPES = new Set(['finish-dealing'])
function withoutDealingRoundField(result) {
  const round = result.state.round
  if (!round || (round.kind !== 'ordinary' && round.kind !== 'svara')) return result
  const { dealing, ...rest } = round
  return { ...result, state: { ...result.state, round: rest } }
}
function withoutDealingSnapshotField(message) {
  const round = message.round
  if (!round || (round.kind !== 'ordinary' && round.kind !== 'svara')) return message
  const { dealing, ...rest } = round
  return { ...message, round: rest }
}
export function applySvaraMatchCommand(state, command, env = {}) {
  const previous = JSON.stringify(state)
  if (REVEAL_CHOICE_COMMAND_TYPES.has(command.type) || DEALING_PHASE_COMMAND_TYPES.has(command.type)) {
    // Apply only to the optimized engine. Deliberately do not register a
    // pairing for the result: the next ordinary command resyncs the
    // reference from the (now-identical-shape) current snapshot through the
    // existing "pairs.get(state) ?? structuredClone(state)" fallback below,
    // so full comparison coverage resumes immediately afterward.
    const after = optimized.applySvaraMatchCommand(state, command, env)
    assert.equal(JSON.stringify(state), previous, 'command mutated its input')
    stats.commands++
    stats.revealChoiceOnly++
    if (after.status === 'duplicate') stats.duplicates++
    for (const id of after.state.seats) { snapshot(after.state.config.tableId, after.state, id); stats.snapshots++ }
    return after
  }
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
  const dealingNow = after.state.round && (after.state.round.kind === 'ordinary' || after.state.round.kind === 'svara') && after.state.round.dealing
  if ((after.state.round && after.state.round.kind === 'reveal-choice') || dealingNow) {
    // This is an otherwise-ordinary command (act/exit/set-absent/
    // absence-expired/.../start-next-round/svara-start) whose result the
    // reference engine cannot fully reproduce: either a fold happened to
    // leave exactly one non-folded participant (BASELINE finishes the round
    // immediately; current HEAD defers behind the 2Б.3.7.1 reveal/hide
    // choice instead), or the deal just entered the 2Б.3.7.4Б dealing
    // phase (BASELINE has no such concept, so its toActId/betting options
    // are never suppressed the way the optimized engine's are). Neither is
    // an optimization regression - both are this/an earlier stage's own,
    // already-tested behavior addition. Do not pair: the next ordinary
    // command resyncs the reference from this snapshot (shape-compatible
    // again once the choice resolves / dealing finishes) through the
    // existing structuredClone fallback above.
    if (after.status === 'duplicate') stats.duplicates++
    stats.revealChoiceOnly++
    for (const id of after.state.seats) { snapshot(after.state.config.tableId, after.state, id); stats.snapshots++ }
    return after
  }
  // Strip on BOTH sides: when a prior finish-dealing (optimized-only, see
  // above) left no pairing, the fallback resync clones straight from the
  // OPTIMIZED state, so before's raw internal round can carry the extra
  // dealing key forward too (unlike its OWN snapshot builder below, which
  // only ever emits fields it explicitly lists and so never gains one).
  assert.equal(JSON.stringify(withoutDealingRoundField(after)), JSON.stringify(withoutDealingRoundField(before)), 'full command result/state differs')
  pairs.set(after.state, before.state)
  if (after.status === 'duplicate') stats.duplicates++
  if (stats.commands % 17 === 0) retained.push([after.state, JSON.stringify(after.state)])
  for (const id of after.state.seats) {
    assert.equal(JSON.stringify(withoutDealingSnapshotField(withoutRevealChoiceSnapshotField(snapshot(after.state.config.tableId, after.state, id)))), JSON.stringify(referenceSnapshot(before.state.config.tableId, before.state, id)), 'individual snapshot differs')
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
  // 2Б.3.7.1А: recalibrated from 124. Every sole-remaining fold now spends
  // one extra command on resolving the reveal choice (hide-cards) before the
  // next deal can start, so the same 500-command budget completes fewer
  // rounds than before this stage. Not a performance or correctness
  // regression - the per-command engine call is still what is timed below.
  // 2Б.3.7.4Б: recalibrated again from 99. Every fresh deal now spends one
  // extra command (finish-dealing) ending the server dealing-presentation
  // phase before any look/act is accepted - same reasoning, one more
  // command per round, fewer rounds in the same fixed budget.
  assert.equal(long[0]!.history, 82)
  const games = ['one', 'two', 'three'].map((tableId) => {
    let state = bridge.createSvaraMatch({ tableId, creatorId: 'a', capacity: 2, entryFee: 10000, startMode: 'auto' })
    state = bridge.applySvaraMatchCommand(state, { type: 'join-seat', commandId: 'join', playerId: 'b' }, { random: { nextInt: () => 0 } }).state
    return state as current.SvaraMatchState
  })
  for (let i = 0; i < 150; i++) {
    const index = i % games.length
    const state = games[index]!
    const round = state.round
    const action: current.SvaraMatchCommand = !round
      ? { type: 'start-next-round', commandId: `step-${i}` }
      // 2Б.3.7.4Б: a fresh deal now starts in the server dealing-presentation
      // phase; skip it (fake-clock lifecycle tests cover the real wait).
      : (round.kind === 'ordinary' || round.kind === 'svara') && (round as { dealing?: boolean }).dealing
        ? { type: 'finish-dealing', commandId: `step-${i}`, roundId: round.roundId }
        // Heads-up: every fold now leaves a sole winner with a reveal choice
        // instead of an immediately-closed round; hide it to keep dealing.
        : round.kind === 'reveal-choice'
          ? { type: 'hide-cards', commandId: `step-${i}`, playerId: round.winnerId }
          : { type: 'act', commandId: `step-${i}`, playerId: (round as Extract<current.SvaraRound, { kind: 'ordinary' }>).betting.toAct!, action: { kind: 'fold' } }
    games[index] = bridge.applySvaraMatchCommand(state, action, { createDeck: () => SVARA_ORDERED_DECK }).state
  }
  // 2Б.3.7.1А: recalibrated from 25. Each heads-up round now costs an extra
  // command (hide-cards) to close the sole-remaining-player reveal choice,
  // so the same 150-command/3-table budget completes fewer rounds per table.
  // 2Б.3.7.4Б: recalibrated again from 16. Every fresh deal now spends one
  // extra command (finish-dealing) ending the server dealing-presentation
  // phase before the fold - same reasoning, fewer rounds in the same budget.
  assert(games.every((state) => state.history.length === 12))
  console.log('PASS differential 500-command match (82 rounds), plus three interleaved matches')
  console.log('Differential comparison:', bridge.verifyRetainedStates())
}

function mutationChecks(): void {
  let state = current.createSvaraMatch({ tableId: 'mutation', creatorId: 'a', capacity: 2, entryFee: 1000, startMode: 'auto' })
  const apply = (command: current.SvaraMatchCommand) => { state = current.applySvaraMatchCommand(state, command, { random: { nextInt: () => 0 }, createDeck: () => SVARA_ORDERED_DECK }).state }
  apply({ type: 'join-seat', commandId: 'join', playerId: 'b' })
  apply({ type: 'start-next-round', commandId: 'deal' })
  // 2Б.3.7.4Б: skip the server dealing-presentation phase (fake-clock
  // lifecycle tests cover the real wait) so the fold below is accepted.
  apply({ type: 'finish-dealing', commandId: 'finish-deal', roundId: (state.round as Extract<current.SvaraRound, { kind: 'ordinary' }>).roundId })
  const liveState = state, liveJson = JSON.stringify(state)
  apply({ type: 'act', commandId: 'fold', playerId: 'b', action: { kind: 'fold' } })
  // 2Б.3.7.1: heads-up fold now opens a 5s reveal choice for the sole
  // survivor before the round actually closes; resolve it (hide) so the
  // rest of this archive-sharing check exercises the same closed-round
  // scenario (empty-deck failure, then a real second deal) as before.
  apply({ type: 'hide-cards', commandId: 'hide', playerId: 'a' })
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
  let resumed = current.applySvaraMatchCommand(restored, { type: 'start-next-round', commandId: 'restore' }, { createDeck: () => SVARA_ORDERED_DECK }).state
  // 2Б.3.7.4Б: skip the dealing phase so the final tampered-ledger `look`
  // below reaches the invariant check instead of the (earlier) dealing gate.
  resumed = current.applySvaraMatchCommand(resumed, { type: 'finish-dealing', commandId: 'finish-restore', roundId: (resumed.round as Extract<current.SvaraRound, { kind: 'ordinary' }>).roundId }).state
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
      // 2Б.3.7.4Б: a fresh deal now starts in the server dealing-presentation
      // phase; skip it (fake-clock lifecycle tests cover the real wait).
      : (round.kind === 'ordinary' || round.kind === 'svara') && (round as { dealing?: boolean }).dealing
        ? { type: 'finish-dealing', commandId: `command-${count}`, roundId: round.roundId }
        // 2Б.3.7.1: a sole-remaining fold now opens a reveal choice instead of
        // closing the round immediately; hide it to keep driving fresh deals.
        : round.kind === 'reveal-choice'
          ? { type: 'hide-cards', commandId: `command-${count}`, playerId: round.winnerId }
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
