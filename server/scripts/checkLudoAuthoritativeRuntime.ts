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
  const runtime = createLudoMatchRuntime({ randomDie: () => die, initialStateFactory: () => initial, finishedMatchRetentionMs, onSnapshot: (snapshot) => snapshots.push(snapshot) })
  const started = runtime.createMatch(room(2))
  return { runtime, started, snapshots }
}

{
  const seen: LudoMatchSnapshot[] = []
  const runtime = createLudoMatchRuntime({ randomDie: () => 6, onSnapshot: (snapshot) => seen.push(snapshot) })
  const two = runtime.createMatch(room(2))
  assert.deepEqual(two.players.map((p) => p.color), ['red', 'blue'], '2-player mapping')
  assert.deepEqual(two.state.turnOrder, ['red', 'blue'], '2-player turn order')
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

assert.equal(home('red', 0).position.kind, 'home')
console.log('PASS authoritative Ludo runtime: 2/4 start, shared RNG snapshot, authorization, revisions, legal/illegal move, capture, safe cell, no-move, finish lane, exact finish, shared winner, reconnect, finished cleanup')
