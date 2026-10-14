// Четим текстов отчет от събитията на belot hand журнала (за CLI-то и за
// ръчно разследване). Не пипа файлове/база — само форматира.

import type { BelotHandJournalCheck, BelotHandJournalEvent } from './belotHandJournalTypes.js'

const SUIT_SYMBOL: Record<string, string> = { clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠' }
const CONTRACT_LABEL: Record<string, string> = { suit: 'Коз', 'no-trumps': 'Без коз', 'all-trumps': 'Всичко коз' }

export function formatBelotCard(cardId: unknown): string {
  if (typeof cardId !== 'string') return String(cardId)
  const [suit, rank] = cardId.split('-')
  return `${rank ?? '?'}${SUIT_SYMBOL[suit ?? ''] ?? suit ?? ''}`
}

function cards(list: unknown): string {
  return Array.isArray(list) ? list.map(formatBelotCard).join(' ') : '-'
}

function pair(score: unknown): string {
  const value = score as { teamA?: number; teamB?: number } | null | undefined
  if (!value) return '-'
  return `A ${value.teamA ?? '?'} / B ${value.teamB ?? '?'}`
}

function bidLabel(action: { type?: string; suit?: string } | undefined): string {
  if (!action) return '?'
  switch (action.type) {
    case 'pass': return 'пас'
    case 'suit': return `${SUIT_SYMBOL[action.suit ?? ''] ?? action.suit} коз`
    case 'no-trumps': return 'Без коз'
    case 'all-trumps': return 'Всичко коз'
    case 'double': return 'Контра'
    case 'redouble': return 'Реконтра'
    default: return action.type ?? '?'
  }
}

function checksLine(checks: unknown): string {
  if (!Array.isArray(checks) || checks.length === 0) return ''
  const failed = (checks as BelotHandJournalCheck[]).filter((check) => !check.ok)
  if (failed.length === 0) return `проверки: OK (${checks.length})`
  return `ПРОВЕРКИ: ${failed.length} АНОМАЛИИ — ${failed.map((check) => `${check.name}: ${check.detail ?? ''}`).join(' | ')}`
}

function formatEvent(event: BelotHandJournalEvent, lines: string[]): void {
  const p = event.payload as Record<string, any>
  const time = event.occurredAt.slice(11, 23)
  switch (event.eventType) {
    case 'hand_started': {
      lines.push(`  [${time}] РАЗДАВАНЕ ${event.handId} (наблюдавано във фаза ${p.observedPhase}${p.reconstructedMidHand ? ', реконструирано след рестарт' : ''})`)
      for (const player of p.players ?? []) {
        lines.push(
          `      ${player.seat}(${player.team}) ${player.displayName ?? '-'} [${player.kind}${player.profileId ? ` profile=${player.profileId}` : ''}${player.botCode ? ` bot=${player.botCode}` : ''}]`,
        )
      }
      lines.push(`      раздава: ${p.dealerSeat}, цепи: ${p.cutterSeat} (позиция ${p.selectedCutIndex ?? '-'}), пръв: ${p.firstDealSeat}`)
      for (const seat of ['bottom', 'right', 'top', 'left']) {
        lines.push(`      ${seat.padEnd(6)}: ${cards(p.deal?.[seat])}`)
      }
      lines.push(`      резултат преди: ${pair(p.matchScoreBefore)}, висящи преди: ${pair(p.carryOverBefore)}`)
      const line = checksLine(p.checks)
      if (line) lines.push(`      ${line}`)
      break
    }
    case 'bidding_completed': {
      const entries = (p.entries ?? []).map((entry: any) => `${entry.seat}: ${bidLabel(entry.action)}`).join(', ')
      lines.push(`  [${time}] НАДДАВАНЕ ${entries}${p.finalBidsObserved === false ? ' (последните обяви не са наблюдавани)' : ''}`)
      const bid = p.winningBid
      lines.push(
        bid
          ? `      договор: ${CONTRACT_LABEL[bid.contract] ?? bid.contract}${bid.trumpSuit ? ` ${SUIT_SYMBOL[bid.trumpSuit]}` : ''}, изпълнител ${bid.bidderSeat} (${bid.bidderTeam})${bid.redoubled ? ', РЕКОНТРА' : bid.doubled ? ', КОНТРА' : ''}`
          : '      всички пас',
      )
      break
    }
    case 'hand_redeal':
      lines.push(`  [${time}] ПРЕРАЗДАВАНЕ (${p.reason}); резултат без промяна ${pair(p.matchScoreUnchanged)}`)
      break
    case 'trick_completed': {
      const plays = (p.plays ?? [])
        .map((play: any) => `${play.seat} ${formatBelotCard(play.card)}${play.source && play.source !== 'unknown' ? `(${play.source})` : ''}`)
        .join(', ')
      lines.push(`  [${time}] ВЗЯТКА #${p.trickIndex} води ${p.leaderSeat}: ${plays} → ${p.winnerSeat} (${p.winnerTeam}), ${p.cardPoints} т.${p.isLastTrick ? ' [последна]' : ''}`)
      for (const declaration of p.declarationsDuringTrick ?? []) {
        lines.push(`      анонс: ${declaration.seat} ${declaration.type} ${declaration.points} т. [${cards(declaration.cards)}] announced=${declaration.announced} valid=${declaration.valid}`)
      }
      const line = checksLine(p.checks)
      if (line && line.startsWith('ПРОВЕРКИ')) lines.push(`      ${line}`)
      break
    }
    case 'sweep_offered':
      lines.push(`  [${time}] ДОЛУ КАРТИТЕ — предложение към ${p.claimantSeat} (${p.claimantTeam}) при взятка ${p.offeredAtTrickIndex}, остават ${p.remainingTricks} взятки / ${p.remainingCardPoints} т.`)
      for (const seat of ['bottom', 'right', 'top', 'left']) {
        lines.push(`      ${seat.padEnd(6)}: ${cards(p.remainingHands?.[seat])}`)
      }
      lines.push(`      основание: ${p.whyAllowed?.rule}; спечели последната взятка=${p.whyAllowed?.claimantWonLastTrick}; отказвал преди=${p.whyAllowed?.claimantDeclinedBefore}`)
      lines.push(`      ${checksLine(p.checks)}`)
      break
    case 'sweep_declined':
      lines.push(`  [${time}] ДОЛУ КАРТИТЕ — ОТКАЗ от ${p.claimantSeat}: ${p.decidedBy} (${p.msBeforeExpiry} ms преди изтичане); продължава ${p.playContinuesWithSeat}`)
      break
    case 'sweep_accept_rejected':
      lines.push(`  [${time}] ДОЛУ КАРТИТЕ — ОТХВЪРЛЕНО решение ${p.decision} от ${p.seat}: ${p.reason}; повторна проверка=${p.recheckEligible}`)
      break
    case 'sweep_accepted':
      lines.push(`  [${time}] ДОЛУ КАРТИТЕ — ПРИЕТО от ${p.claimantSeat} (${p.claimantTeam}); присъдени ${p.awardedTricksCount} взятки, ${p.awardedCardPoints} т. от карти, последна взятка → ${p.lastTrickBonusGoesToTeam}`)
      for (const belote of p.autoCreditedBelotes ?? []) {
        lines.push(`      автоматичен белот: ${belote.seat} (${belote.team}) ${SUIT_SYMBOL[belote.suit] ?? belote.suit}`)
      }
      lines.push(`      ${checksLine(p.checks)}`)
      break
    case 'hand_scored': {
      const x = p.explanation ?? {}
      const t = x.official ?? {}
      lines.push(`  [${time}] ТОЧКУВАНЕ (${p.observedVia}) ${CONTRACT_LABEL[x.contract] ?? x.contract}${x.trumpSuit ? ` ${SUIT_SYMBOL[x.trumpSuit]}` : ''}, изпълнител ${x.bidderSeat} (${x.bidderTeam})${p.endedBySweep ? `, приключено с „Долу картите“ от ${p.endedBySweep.claimantSeat}` : ''}`)
      for (const key of ['teamA', 'teamB']) {
        const team = x.teams?.[key] ?? {}
        lines.push(
          `      ${key === 'teamA' ? 'A' : 'B'}: взятки ${team.tricksWon}, карти ${team.cardPoints}, последна +${team.lastTrickBonus}, ×${team.noTrumpsMultiplier}, капо +${team.capotBonus} → сурови ${team.rawPoints}`,
        )
      }
      lines.push(`      анонси (сурови): ${pair(x.declarationPoints)}, белот: ${pair(x.belotePoints)}; общо ${x.actualTotalPoints}/${x.expectedTotalPoints}`)
      lines.push(`      изход: ${x.outcome?.outcome} (изпълнител ${x.outcome?.bidderPoints} срещу ${x.outcome?.defenderPoints}); клон: ${t.ruleBranch}`)
      if (t.rounding) {
        const r = t.rounding
        lines.push(`      закръгляне (праг ${r.threshold}, общо ${r.recordedTotal}): ${r.teamARaw}→${r.roundedTeamA}, ${r.teamBRaw}→${r.roundedTeamB}, корекция ${r.adjustment}${r.adjustedTeam ? ` (${r.adjustedTeam})` : ''} ⇒ A ${r.teamA} / B ${r.teamB}`)
      }
      lines.push(`      начислени преди множител: ${pair(t.awardedBeforeMultiplier)}; ×${t.counterMultiplier} ⇒ ${pair(t.awardedAfterMultiplier)}`)
      for (const item of t.carryOverResolutions ?? []) {
        lines.push(`      висящи ${item.points} на ${item.ownerTeam} → ${item.awardedTo} (${item.reason})`)
      }
      lines.push(`      висящи: ${pair(x.carryOverBefore)} → ${pair(x.carryOverAfter)} (${t.nextCarryOverReason})`)
      lines.push(`      точки за раздаването: ${pair(x.roundBreakdown?.total)}; общ резултат: ${pair(x.matchBefore)} → ${pair(x.matchAfter)} (приложено ${pair(p.applied?.matchAfter)})`)
      lines.push(`      капо: ${x.capotTeam ?? 'няма'}; ${checksLine(p.checks)}`)
      break
    }
    case 'hand_abandoned':
      lines.push(`  [${time}] РАЗДАВАНЕТО ПРЕКЪСНАТО (${p.reason}) във фаза ${p.phaseAtAbandon}; изиграни взятки ${(p.completedTricks ?? []).length}`)
      break
    case 'match_ended':
      lines.push(`  [${time}] КРАЙ НА МАЧА: победител ${p.winnerTeam}, резултат ${pair(p.finalScore)} (до ${p.targetScore})`)
      break
    case 'journal_storage':
      lines.push(`  [${time}] ${event.severity === 'anomaly' ? '!!! ' : ''}ХРАНИЛИЩЕ ${p.kind}: ${p.detail}`)
      break
    case 'anomaly':
      lines.push(`  [${time}] !!! АНОМАЛИЯ ${p.anomalyType}: ${p.check?.name ?? ''} — ${p.check?.detail ?? ''}`)
      break
  }
}

export function formatBelotHandJournalReport(events: readonly BelotHandJournalEvent[]): string {
  const lines: string[] = []
  let currentMatch: string | null = null
  const sorted = [...events].sort((left, right) => left.occurredAtMs - right.occurredAtMs)
  for (const event of sorted) {
    if (event.matchId !== currentMatch) {
      currentMatch = event.matchId
      lines.push('')
      lines.push(`═══ МАЧ ${event.matchId} (стая ${event.roomId}) ═══`)
    }
    formatEvent(event, lines)
  }
  const anomalies = sorted.filter((event) => event.eventType === 'anomaly')
  lines.push('')
  lines.push(`Събития: ${sorted.length}; аномалии: ${anomalies.length}`)
  return lines.join('\n')
}
