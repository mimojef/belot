import { strict as assert } from 'node:assert'
import { createLudoMatchRuntime, type LudoMatchSnapshot } from '../src/game/ludoMatchRuntime.js'
import type { LudoGamePiece, LudoGameState, LudoPiecePosition } from '../src/game/ludoEngine/ludoEngineTypes.js'
import type { LudoRoom } from '../src/game/ludoRoomsStore.js'

let roomSerial = 0
function room(size: 2 | 4): LudoRoom {
  roomSerial += 1
  return {
    id: `room-${roomSerial}`, stake: 100, playerCount: size, manualStart: false,
    hostProfileId: 'p1', createdAt: 1,
    players: Array.from({ length: size }, (_, index) => ({
      connectionId: `c${index + 1}`, profileId: `p${index + 1}`,
      displayName: `Player ${index + 1}`, avatarUrl: null,
    })),
  }
}

const home = (color: 'red' | 'blue', slot: 0 | 1 | 2 | 3): LudoGamePiece => ({ color, slot, position: { kind: 'home', slot } })
function state(redPositions: LudoPiecePosition[], bluePositions: LudoPiecePosition[] = [0, 1, 2, 3].map((slot) => ({ kind: 'home', slot }))): LudoGameState {
  return {
    turnOrder: ['red', 'blue'], activeColor: 'red', turnPhase: 'waiting_for_roll', diceValue: null,
    legalMoves: [], status: 'in_progress', winnerColor: null, turnVersion: 0, pendingExtraRoll: false,
    pieces: [
      ...redPositions.map((position, slot) => ({ color: 'red' as const, slot: slot as 0 | 1 | 2 | 3, position })),
      ...bluePositions.map((position, slot) => ({ color: 'blue' as const, slot: slot as 0 | 1 | 2 | 3, position })),
    ],
  }
}

function scenario(initial: LudoGameState, die: 1 | 2 | 3 | 4 | 5 | 6, finishedMatchRetentionMs?: number) {
  const snapshots: LudoMatchSnapshot[] = []
  const runtime = createLudoMatchRuntime({
    randomDie: () => die,
    randomTwoPlayerCreatorColor: () => 'red',
    initialStateFactory: () => initial,
    finishedMatchRetentionMs,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  })
  const started = runtime.createMatch(room(2))
  return { runtime, started, snapshots }
}

{
  const seen: LudoMatchSnapshot[] = []
  const runtime = createLudoMatchRuntime({ randomDie: () => 6, randomTwoPlayerCreatorColor: () => 'red', onSnapshot: (snapshot) => seen.push(snapshot) })
  const two = runtime.createMatch(room(2))
  assert.deepEqual(two.players.map((p) => p.color), ['red', 'yellow'], '2-player players use opposite colors')
  assert.deepEqual(two.state.turnOrder, ['red', 'yellow'], '2-player creator starts before opposite color')
  assert.equal(runtime.roll(two.matchId, 'p2', 0).ok, false, 'out-of-turn roll rejected')
  assert.equal(runtime.roll(two.matchId, 'p1', 0).ok, true)
  const rolled = seen.at(-1)!
  assert.equal(rolled.state.diceValue, 6, 'server RNG result')
  assert.equal(runtime.roll(two.matchId, 'p1', 0).ok, false, 'duplicate/stale roll rejected')
  assert.equal(runtime.move(two.matchId, 'p1', rolled.revision, 3).ok, true, 'legal move applies')
  assert.equal(runtime.move(two.matchId, 'p1', rolled.revision, 3).ok, false, 'same move applies once')
  assert.equal(runtime.reconnect('p1', 'reconnected')?.revision, 2, 'reconnect restores latest revision')
  assert.equal(runtime.requestState('p1')?.state.pieces.find((p) => p.color === 'red' && p.slot === 3)?.position.kind, 'track')
  runtime.getMatch(two.matchId)!.botControlledColors.add('red')
  assert.equal(runtime.reclaim(two.matchId, 'p1', 2).ok, true, 'authoritative human reclaim')
  assert.deepEqual(runtime.requestState('p1')?.botControlledColors, [], 'reclaim clears sticky bot control')
  assert.equal(runtime.requestState('p1')?.events.some((event) => event.type === 'human_control_resumed'), false, 'requestState omits transient events')
  const reclaimedRevision = runtime.requestState('p1')!.revision
  assert.equal(runtime.reclaim(two.matchId, 'p1', 0).ok, true, 'duplicate stale reclaim is idempotent')
  assert.equal(runtime.requestState('p1')?.revision, reclaimedRevision, 'duplicate reclaim does not publish another revision')
  const four = runtime.createMatch({ ...room(4), players: room(4).players.map((player, index) => ({ ...player, profileId: `four-p${index}`, connectionId: `four-c${index}` })), hostProfileId: 'four-p0' })
  assert.deepEqual(four.players.map((p) => p.color), ['red', 'blue', 'green', 'yellow'], '4-player mapping')
  assert.deepEqual(four.state.turnOrder, ['red', 'blue', 'yellow', 'green'], 'canonical 4-player turn order')
  runtime.destroy()
}

{
  const s = state([{ kind: 'track', trackIndex: 0 }, ...[1, 2, 3].map((slot) => ({ kind: 'home' as const, slot }))], [{ kind: 'track', trackIndex: 3 }, ...[1, 2, 3].map((slot) => ({ kind: 'home' as const, slot }))])
  const { runtime, started, snapshots } = scenario(s, 3)
  runtime.roll(started.matchId, 'p1', 0)
  assert.equal(runtime.move(started.matchId, 'p1', 1, 1).ok, false, 'illegal pawn move rejected without consuming revision')
  runtime.move(started.matchId, 'p1', 1, 0)
  const final = snapshots.at(-1)!
  assert.deepEqual(final.state.pieces.find((p) => p.color === 'blue' && p.slot === 0)?.position, { kind: 'home', slot: 0 }, 'capture')
  runtime.destroy()
}

{
  const s = state([{ kind: 'track', trackIndex: 5 }, ...[1, 2, 3].map((slot) => ({ kind: 'home' as const, slot }))], [{ kind: 'track', trackIndex: 8 }, ...[1, 2, 3].map((slot) => ({ kind: 'home' as const, slot }))])
  const { runtime, started } = scenario(s, 3)
  runtime.roll(started.matchId, 'p1', 0)
  runtime.move(started.matchId, 'p1', 1, 0)
  assert.deepEqual(runtime.requestState('p2')!.state.pieces.find((p) => p.color === 'blue' && p.slot === 0)?.position, { kind: 'track', trackIndex: 8 }, 'safe cell prevents capture')
  runtime.destroy()
}

{
  const s = state([0, 1, 2, 3].map((slot) => ({ kind: 'home', slot })))
  const { runtime, started } = scenario(s, 1)
  runtime.roll(started.matchId, 'p1', 0)
  const final = runtime.requestState('p1')!
  assert.equal(final.state.activeColor, 'blue', 'no legal move advances turn')
  assert.equal(final.state.turnPhase, 'waiting_for_roll')
  runtime.destroy()
}

{
  const s = state([{ kind: 'track', trackIndex: 55 }, ...[1, 2, 3].map((slot) => ({ kind: 'home' as const, slot }))])
  const { runtime, started } = scenario(s, 1)
  runtime.roll(started.matchId, 'p1', 0)
  runtime.move(started.matchId, 'p1', 1, 0)
  assert.deepEqual(
    runtime.requestState('p1')!.state.pieces.find((p) => p.color === 'red' && p.slot === 0)?.position,
    { kind: 'finish', finishIndex: 0 },
    'track completion enters the private finish lane',
  )
  runtime.destroy()
}

{
  const s = state([{ kind: 'finish', finishIndex: 4 }, { kind: 'finish', finishIndex: 5 }, { kind: 'finish', finishIndex: 5 }, { kind: 'finish', finishIndex: 5 }])
  const { runtime, started, snapshots } = scenario(s, 1, 20)
  runtime.roll(started.matchId, 'p1', 0)
  runtime.move(started.matchId, 'p1', 1, 0)
  const final = runtime.requestState('p1')!
  const opponentFinal = runtime.requestState('p2')!
  assert.equal(final.state.status, 'finished', 'fourth pawn finishes match')
  assert.equal(final.state.winnerColor, 'red')
  assert.equal(opponentFinal.state.winnerColor, final.state.winnerColor, 'all participants receive the same winner')
  assert.equal(snapshots.at(-1)?.state.status, 'finished', 'final snapshot is published before cleanup')
  assert.equal(runtime.roll(started.matchId, 'p1', final.revision).ok, false, 'action after finish rejected')
  assert.equal(runtime.move(started.matchId, 'p1', final.revision, 0).ok, false, 'move after finish rejected')
  assert.equal(runtime.roll(started.matchId, 'p1', final.revision - 1).ok, false, 'stale action after finish rejected')
  assert.equal(runtime.requestState('p1')?.revision, final.revision, 'post-finish actions do not change revision')
  assert.deepEqual(runtime.leave(started.matchId, 'p1'), { ok: true, winnerColor: 'red' }, 'winner can acknowledge finished match')
  assert.equal(runtime.requestState('p1'), null, 'winner binding is released immediately after acknowledgement')
  assert.deepEqual(runtime.leave(started.matchId, 'p2'), { ok: true, winnerColor: 'red' }, 'loser can acknowledge finished match')
  assert.equal(runtime.requestState('p2'), null, 'loser binding is released immediately after acknowledgement')
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(runtime.getMatch(started.matchId), undefined, 'finished match is removed after retention TTL')
  assert.equal(runtime.requestState('p1'), null, 'winner profile binding is removed after cleanup')
  assert.equal(runtime.requestState('p2'), null, 'loser profile binding is removed after cleanup')
  const next = runtime.createMatch(room(2))
  assert.equal(runtime.requestState('p1')?.matchId, next.matchId, 'profile can start another match after cleanup')
  runtime.destroy()
}

{
  const s = state([{ kind: 'finish', finishIndex: 4 }, ...[1, 2, 3].map((slot) => ({ kind: 'home' as const, slot }))])
  const { runtime, started } = scenario(s, 2)
  runtime.roll(started.matchId, 'p1', 0)
  const final = runtime.requestState('p1')!
  assert.equal(final.state.activeColor, 'blue', 'exact-finish overshoot is illegal and advances turn')
  assert.deepEqual(final.state.pieces.find((p) => p.color === 'red' && p.slot === 0)?.position, { kind: 'finish', finishIndex: 4 })
  runtime.destroy()
}

{
  const opposite = { red: 'yellow', yellow: 'red', blue: 'green', green: 'blue' } as const
  for (const creatorColor of ['red', 'blue', 'green', 'yellow'] as const) {
    const runtime = createLudoMatchRuntime({ randomTwoPlayerCreatorColor: () => creatorColor, onSnapshot: () => undefined })
    const two = runtime.createMatch(room(2))
    assert.equal(two.players.find((player) => player.profileId === 'p1')?.color, creatorColor, 'creator receives server-selected color')
    assert.equal(two.players.find((player) => player.profileId === 'p2')?.color, opposite[creatorColor], 'second player receives opposite color')
    assert.deepEqual(two.state.turnOrder, [creatorColor, opposite[creatorColor]], 'creator color is first in turn order')
    assert.equal(two.state.activeColor, creatorColor, 'creator takes the first turn')
    runtime.destroy()
  }
}

{
  const snapshots: LudoMatchSnapshot[] = []
  const runtime = createLudoMatchRuntime({ randomTwoPlayerCreatorColor: () => 'red', onSnapshot: (snapshot) => snapshots.push(snapshot) })
  const two = runtime.createMatch(room(2))
  const leave = runtime.leave(two.matchId, 'p1')
  assert.deepEqual(leave, { ok: true, winnerColor: 'yellow' }, '2-player leave awards the remaining player')
  const finished = snapshots.at(-1)!
  assert.equal(finished.state.status, 'finished', '2-player leave finishes match')
  assert.equal(finished.state.winnerColor, 'yellow', 'remaining color is canonical winner')
  assert.deepEqual(finished.players.map((player) => player.profileId), ['p2'], 'leaver is removed from match players')
  assert.equal(runtime.requestState('p1'), null, 'leaver profile membership is released immediately')
  assert.equal(runtime.requestState('p2')?.state.status, 'finished', 'winner retains finished snapshot through popup retention')

  const four = runtime.createMatch({ ...room(4), players: room(4).players.map((player, index) => ({ ...player, profileId: `leave-four-p${index}`, connectionId: `leave-four-c${index}` })), hostProfileId: 'leave-four-p0' })
  const unsupported = runtime.leave(four.matchId, 'leave-four-p0')
  assert.equal(unsupported.ok, false, '4-player started leave remains unsupported')
  if (!unsupported.ok) assert.equal(unsupported.code, 'ludo_match_leave_unsupported')
  assert.equal(runtime.requestState('leave-four-p0')?.state.status, 'in_progress', 'unsupported leave does not mutate 4-player match')
  runtime.destroy()
}

{
  const snapshots: LudoMatchSnapshot[] = []
  const runtime = createLudoMatchRuntime({
    randomDie: () => 6,
    randomTwoPlayerCreatorColor: () => 'red',
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  })
  const two = runtime.createMatch(room(2))
  runtime.getMatch(two.matchId)!.botControlledColors.add('red')
  assert.equal(runtime.roll(two.matchId, 'p1', 0).ok, true, 'bot-controlled color reaches move selection')
  assert.equal(runtime.requestState('p1')?.state.turnPhase, 'awaiting_move_selection')
  await new Promise((resolve) => setTimeout(resolve, 1_450))
  const revisionBeforeReclaim = runtime.requestState('p1')!.revision
  assert.equal(runtime.reclaim(two.matchId, 'p1', revisionBeforeReclaim).ok, true, 'reclaim succeeds just before bot timeout')
  const reclaimed = snapshots.at(-1)!
  assert.deepEqual(reclaimed.botControlledColors, [], 'reclaim broadcasts human ownership')
  assert.equal(reclaimed.events.some((event) => event.type === 'human_control_resumed'), true, 'other player observes resumed control')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(runtime.requestState('p1')?.revision, reclaimed.revision, 'stale bot timeout cannot mutate after reclaim')
  assert.equal(runtime.requestState('p1')?.state.turnPhase, 'awaiting_move_selection', 'reclaimed move waits for human selection')
  assert.equal(runtime.reclaim(two.matchId, 'p1', revisionBeforeReclaim).ok, true, 'duplicate reclaim remains idempotent')
  assert.equal(runtime.requestState('p1')?.revision, reclaimed.revision, 'duplicate reclaim does not republish')
  runtime.destroy()
}

{
  let now = 100_000
  const snapshots: LudoMatchSnapshot[] = []
  const runtime = createLudoMatchRuntime({
    now: () => now,
    randomTwoPlayerCreatorColor: () => 'red',
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  })
  const two = runtime.createMatch(room(2))
  runtime.getMatch(two.matchId)!.botControlledColors.add('yellow')
  const before = runtime.requestState('p1')!
  now += 2_000
  assert.equal(runtime.reclaim(two.matchId, 'p2', before.revision).ok, true, 'inactive player reclaim succeeds')
  const after = runtime.requestState('p1')!
  assert.equal(after.state.activeColor, before.state.activeColor, 'inactive reclaim preserves active color')
  assert.equal(after.state.turnPhase, before.state.turnPhase, 'inactive reclaim preserves phase')
  assert.equal(after.deadlineAt, before.deadlineAt, 'inactive reclaim preserves absolute server deadline')
  assert.equal(after.deadlineAt! - after.serverNow, 8_000, 'inactive reclaim preserves remaining time')
  assert.equal(after.revision, before.revision + 1, 'ownership broadcast advances revision once')
  runtime.destroy()
}

assert.equal(home('red', 0).position.kind, 'home')
console.log('PASS authoritative Ludo runtime: 2/4 start, shared RNG snapshot, authorization, revisions, legal/illegal move, capture, safe cell, no-move, finish lane, exact finish, shared winner, reconnect, finished cleanup')
