// ВРЕМЕННО — сървърно управлявани тестови ботове за Свара (само локално).
// Целият каталог testBots/ се премахва при окончателното пускане на Свара —
// виж docs/svara-test-bots-local.md, раздел „Премахване“.
//
// Модел: ботът е обикновен участник в съществуващия runtime. Той:
//   • сяда с участническата команда `join-seat` (същата като за човек);
//   • чете САМО защитения си индивидуален snapshot (getPlayerSnapshot) —
//     без чужди карти, тесте, RNG или дневник;
//   • действа САМО през host.submit(), т.е. през същия lobby път като
//     човешките команди (lifecycle.sync → executeParticipantCommand →
//     publish → progress). Engine, таймерите, банките, persistence и
//     recovery не се заобикалят и не се променят.
//
// Таймери: най-много един чакащ таймер на бот. Всеки таймер при изпълнение
// чете наново актуалния snapshot (никакви остарели решения). При край/
// закриване на мача, изключен флаг или shutdown всички таймери се спират.

import { SvaraMatchError } from '../engine/svaraMatch.js'
import type { SvaraMatchSnapshotMessage, SvaraPublicTable } from '../protocol/svaraSnapshotProtocol.js'
import type { SvaraClock } from '../runtime/createSvaraLifecycle.js'
import { SvaraRuntimeError } from '../runtime/svaraMatchRuntime.js'
import { isSvaraTestBotsEnabled } from './svaraTestBotsFeatureFlag.js'
import { createSvaraTestBotIds, getSvaraTestBotProfile, isSvaraTestBotId } from './svaraTestBotIdentity.js'
import { decideSvaraTestBotCommand, svaraTestBotHasDecision, type SvaraTestBotCommand } from './svaraTestBotStrategy.js'

/** Какво lobby-то предоставя на ботовете. Без сурово състояние и системни команди. */
export type SvaraTestBotHost = {
  hasMatch(matchId: string): boolean
  getPublicTable(matchId: string): SvaraPublicTable
  /** Защитеният индивидуален snapshot на самия бот (като за човек-клиент). */
  getBotSnapshot(matchId: string, botId: string): SvaraMatchSnapshotMessage
  /** Същият път като човешка `submit_svara_command`; хвърля при отказ. */
  submit(matchId: string, botId: string, command: SvaraTestBotCommand, expectedRevision: number): void
}

export type SvaraTestBots = {
  isEnabled(): boolean
  isBot(playerId: string): boolean
  publicProfile(playerId: string): { displayName: string; avatarUrl: string; gender: 'male' | 'female' } | null
  createBotIds(existingPlayerIds: readonly string[], count: number): string[]
  /** Вика се след всяка публикувана промяна на мача. Само планира — не изпълнява синхронно. */
  onMatchChanged(matchId: string): void
  shutdown(): void
  /** Диагностика/тестове: брой чакащи bot таймери. */
  pendingTimerCount(): number
}

export type SvaraTestBotsFactory = (host: SvaraTestBotHost, clock: SvaraClock) => SvaraTestBots

export const SVARA_TEST_BOT_DELAY_MS = { min: 1_000, max: 3_000 } as const
/** Кратка пауза между „Погледни“ и следващото решение на същия бот. */
export const SVARA_TEST_BOT_FOLLOW_UP_DELAY_MS = { min: 600, max: 1_200 } as const

export function createSvaraTestBotsFactory(options: {
  isEnabled?: () => boolean
  random?: () => number
  delayMs?: { min: number; max: number }
  followUpDelayMs?: { min: number; max: number }
  onError?: (cause: unknown) => void
} = {}): SvaraTestBotsFactory {
  const isEnabled = options.isEnabled ?? isSvaraTestBotsEnabled
  const random = options.random ?? Math.random
  const delay = options.delayMs ?? SVARA_TEST_BOT_DELAY_MS
  const followUp = options.followUpDelayMs ?? SVARA_TEST_BOT_FOLLOW_UP_DELAY_MS

  return (host, clock) => {
    // Таймерът помни revision-а, при който е планиран: всяка нова промяна на
    // мача го рестартира, така че ботът винаги „реагира“ с естествена пауза
    // след последното събитие, а не мигновено по остарял план.
    type Timer = { cancel: () => void; revision: number }
    const timers = new Map<string, Map<string, Timer>>()
    const followUps = new Set<string>()
    let stopped = false
    const key = (matchId: string, botId: string) => JSON.stringify([matchId, botId])
    const pick = (range: { min: number; max: number }) => range.min + Math.floor(random() * (Math.max(range.min, range.max) - range.min + 1))

    function cancelTimer(matchId: string, botId: string): void {
      const perMatch = timers.get(matchId)
      perMatch?.get(botId)?.cancel()
      perMatch?.delete(botId)
      if (perMatch?.size === 0) timers.delete(matchId)
    }

    function forget(matchId: string): void {
      for (const [botId, timer] of timers.get(matchId) ?? []) { timer.cancel(); followUps.delete(key(matchId, botId)) }
      timers.delete(matchId)
    }

    const humansPresent = (table: SvaraPublicTable) =>
      table.players.some((p) => !isSvaraTestBotId(p.playerId) && (p.status === 'active' || p.status === 'absent'))

    function schedule(matchId: string, botId: string, revision: number): void {
      const perMatch = timers.get(matchId) ?? new Map<string, Timer>()
      timers.set(matchId, perMatch)
      const wait = followUps.has(key(matchId, botId)) ? pick(followUp) : pick(delay)
      perMatch.set(botId, { cancel: clock.schedule(() => fire(matchId, botId), wait), revision })
    }

    function fire(matchId: string, botId: string): void {
      const perMatch = timers.get(matchId)
      perMatch?.delete(botId)
      if (perMatch?.size === 0) timers.delete(matchId)
      if (stopped) return
      if (!isEnabled() || !host.hasMatch(matchId)) { forget(matchId); return }
      try {
        const table = host.getPublicTable(matchId)
        if (table.phase !== 'in-progress') { forget(matchId); return }
        const snapshot = host.getBotSnapshot(matchId, botId)
        // Без хора на масата ботовете излизат, за да приключи мачът и да се
        // освободят ресурсите — не играят безкрайно помежду си.
        const command: SvaraTestBotCommand | null = humansPresent(table)
          ? decideSvaraTestBotCommand(snapshot, random)
          : (snapshot.you.status === 'active' || snapshot.you.status === 'absent') ? { type: 'exit' } : null
        if (command) {
          if (command.type === 'look') followUps.add(key(matchId, botId))
          else followUps.delete(key(matchId, botId))
          host.submit(matchId, botId, command, snapshot.revision)
        }
      } catch (cause) {
        // Отказ от engine/runtime (напр. остарял revision) е нормален: ботът
        // просто преоценява по актуалното състояние по-долу.
        if (!(cause instanceof SvaraRuntimeError || cause instanceof SvaraMatchError)) options.onError?.(cause)
      }
      onMatchChanged(matchId)
    }

    function onMatchChanged(matchId: string): void {
      if (stopped) return
      try {
        if (!isEnabled() || !host.hasMatch(matchId)) { forget(matchId); return }
        const table = host.getPublicTable(matchId)
        if (table.phase !== 'in-progress') { forget(matchId); return }
        const anyHuman = humansPresent(table)
        for (const player of table.players) {
          if (!isSvaraTestBotId(player.playerId)) continue
          if (player.status !== 'active' && player.status !== 'absent') { cancelTimer(matchId, player.playerId); continue }
          const snapshot = host.getBotSnapshot(matchId, player.playerId)
          const pending = timers.get(matchId)?.get(player.playerId)
          if (pending?.revision === snapshot.revision) continue // същото състояние — планът остава
          cancelTimer(matchId, player.playerId)
          if (anyHuman && !svaraTestBotHasDecision(snapshot)) continue
          schedule(matchId, player.playerId, snapshot.revision)
        }
      } catch (cause) { options.onError?.(cause) }
    }

    return {
      isEnabled: () => !stopped && isEnabled(),
      isBot: isSvaraTestBotId,
      publicProfile: getSvaraTestBotProfile,
      createBotIds: (existing, count) => createSvaraTestBotIds(existing, count, random),
      onMatchChanged,
      shutdown() {
        stopped = true
        for (const matchId of [...timers.keys()]) forget(matchId)
        followUps.clear()
      },
      pendingTimerCount: () => [...timers.values()].reduce((sum, perMatch) => sum + perMatch.size, 0),
    }
  }
}
