// ВРЕМЕННО — тестови ботове за Свара. Премахва се заедно с каталога testBots/
// (docs/svara-test-bots-local.md).
//
// Изрично „Изход“ на последния реален играч от маса с ботове прекратява мача
// НЕЗАБАВНО, без победител и без да се чака край на раздаване/показ.
//
// Само съществуващи engine команди, всяка валидирана от engine-а:
//   1. `set-absent` за всеки бот — ПРЕДИ изхода на човека. Иначе изходът сам
//      би направил последния жив бот победител (finishRound: един активен).
//      Отсъстващият автоматично отказва обикновеното раздаване (правило §8).
//   2. Изходът на човека — същата участническа `exit` команда (същият
//      commandId → същата идемпотентност при повторение).
//   3. Придвижване до граница на раздаване със същите системни команди, които
//      lifecycle-ът изпълнява при изтичане на срок (turn-timeout за отсъстващ,
//      finish-dealing, close-svara-joining, expire-reveal-choice, ...), само
//      без изчакване — engine-ът проверява roundId/фазата на всяка от тях.
//   4. `finish-presence-wait` с winnerId=null — съществуващото прекратяване
//      (finishReason 'all-absent'): свободните стекове остават на
//      собствениците си, неразрешените банки се затварят в 'removed'.
//      Няма фиктивен победител; ledger-ът и инвариантите остават коректни.
// Всяка команда е атомарна и се записва в SQLite преди RAM commit.

import type { SvaraMatchRuntime, SvaraSystemCommand } from '../runtime/svaraMatchRuntime.js'

type AbortRuntime = Pick<SvaraMatchRuntime, 'getPublicTable' | 'getLifecycleView' | 'getAutomaticCommand'
  | 'getDeadlinesForServer' | 'executeSystemCommand' | 'executeParticipantCommand' | 'hasMatch'>

const ALIVE = new Set(['active', 'absent'])
const MAX_STEPS = 64

/**
 * Ще прекрати ли изходът на `playerId` мача като „само ботове“: в мача има
 * жив бот, играчът е човек в игра, и след него не остава друг жив човек.
 * Маси само с хора никога не отговарят на условието.
 */
export function isLastHumanLeavingTestBotMatch(runtime: AbortRuntime, matchId: string, playerId: string, isBot: (id: string) => boolean): boolean {
  if (!runtime.hasMatch(matchId) || isBot(playerId)) return false
  const table = runtime.getPublicTable(matchId)
  if (table.phase !== 'in-progress') return false
  const me = table.players.find((p) => p.playerId === playerId)
  if (!me || (me.status !== 'active' && me.status !== 'absent' && me.status !== 'eliminated')) return false
  const aliveBots = table.players.filter((p) => isBot(p.playerId) && ALIVE.has(p.status))
  const otherHumans = table.players.filter((p) => p.playerId !== playerId && !isBot(p.playerId) && ALIVE.has(p.status))
  return aliveBots.length > 0 && otherHumans.length === 0
}

/** Изходът на последния човек + незабавно прекратяване без победител. */
export function exitAndAbortTestBotMatch(runtime: AbortRuntime, matchId: string, playerId: string, clientCommandId: string, isBot: (id: string) => boolean): void {
  const id = (step: string) => `test-bot-abort:${matchId}:${runtime.getLifecycleView(matchId).revision}:${step}`
  for (const p of runtime.getPublicTable(matchId).players) {
    if (isBot(p.playerId) && p.status === 'active') runtime.executeSystemCommand(matchId, id(`absent:${p.playerId}`), { type: 'set-absent', playerId: p.playerId, absent: true })
  }
  runtime.executeParticipantCommand(matchId, { playerId }, clientCommandId, { type: 'exit' })
  for (let step = 0; step < MAX_STEPS; step++) {
    const view = runtime.getLifecycleView(matchId)
    if (view.phase !== 'in-progress') return
    if (view.atBoundary && view.readyPlayerIds.length === 0) {
      runtime.executeSystemCommand(matchId, id('finish'), { type: 'finish-presence-wait', winnerId: null })
      continue
    }
    const automatic = runtime.getAutomaticCommand(matchId)
    // Нов рунд/връщане не са част от прекратяването (без активни играчи няма такива).
    if (automatic && automatic.type !== 'start-next-round' && automatic.type !== 'activate-returns') {
      runtime.executeSystemCommand(matchId, id(automatic.type), automatic)
      continue
    }
    const next = runtime.getDeadlinesForServer(matchId).filter((d) => d.kind !== 'presence-wait').sort((a, b) => a.deadlineAt - b.deadlineAt)[0]
    if (!next) return // няма как да напредне — оставяме нормалния lifecycle
    let command: SvaraSystemCommand
    if (next.kind === 'turn') command = { type: 'turn-timeout', playerId: next.playerId!, roundId: next.roundId!, actionVersion: next.actionVersion }
    else if (next.kind === 'dealing') command = { type: 'finish-dealing', roundId: next.roundId! }
    else if (next.kind === 'svara-joining') command = { type: 'close-svara-joining', roundId: next.roundId! }
    else if (next.kind === 'reveal-choice') command = { type: 'expire-reveal-choice', roundId: next.roundId! }
    else if (next.kind === 'reveal-display') command = { type: 'close-reveal-display', roundId: next.roundId! }
    else if (next.kind === 'showdown-display') command = { type: 'advance-showdown-display', roundId: next.roundId! }
    else command = { type: 'close-payout-display', roundId: next.roundId! }
    runtime.executeSystemCommand(matchId, id(`${next.kind}:${next.generation}`), command)
  }
}
