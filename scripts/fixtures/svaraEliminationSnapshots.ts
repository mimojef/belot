/**
 * Истински сървърни snapshot-и (engine → runtime → serializeSvaraSnapshotForClient)
 * за проверката на визуалния статус на отпаднал играч (checkSvaraEliminatedSeatDimBrowser).
 *
 * Мач с 4 играчи: bob и carol залагат всичко, alice и dave се отказват —
 * губещият от двамата отпада, мачът продължава. След едно раздаване
 * отпадналият излиза (сървърът го води 'exited'), следва ново раздаване.
 */
import { createSvaraMatchRuntime } from '../../server/src/games/svara/runtime/svaraMatchRuntime'
import { serializeSvaraSnapshotForClient } from '../../server/src/games/svara/protocol/svaraSnapshotProtocol'

export type SvaraEliminationStep = { label: string; table: unknown; snapshot: any }
export const SVARA_ELIMINATION_PLAYERS = ['alice', 'bob', 'carol', 'dave'] as const

function seededRandom(seed: number) {
  let s = seed >>> 0
  return { nextInt: (max: number) => { s = (s * 1664525 + 1013904223) >>> 0; return Math.floor((s / 2 ** 32) * max) } }
}

function startMatch(matchId: string, seed: number) {
  const rt = createSvaraMatchRuntime({ random: seededRandom(seed) })
  let n = 0
  const sys = (command: any) => rt.executeSystemCommand(matchId, `sys-${++n}`, command)
  const act = (player: string, command: unknown) => rt.executeParticipantCommand(matchId, { playerId: player }, `c-${++n}`, command)
  rt.registerMatch({ matchId, creator: { playerId: 'alice' }, capacity: 4, entryFee: 5_000, entryPercent: 1, startMode: 'manual' })
  for (const p of SVARA_ELIMINATION_PLAYERS.slice(1)) act(p, { type: 'join-seat' })
  act('alice', { type: 'start-match' })
  return { rt, sys, act }
}

/** Първият snapshot на нов мач със същите играчи (всички активни). */
export function generateSvaraFreshMatchStep(viewer: string, matchId: string): SvaraEliminationStep {
  const { rt } = startMatch(matchId, 7)
  return { label: 'new-match', table: rt.getPublicTable(matchId), snapshot: JSON.parse(serializeSvaraSnapshotForClient(rt.getPlayerSnapshot(matchId, { playerId: viewer }))) }
}

export function generateSvaraEliminationSnapshots(viewer: string, seed = 1): { steps: SvaraEliminationStep[]; eliminated: string } {
  const matchId = `elim-${seed}`
  const { rt, sys, act } = startMatch(matchId, seed)
  const steps: SvaraEliminationStep[] = []
  const capture = (label: string) => steps.push({ label, table: rt.getPublicTable(matchId), snapshot: JSON.parse(serializeSvaraSnapshotForClient(rt.getPlayerSnapshot(matchId, { playerId: viewer }))) })
  const tryAct = (p: string, action: unknown) => { try { act(p, action); return true } catch { return false } }
  let eliminated: string | null = null
  let exited = false
  for (let i = 0; i < 400; i++) {
    const st = rt.exportInternalStateForServer(matchId)
    if (st.phase !== 'in-progress') break
    const round = st.round as any
    if (!eliminated) {
      const found = st.seats.find((p) => st.status[p] === 'eliminated')
      if (found) { eliminated = found; capture('eliminated') }
    }
    if (eliminated && round && round.kind === 'ordinary' && !round.dealing) {
      if (!exited) {
        capture('next-round-betting')
        // „Изход“ от прозореца „Играта приключи за вас!“ → сървърна команда exit.
        act(eliminated, { type: 'exit' })
        exited = true
        capture('eliminated-exited')
      } else if (steps.at(-1)?.label === 'after-exit-next-round-dealing') { capture('after-exit-next-round-betting'); break }
    }
    if (round === null) {
      sys({ type: 'start-next-round' })
      if (eliminated) capture(exited ? 'after-exit-next-round-dealing' : 'next-round-dealing')
      continue
    }
    if ((round.kind === 'ordinary' || round.kind === 'svara') && round.dealing) { sys({ type: 'finish-dealing', roundId: round.roundId }); continue }
    if (round.kind === 'ordinary' || round.kind === 'svara') {
      const p = round.betting.toAct as string
      const aggressive = !eliminated && (p === 'bob' || p === 'carol')
      const first = aggressive ? [{ type: 'act', action: { kind: 'all-in' } }, { type: 'act', action: { kind: 'call' } }] : [{ type: 'act', action: { kind: 'fold' } }]
      if (first.some((a) => tryAct(p, a))) { if (aggressive) capture(`all-in-${p}`); continue }
      tryAct(p, { type: 'look' })
      if ([...first, { type: 'act', action: { kind: 'fold' } }].some((a) => tryAct(p, a))) { if (aggressive) capture(`all-in-${p}`); continue }
      throw new Error(`no action for ${p}`)
    }
    if (round.kind === 'reveal-choice') { sys({ type: 'expire-reveal-choice', roundId: round.roundId }); continue }
    if (round.kind === 'reveal-display') { sys({ type: 'close-reveal-display', roundId: round.roundId }); continue }
    if (round.kind === 'showdown-display') { capture(`showdown-${round.phase}`); sys({ type: round.phase === 'showdown' ? 'advance-showdown-display' : 'close-payout-display', roundId: round.roundId }); continue }
    if (round.kind === 'payout-display') { sys({ type: 'close-payout-display', roundId: round.roundId }); continue }
    if (round.kind === 'svara-joining') { sys({ type: 'close-svara-joining', roundId: round.roundId }); continue }
    throw new Error(`unexpected round ${round.kind}`)
  }
  if (!eliminated || !exited) throw new Error(`seed ${seed}: no elimination + exit sequence`)
  return { steps, eliminated }
}
