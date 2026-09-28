/**
 * checkLudoAntiLuckDice.ts
 *
 * Regression test за "Ludo зар — anti-bad-luck" (server-authoritative,
 * per-color hidden target, виж ludoMatchRuntime.ts::LudoColorDiceLuckState
 * doc коментара).
 *
 * Deterministic — никакъв истински Math.random: и normal die RNG, и target
 * RNG са injected през createLudoMatchRuntime({ randomDie, randomAntiLuckTarget }),
 * established injectable-RNG hook (mirror-нато на randomTwoPlayerCreatorColor,
 * виж checkLudoAuthoritativeRuntime.ts). Всеки runtime тук се захранва с
 * mutable `dieBox`/`targetBox`, четени от mock-овете точно в момента на
 * всяко roll() извикване.
 *
 * Board setup: default authoritative initial state (всички пионки home) —
 * home piece изисква dice===6 за legal move (виж ludoEngineLegalMoves.ts).
 * Затова: не-6 roll -> нула legal moves -> engine автоматично мина
 * turn_complete -> TURN_ADVANCED веднага В СЪЩИЯ applyRoll()/commit() (виж
 * advanceCompletedTurn в ludoMatchRuntime.ts) -> следващият цвят е активен.
 * 6 (natural или forced) -> home-exit е legal move -> тестът вика move() ->
 * pendingExtraRoll -> СЪЩИЯТ цвят рула пак (turnPhase обратно waiting_for_roll,
 * активният цвят НЕ сменя). rollOnce()/rollFor() по-долу капсулират точно
 * тази разлика, за да не се налага всеки test блок да я борави ръчно.
 *
 * ВАЖНО: state.diceValue в snapshot-а, върнат от roll(), може вече да е
 * презаписан от СЪЩИЯ commit()'s auto TURN_ADVANCED (ако не-6 и няма legal
 * move) — виж applyRoll()::advanceCompletedTurn. Затова реалната изиграна
 * dice стойност НИКОГА не се чете от state.diceValue тук, а от
 * 'dice_accepted' event-а в snapshot.events на ТОЧНО този commit (events са
 * final.events = [ROLL_RESOLVED-те events, ...TURN_ADVANCED-те events] —
 * стойността вътре в dice_accepted е immutable запис на реално хвърленото,
 * недокоснат от последвалия advance).
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  createLudoMatchRuntime,
  type LudoMatchSnapshot,
} from '../src/game/ludoMatchRuntime.js'
import type { LudoColor, LudoDiceValue } from '../src/game/ludoEngine/ludoEngineTypes.js'
import type { LudoRoom } from '../src/game/ludoRoomsStore.js'

let passed = 0
let failed = 0
function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
function check(label: string, fn: () => void): void {
  try { fn(); pass(label) } catch (err) { fail(label, err) }
}

let roomSerial = 0
function room(playerCount: 2 | 4 = 2): LudoRoom {
  roomSerial += 1
  return {
    id: `room-${roomSerial}`, stake: 100, playerCount, manualStart: false,
    hostProfileId: 'p1', createdAt: 1,
    players: Array.from({ length: playerCount }, (_, index) => ({
      connectionId: `c${index + 1}`, profileId: `p${index + 1}`,
      displayName: `Player ${index + 1}`, avatarUrl: null,
    })),
  }
}
function freshMatchId(): string { roomSerial += 1; return `match-${roomSerial}` }

type Player = { profileId: string; color: LudoColor }
type DieBox = { value: LudoDiceValue }
type TargetBox = { value: 6 | 7 | 8 | 9 | 10 }

function luckFor(snapshot: LudoMatchSnapshot, color: LudoColor): { consecutiveRollsWithoutSix: number; antiLuckTarget: number | null } {
  return snapshot.diceLuckByColor[color] ?? { consecutiveRollsWithoutSix: 0, antiLuckTarget: null }
}

function activeColorOf(runtime: ReturnType<typeof createLudoMatchRuntime>, players: Player[]): LudoColor {
  return (runtime.requestState(players[0]!.profileId) ?? runtime.requestState(players[1]!.profileId)!).state.activeColor
}

// Рула ТОЧНО за текущия активен цвят (die value = dieBox.value в момента на
// извикването), автоматично move()-ва ако резултатът произведе legal move
// (винаги истина само за dice===6 при all-home board). Връща реалната
// изиграна стойност (от dice_accepted event-а, виж header коментара) плюс
// цвета, който реално е хвърлял.
function rollOnce(
  runtime: ReturnType<typeof createLudoMatchRuntime>,
  matchId: string,
  players: Player[],
  snapshots: LudoMatchSnapshot[],
): { color: LudoColor; dieValue: LudoDiceValue } {
  const before = runtime.requestState(players[0]!.profileId) ?? runtime.requestState(players[1]!.profileId)!
  const mover = players.find((p) => p.color === before.state.activeColor)!
  const rollResult = runtime.roll(matchId, mover.profileId, before.revision)
  assert.equal(rollResult.ok, true, `roll() must succeed for active color ${mover.color}`)
  // requestState()/reconnect() always return includeEvents=false (viж
  // snapshot() default param in ludoMatchRuntime.ts) — реалната изиграна
  // dice стойност се чете от ПОСЛЕДНИЯ onSnapshot push (commit() публикува
  // includeEvents=true точно веднъж на roll(), виж header коментара).
  const afterRoll = snapshots.at(-1)!
  const diceEvent = afterRoll.events.find((e) => e.type === 'dice_accepted' && e.color === mover.color) as { value: LudoDiceValue } | undefined
  assert.ok(diceEvent, 'dice_accepted event must be present right after roll()')
  if (afterRoll.state.turnPhase === 'awaiting_move_selection' && afterRoll.state.legalMoves.length > 0) {
    const slot = afterRoll.state.legalMoves[0]!.slot
    const moveResult = runtime.move(matchId, mover.profileId, afterRoll.revision, slot)
    assert.equal(moveResult.ok, true, 'move() must succeed after a legal roll')
  }
  return { color: mover.color, dieValue: diceEvent!.value }
}

// Рула ЗА ТОЧНО target цвета: ако в момента активният цвят е различен
// (нормален turn cycle между тестови стъпки), вкарва filler хвърляния (не-6,
// за да не отключи extra roll/reset) за ОСТАНАЛИТЕ цветове, докато редът не
// стигне до target цвета — след което хвърля исканата dieValue за него.
function rollFor(
  runtime: ReturnType<typeof createLudoMatchRuntime>,
  matchId: string,
  players: Player[],
  snapshots: LudoMatchSnapshot[],
  dieBox: DieBox,
  targetColor: LudoColor,
  dieValue: LudoDiceValue,
  fillerDie: LudoDiceValue = 2,
): LudoMatchSnapshot {
  let guard = 0
  while (activeColorOf(runtime, players) !== targetColor) {
    guard += 1
    if (guard > 20) throw new Error(`rollFor(${targetColor}) never became active — infinite filler loop guard tripped`)
    dieBox.value = fillerDie
    rollOnce(runtime, matchId, players, snapshots)
  }
  dieBox.value = dieValue
  const { color, dieValue: actualValue } = rollOnce(runtime, matchId, players, snapshots)
  assert.equal(color, targetColor, 'sanity: rolled color must be the requested target color')
  const latest = runtime.requestState(players.find((p) => p.color === targetColor)!.profileId)!
  ;(latest as any).__lastRolledValue = actualValue
  return latest
}

console.log('\ncheckLudoAntiLuckDice\n')

// ═══════════════════════════════════════════════════════════════════════
// A1 + A2: rolls 1-5 are normal RNG (unmodified), target created exactly
// once, right after the 5th consecutive non-six.
// ═══════════════════════════════════════════════════════════════════════
check('[A1][A2] rolls 1-5 are normal RNG (unmodified) and target is created exactly once after the 5th consecutive non-six', () => {
  const dieBox: DieBox = { value: 3 }
  const targetBox: TargetBox = { value: 9 }
  const snapshots: LudoMatchSnapshot[] = []
  const runtime = createLudoMatchRuntime({
    randomDie: () => dieBox.value,
    randomAntiLuckTarget: () => targetBox.value,
    randomTwoPlayerCreatorColor: () => 'red',
    onSnapshot: (s) => snapshots.push(s),
  })
  const started = runtime.createMatch(room(), freshMatchId())
  const players: Player[] = started.players.map((p) => ({ profileId: p.profileId, color: p.color }))

  const redDieValues: LudoDiceValue[] = [2, 4, 1, 5, 3]
  for (let i = 0; i < 5; i++) {
    const afterRed = rollFor(runtime, started.matchId, players, snapshots, dieBox, 'red', redDieValues[i]!)
    assert.equal((afterRed as any).__lastRolledValue, redDieValues[i], `roll #${i + 1} must be the unmodified normal RNG value`)
    const luck = luckFor(afterRed, 'red')
    assert.equal(luck.consecutiveRollsWithoutSix, i + 1, `consecutive count after red roll #${i + 1}`)
    assert.equal(luck.antiLuckTarget, i < 4 ? null : 9, i < 4 ? 'target must stay null before the 5th roll' : 'target must be created exactly once, right after the 5th')
  }
  runtime.destroy()
})

// ═══════════════════════════════════════════════════════════════════════
// A3: target may be 6 — the roll right after the 5th non-six is forced.
// ═══════════════════════════════════════════════════════════════════════
check('[A3] target can be 6 — the roll right after the 5th non-six is immediately forced', () => {
  const dieBox: DieBox = { value: 2 }
  const targetBox: TargetBox = { value: 6 }
  const snapshots: LudoMatchSnapshot[] = []
  const runtime = createLudoMatchRuntime({
    randomDie: () => dieBox.value,
    randomAntiLuckTarget: () => targetBox.value,
    randomTwoPlayerCreatorColor: () => 'red',
    onSnapshot: (s) => snapshots.push(s),
  })
  const started = runtime.createMatch(room(), freshMatchId())
  const players: Player[] = started.players.map((p) => ({ profileId: p.profileId, color: p.color }))

  for (let i = 0; i < 5; i++) rollFor(runtime, started.matchId, players, snapshots, dieBox, 'red', 2)

  // RED-овата серия сега е 5, target=6 — следващият RED roll е roll №6,
  // задължително 6, дори "нормалният" RNG (тук нарочно 4) да казва друго.
  const afterForced = rollFor(runtime, started.matchId, players, snapshots, dieBox, 'red', 4)
  assert.equal((afterForced as any).__lastRolledValue, 6, 'roll #6 must be forced to 6 despite normalDie() returning 4')
  const luck = luckFor(afterForced, 'red')
  assert.equal(luck.consecutiveRollsWithoutSix, 0, 'forced six resets the counter')
  assert.equal(luck.antiLuckTarget, null, 'forced six resets the target')
  runtime.destroy()
})

// ═══════════════════════════════════════════════════════════════════════
// A4: target may be 10 — rolls 6-9 stay normal RNG, roll 10 is forced.
// ═══════════════════════════════════════════════════════════════════════
check('[A4] target can be 10 — rolls 6-9 stay normal RNG, roll 10 is forced', () => {
  const dieBox: DieBox = { value: 3 }
  const targetBox: TargetBox = { value: 10 }
  const snapshots: LudoMatchSnapshot[] = []
  const runtime = createLudoMatchRuntime({
    randomDie: () => dieBox.value,
    randomAntiLuckTarget: () => targetBox.value,
    randomTwoPlayerCreatorColor: () => 'red',
    onSnapshot: (s) => snapshots.push(s),
  })
  const started = runtime.createMatch(room(), freshMatchId())
  const players: Player[] = started.players.map((p) => ({ profileId: p.profileId, color: p.color }))

  for (let i = 0; i < 5; i++) rollFor(runtime, started.matchId, players, snapshots, dieBox, 'red', 3)

  const normalValuesForRolls6to9: LudoDiceValue[] = [1, 2, 3, 4]
  for (let i = 0; i < 4; i++) {
    const afterRoll = rollFor(runtime, started.matchId, players, snapshots, dieBox, 'red', normalValuesForRolls6to9[i]!)
    assert.equal((afterRoll as any).__lastRolledValue, normalValuesForRolls6to9[i], `roll #${6 + i} (< target=10) must stay normal RNG`)
  }
  const forced = rollFor(runtime, started.matchId, players, snapshots, dieBox, 'red', 5)
  assert.equal((forced as any).__lastRolledValue, 6, 'roll #10 (=target) must be forced to 6 despite normalDie() returning 5')
  runtime.destroy()
})

// ═══════════════════════════════════════════════════════════════════════
// A5: a natural six rolled before the target immediately resets everything.
// ═══════════════════════════════════════════════════════════════════════
check('[A5] a natural six rolled before the target immediately resets counter and target', () => {
  const dieBox: DieBox = { value: 4 }
  const targetBox: TargetBox = { value: 10 }
  const snapshots: LudoMatchSnapshot[] = []
  const runtime = createLudoMatchRuntime({
    randomDie: () => dieBox.value,
    randomAntiLuckTarget: () => targetBox.value,
    randomTwoPlayerCreatorColor: () => 'red',
    onSnapshot: (s) => snapshots.push(s),
  })
  const started = runtime.createMatch(room(), freshMatchId())
  const players: Player[] = started.players.map((p) => ({ profileId: p.profileId, color: p.color }))

  for (let i = 0; i < 5; i++) rollFor(runtime, started.matchId, players, snapshots, dieBox, 'red', 4)
  const afterFifth = runtime.requestState(players[0]!.profileId)!
  assert.equal(luckFor(afterFifth, 'red').antiLuckTarget, 10, 'setup: target=10 established')

  rollFor(runtime, started.matchId, players, snapshots, dieBox, 'red', 1) // roll #6, normal, non-six
  const afterNaturalSix = rollFor(runtime, started.matchId, players, snapshots, dieBox, 'red', 6) // roll #7 — normalDie() itself says 6
  assert.equal((afterNaturalSix as any).__lastRolledValue, 6, 'natural six must pass through unmodified')
  const luck = luckFor(afterNaturalSix, 'red')
  assert.equal(luck.consecutiveRollsWithoutSix, 0, 'natural six resets the counter')
  assert.equal(luck.antiLuckTarget, null, 'natural six cancels the pending target')
  runtime.destroy()
})

// ═══════════════════════════════════════════════════════════════════════
// A6 + A7: forced six also resets (A6, covered inside A3/A4 already via
// consecutiveRollsWithoutSix===0/antiLuckTarget===null assertions); A7: the
// extra roll granted by a six is roll #1 of the brand-new series.
// ═══════════════════════════════════════════════════════════════════════
check('[A6][A7] forced six resets the series, and the extra roll it grants is roll #1 of the new one', () => {
  const dieBox: DieBox = { value: 2 }
  const targetBox: TargetBox = { value: 6 }
  const snapshots: LudoMatchSnapshot[] = []
  const runtime = createLudoMatchRuntime({
    randomDie: () => dieBox.value,
    randomAntiLuckTarget: () => targetBox.value,
    randomTwoPlayerCreatorColor: () => 'red',
    onSnapshot: (s) => snapshots.push(s),
  })
  const started = runtime.createMatch(room(), freshMatchId())
  const players: Player[] = started.players.map((p) => ({ profileId: p.profileId, color: p.color }))

  for (let i = 0; i < 5; i++) rollFor(runtime, started.matchId, players, snapshots, dieBox, 'red', 2)
  const forced = rollFor(runtime, started.matchId, players, snapshots, dieBox, 'red', 4) // roll #6 = target -> forced 6
  assert.equal((forced as any).__lastRolledValue, 6)
  assert.equal(forced.state.activeColor, 'red', 'extra roll keeps the same color active')
  assert.equal(forced.state.turnPhase, 'waiting_for_roll', 'extra roll is ready to be rolled again immediately')
  assert.deepEqual(luckFor(forced, 'red'), { consecutiveRollsWithoutSix: 0, antiLuckTarget: null }, '[A6] forced six resets counter+target exactly like a natural one')

  // Extra roll (still red's turn) — roll #1 of the brand-new series.
  dieBox.value = 3
  const { color, dieValue } = rollOnce(runtime, started.matchId, players, snapshots)
  assert.equal(color, 'red', 'extra roll is rolled by the same color, no filler needed')
  assert.equal(dieValue, 3)
  const afterExtraRoll = runtime.requestState(players.find((p) => p.color === 'red')!.profileId)!
  const luck = luckFor(afterExtraRoll, 'red')
  assert.equal(luck.consecutiveRollsWithoutSix, 1, '[A7] extra roll counts as roll #1 of the new series')
  assert.equal(luck.antiLuckTarget, null)
  runtime.destroy()
})

// ═══════════════════════════════════════════════════════════════════════
// A8: state is fully independent per color.
// ═══════════════════════════════════════════════════════════════════════
check('[A8] dice-luck state is independent per color', () => {
  const dieBox: DieBox = { value: 2 }
  const snapshots: LudoMatchSnapshot[] = []
  const runtime = createLudoMatchRuntime({
    randomDie: () => dieBox.value,
    randomTwoPlayerCreatorColor: () => 'red',
    onSnapshot: (s) => snapshots.push(s),
  })
  const started = runtime.createMatch(room(), freshMatchId())
  const players: Player[] = started.players.map((p) => ({ profileId: p.profileId, color: p.color }))

  // RED: 3 поредни без 6 (интерливани с BLUE-ови ходове между тях). BLUE
  // получава собствена естествена 6 по средата (reset само за BLUE).
  rollFor(runtime, started.matchId, players, snapshots, dieBox, 'red', 2) // red #1
  rollFor(runtime, started.matchId, players, snapshots, dieBox, 'yellow', 2) // yellow #1
  rollFor(runtime, started.matchId, players, snapshots, dieBox, 'red', 2) // red #2
  rollFor(runtime, started.matchId, players, snapshots, dieBox, 'yellow', 6) // yellow natural six -> reset, extra roll for yellow
  rollFor(runtime, started.matchId, players, snapshots, dieBox, 'yellow', 2) // yellow consumes the extra roll (yellow series #1), hands turn to red
  rollFor(runtime, started.matchId, players, snapshots, dieBox, 'red', 2) // red #3

  const latest = runtime.requestState(players[0]!.profileId)!
  assert.equal(luckFor(latest, 'red').consecutiveRollsWithoutSix, 3, 'red accumulated independently across interleaved yellow turns')
  assert.equal(luckFor(latest, 'yellow').consecutiveRollsWithoutSix, 1, 'yellow was reset by its own natural six, then accumulated its own new series, unaffected by red')
  runtime.destroy()
})

// ═══════════════════════════════════════════════════════════════════════
// A9 + A10: bot takeover / human reclaim preserve the series (both share
// the exact same applyRoll(), the only writer of diceLuckByColor —
// disconnect()/reclaim() never touch it).
// ═══════════════════════════════════════════════════════════════════════
check('[A9][A10] bot takeover and human reclaim preserve consecutiveRollsWithoutSix/antiLuckTarget', () => {
  const dieBox: DieBox = { value: 2 }
  const targetBox: TargetBox = { value: 7 }
  const snapshots: LudoMatchSnapshot[] = []
  const runtime = createLudoMatchRuntime({
    randomDie: () => dieBox.value,
    randomAntiLuckTarget: () => targetBox.value,
    randomTwoPlayerCreatorColor: () => 'red',
    onSnapshot: (s) => snapshots.push(s),
  })
  const started = runtime.createMatch(room(), freshMatchId())
  const players: Player[] = started.players.map((p) => ({ profileId: p.profileId, color: p.color }))

  for (let i = 0; i < 5; i++) rollFor(runtime, started.matchId, players, snapshots, dieBox, 'red', 2)
  const beforeTakeover = luckFor(runtime.requestState(players[0]!.profileId)!, 'red')
  assert.equal(beforeTakeover.consecutiveRollsWithoutSix, 5)
  assert.equal(beforeTakeover.antiLuckTarget, 7)

  // Bot takeover (disconnect() lifecycle) — виж ludoMatchRuntime.ts, никога
  // не пипа diceLuckByColor.
  runtime.getMatch(started.matchId)!.botControlledColors.add('red')
  const afterTakeover = luckFor(runtime.requestState(players[0]!.profileId)!, 'red')
  assert.deepEqual(afterTakeover, beforeTakeover, 'bot takeover does not reset the series')

  // Rolls continue (same applyRoll() path regardless of who/what triggers it).
  const afterBotRoll = rollFor(runtime, started.matchId, players, snapshots, dieBox, 'red', 3)
  assert.equal(luckFor(afterBotRoll, 'red').consecutiveRollsWithoutSix, 6, 'series continues seamlessly under bot control')

  const beforeReclaim = luckFor(runtime.requestState(players[0]!.profileId)!, 'red')
  const reclaimResult = runtime.reclaim(started.matchId, players[0]!.profileId, runtime.requestState(players[0]!.profileId)!.revision)
  assert.equal(reclaimResult.ok, true)
  const afterReclaim = luckFor(runtime.requestState(players[0]!.profileId)!, 'red')
  assert.deepEqual(afterReclaim, beforeReclaim, 'human reclaim does not reset the series either')
  runtime.destroy()
})

// ═══════════════════════════════════════════════════════════════════════
// A11: reconnect does not reset state.
// ═══════════════════════════════════════════════════════════════════════
check('[A11] reconnect does not reset dice-luck state', () => {
  const dieBox: DieBox = { value: 2 }
  const snapshots: LudoMatchSnapshot[] = []
  const runtime = createLudoMatchRuntime({
    randomDie: () => dieBox.value,
    randomTwoPlayerCreatorColor: () => 'red',
    onSnapshot: (s) => snapshots.push(s),
  })
  const started = runtime.createMatch(room(), freshMatchId())
  const players: Player[] = started.players.map((p) => ({ profileId: p.profileId, color: p.color }))

  rollFor(runtime, started.matchId, players, snapshots, dieBox, 'red', 2)

  const before = luckFor(runtime.requestState(players[0]!.profileId)!, 'red')
  const reconnected = runtime.reconnect(players[0]!.profileId, 'new-connection-id')!
  assert.deepEqual(luckFor(reconnected, 'red'), before, 'reconnect() snapshot preserves the series')
  const requested = luckFor(runtime.requestState(players[0]!.profileId)!, 'red')
  assert.deepEqual(requested, before, 'requestState() after reconnect preserves the series')
  runtime.destroy()
})

// ═══════════════════════════════════════════════════════════════════════
// A12 + A13: server restart snapshot recovery preserves counter/target; an
// OLD persisted snapshot without the new field restores safely with defaults.
// ═══════════════════════════════════════════════════════════════════════
check('[A12] restoreMatch() (server restart recovery) preserves counter and target exactly', () => {
  const dieBox: DieBox = { value: 2 }
  const targetBox: TargetBox = { value: 8 }
  const snapshots: LudoMatchSnapshot[] = []
  const runtimeA = createLudoMatchRuntime({
    randomDie: () => dieBox.value,
    randomAntiLuckTarget: () => targetBox.value,
    randomTwoPlayerCreatorColor: () => 'red',
    onSnapshot: (s) => snapshots.push(s),
  })
  const started = runtimeA.createMatch(room(), freshMatchId())
  const players: Player[] = started.players.map((p) => ({ profileId: p.profileId, color: p.color }))
  for (let i = 0; i < 5; i++) rollFor(runtimeA, started.matchId, players, snapshots, dieBox, 'red', 2)
  const persisted = runtimeA.requestState(players[0]!.profileId)!
  assert.equal(luckFor(persisted, 'red').consecutiveRollsWithoutSix, 5)
  assert.equal(luckFor(persisted, 'red').antiLuckTarget, 8)
  runtimeA.destroy()

  const runtimeB = createLudoMatchRuntime({ randomTwoPlayerCreatorColor: () => 'red', onSnapshot: () => {} })
  runtimeB.restoreMatch(persisted)
  const restored = runtimeB.requestState(players[0]!.profileId)!
  assert.deepEqual(luckFor(restored, 'red'), luckFor(persisted, 'red'), 'restart recovery preserves counter+target exactly')
  runtimeB.destroy()
})

check('[A13] an OLD persisted snapshot without diceLuckByColor restores safely with defaults', () => {
  const runtimeA = createLudoMatchRuntime({ randomTwoPlayerCreatorColor: () => 'red', onSnapshot: () => {} })
  const started = runtimeA.createMatch(room(), freshMatchId())
  const legacySnapshot = { ...started } as Partial<LudoMatchSnapshot>
  delete legacySnapshot.diceLuckByColor // simulate a pre-migration persisted row
  runtimeA.destroy()

  const runtimeB = createLudoMatchRuntime({ randomTwoPlayerCreatorColor: () => 'red', onSnapshot: () => {} })
  assert.doesNotThrow(() => runtimeB.restoreMatch(legacySnapshot as LudoMatchSnapshot), 'restoreMatch must not throw on a missing field')
  const restored = runtimeB.requestState(started.players[0]!.profileId)!
  assert.deepEqual(restored.diceLuckByColor, {}, 'missing field defaults to an empty (fresh) dice-luck map')
  assert.deepEqual(luckFor(restored, 'red'), { consecutiveRollsWithoutSix: 0, antiLuckTarget: null }, 'every color reads back as a brand-new series')
  runtimeB.destroy()
})

// ═══════════════════════════════════════════════════════════════════════
// A14: a left/forfeited color does not cause side effects.
// ═══════════════════════════════════════════════════════════════════════
check('[A14] a forfeited color does not break dice-luck bookkeeping for the remaining color', () => {
  const dieBox: DieBox = { value: 2 }
  const snapshots: LudoMatchSnapshot[] = []
  const runtime = createLudoMatchRuntime({
    randomDie: () => dieBox.value,
    randomTwoPlayerCreatorColor: () => 'red',
    onSnapshot: (s) => snapshots.push(s),
  })
  const started = runtime.createMatch(room(), freshMatchId())
  const players: Player[] = started.players.map((p) => ({ profileId: p.profileId, color: p.color }))
  rollFor(runtime, started.matchId, players, snapshots, dieBox, 'red', 2) // red rolls once
  const yellow = players.find((p) => p.color === 'yellow')!
  const leaveResult = runtime.leave(started.matchId, yellow.profileId)
  assert.equal(leaveResult.ok, true, '2-player leave finishes the match (last-player-standing)')
  const red = players.find((p) => p.color === 'red')!
  const final = runtime.requestState(red.profileId)
  assert.equal(final?.state.status, 'finished')
  assert.doesNotThrow(() => luckFor(final!, 'yellow'), 'reading a forfeited color leaves no dangling state')
  runtime.destroy()
})

// ═══════════════════════════════════════════════════════════════════════
// A15: a finished match has no anti-luck side effects (rolls rejected).
// ═══════════════════════════════════════════════════════════════════════
check('[A15] a finished match rejects further rolls — no anti-luck timers/side effects', () => {
  const dieBox: DieBox = { value: 6 }
  const runtime = createLudoMatchRuntime({
    randomDie: () => dieBox.value,
    randomTwoPlayerCreatorColor: () => 'red',
    onSnapshot: () => {},
  })
  const started = runtime.createMatch(room(), freshMatchId())
  const players: Player[] = started.players.map((p) => ({ profileId: p.profileId, color: p.color }))
  const red = players.find((p) => p.color === 'red')!
  runtime.leave(started.matchId, players.find((p) => p.color === 'yellow')!.profileId)
  const finalRevision = runtime.requestState(red.profileId)!.revision
  const rejected = runtime.roll(started.matchId, red.profileId, finalRevision)
  assert.equal(rejected.ok, false, 'roll on a finished match must be rejected')
  runtime.destroy()
})

// ═══════════════════════════════════════════════════════════════════════
// A16: forced six travels through the exact same reducer/event path as a
// natural six (byte-identical dice_accepted event shape, no special branch).
// ═══════════════════════════════════════════════════════════════════════
check('[A16] forced six produces the identical dice_accepted event shape as a natural six', () => {
  const naturalDieBox: DieBox = { value: 6 }
  const naturalSnapshots: LudoMatchSnapshot[] = []
  const runtimeNatural = createLudoMatchRuntime({
    randomDie: () => naturalDieBox.value,
    randomTwoPlayerCreatorColor: () => 'red',
    onSnapshot: (s) => naturalSnapshots.push(s),
  })
  const startedNatural = runtimeNatural.createMatch(room(), freshMatchId())
  const { dieValue: naturalValue } = rollOnce(runtimeNatural, startedNatural.matchId, startedNatural.players.map((p) => ({ profileId: p.profileId, color: p.color })), naturalSnapshots)
  const naturalDiceEvent = naturalSnapshots.at(-1)!.events.find((e) => e.type === 'dice_accepted')
  runtimeNatural.destroy()

  const forcedDieBox: DieBox = { value: 2 }
  const forcedTargetBox: TargetBox = { value: 6 }
  const forcedSnapshots: LudoMatchSnapshot[] = []
  const runtimeForced = createLudoMatchRuntime({
    randomDie: () => forcedDieBox.value,
    randomAntiLuckTarget: () => forcedTargetBox.value,
    randomTwoPlayerCreatorColor: () => 'red',
    onSnapshot: (s) => forcedSnapshots.push(s),
  })
  const startedForced = runtimeForced.createMatch(room(), freshMatchId())
  const forcedPlayers: Player[] = startedForced.players.map((p) => ({ profileId: p.profileId, color: p.color }))
  for (let i = 0; i < 5; i++) rollFor(runtimeForced, startedForced.matchId, forcedPlayers, forcedSnapshots, forcedDieBox, 'red', 2)
  const forcedSnapshot = rollFor(runtimeForced, startedForced.matchId, forcedPlayers, forcedSnapshots, forcedDieBox, 'red', 3) // normalDie would say 3 — must be forced to 6
  assert.equal((forcedSnapshot as any).__lastRolledValue, 6)
  const forcedDiceEvent = forcedSnapshots.at(-1)!.events.find((e) => e.type === 'dice_accepted' && e.color === 'red')
  runtimeForced.destroy()

  assert.equal(naturalValue, 6, 'sanity: natural roll really was a six')
  assert.deepEqual(
    { type: naturalDiceEvent?.type, value: (naturalDiceEvent as any)?.value },
    { type: forcedDiceEvent?.type, value: (forcedDiceEvent as any)?.value },
    'forced six event shape is identical to a natural six event',
  )
})

// ═══════════════════════════════════════════════════════════════════════
// A17: no client-side knowledge — diceLuckByColor is explicitly stripped in
// index.ts before the snapshot is ever sent over the wire (source review,
// established pattern from checkLudoTurnTimeouts.ts's B1/B2 checks).
// ═══════════════════════════════════════════════════════════════════════
check('[A17] index.ts strips diceLuckByColor before building the client protocol snapshot', () => {
  const indexSrc = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8')
  const fnMatch = /function toLudoGameProtocolSnapshot\(snapshot: LudoMatchSnapshot\) \{[\s\S]*?\n\}/.exec(indexSrc)
  assert.ok(fnMatch, 'toLudoGameProtocolSnapshot must exist as the single client-protocol conversion point')
  assert.match(fnMatch![0], /diceLuckByColor/, 'the function must explicitly reference diceLuckByColor (to strip it)')
  assert.match(fnMatch![0], /const \{ diceLuckByColor: _diceLuckByColor, \.\.\.(clientSnapshot|rest) \}/, 'diceLuckByColor must be destructured OUT before the spread, never included')
})

console.log('\n' + '═'.repeat(75))
console.log(`Passed: ${passed}  Failed: ${failed}`)
console.log('═'.repeat(75) + '\n')
if (failed > 0) process.exitCode = 1
