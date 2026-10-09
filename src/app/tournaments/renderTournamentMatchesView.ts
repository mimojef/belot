import type {
  TournamentDetailSnapshot,
  TournamentMatchSnapshot,
  TournamentRoundType,
  TournamentStatus,
} from '../network/createGameServerClient'
import { getTournamentRoundLabel } from './tournamentRoundLabels'
import { getTournamentTeamSlotLetter } from './tournamentTeamLabels'

// ─── "Турнирни срещи" (Виж игрите) ─────────────────────────────────────────
// Чисто информационен изглед върху вече зареденото TournamentDetailSnapshot
// (rounds/teams идват от persisted tournament_matches/tournament_teams/
// tournament_entries, live резултатът — от authoritative room state на
// сървъра). Тук нищо не се изчислява "на ръка": резултати, победители и
// статуси се показват точно както са дошли; липсващи данни се показват като
// липсващи, никога не се измислят.

// Видимост на "Виж игрите" — по реалния статус на турнира, не по наличието
// на активни маси. 'open' (записване) и 'starting' (изчаква започване) не
// показват бутона; започнал или завършил турнир — показва.
const TOURNAMENT_GAMES_VISIBLE_STATUSES: ReadonlySet<TournamentStatus> = new Set<TournamentStatus>([
  'semifinal_in_progress',
  'final_in_progress',
  'finished',
])

const TOURNAMENT_RUNNING_STATUSES: ReadonlySet<TournamentStatus> = new Set<TournamentStatus>([
  'starting',
  'semifinal_in_progress',
  'final_in_progress',
])

const ROUND_ORDER: readonly TournamentRoundType[] = ['round_of_16', 'quarterfinal', 'semifinal', 'final']

export function shouldShowTournamentGamesButton(status: TournamentStatus): boolean {
  return TOURNAMENT_GAMES_VISIBLE_STATUSES.has(status)
}

/** Дали live абонамент/fallback refresh изобщо има смисъл (турнирът още тече). */
export function isTournamentMatchesLiveRelevant(status: TournamentStatus): boolean {
  return TOURNAMENT_RUNNING_STATUSES.has(status)
}

export type TournamentMatchCardTeam = {
  teamId: string
  letter: string | null
  playerNames: string[]
}

export type TournamentLiveMatchCard = {
  matchId: string
  roomId: string | null
  roundType: TournamentRoundType
  roundIndex: number
  stageLabel: string
  teamA: TournamentMatchCardTeam
  teamB: TournamentMatchCardTeam
  // Live score от сървъра (null — още не е налично, напр. масата се възстановява).
  scoreA: number | null
  scoreB: number | null
  phase: 'playing' | 'upcoming'
  statusText: string
  playedWithBots: boolean
  watch: 'available' | 'participant' | 'disabled'
}

export type TournamentHistoryMatchCard = {
  matchId: string
  roundType: TournamentRoundType
  roundIndex: number
  stageLabel: string
  teamA: TournamentMatchCardTeam
  teamB: TournamentMatchCardTeam
  scoreA: number | null
  scoreB: number | null
  winnerSide: 'A' | 'B' | null
  resultNote: string | null
  completedAt: string | null
}

export type TournamentHistoryRoundGroup = {
  roundType: TournamentRoundType
  title: string
  matches: TournamentHistoryMatchCard[]
}

export type TournamentMatchesViewModel = {
  live: TournamentLiveMatchCard[]
  history: TournamentHistoryRoundGroup[]
}

function roundOrderIndex(roundType: TournamentRoundType): number {
  const index = ROUND_ORDER.indexOf(roundType)
  return index === -1 ? ROUND_ORDER.length : index
}

function stageLabelFor(roundType: TournamentRoundType, roundIndex: number, roundMatchCount: number): string {
  const title = getTournamentRoundLabel(roundType)?.title ?? 'Среща'
  return roundType === 'final' || roundMatchCount <= 1 ? title : `${title} ${roundIndex}`
}

function buildTeam(t: TournamentDetailSnapshot, teamId: string): TournamentMatchCardTeam {
  const index = t.teams.findIndex((team) => team.teamId === teamId)
  if (index === -1) {
    return { teamId, letter: null, playerNames: [] }
  }
  return {
    teamId,
    letter: getTournamentTeamSlotLetter(index),
    playerNames: t.teams[index]!.members.map((member) => member.displayName),
  }
}

function isHistoryStatus(match: TournamentMatchSnapshot): boolean {
  return match.status === 'completed' || match.status === 'walkover'
}

export function buildTournamentMatchesViewModel(t: TournamentDetailSnapshot): TournamentMatchesViewModel {
  const roundMatchCounts = new Map<TournamentRoundType, number>()
  for (const round of t.rounds) {
    roundMatchCounts.set(round.roundType, (roundMatchCounts.get(round.roundType) ?? 0) + round.matches.length)
  }

  const slots = t.rounds
    .flatMap((round) => round.matches.map((match) => ({ round, match })))
    .sort((left, right) => (
      roundOrderIndex(left.round.roundType) - roundOrderIndex(right.round.roundType) ||
      left.round.roundIndex - right.round.roundIndex
    ))

  const spectatingEnabled = t.belotSpectatingEnabled === true
  // Активен участник в течащия турнир не може да гледа турнирни маси (сървърът
  // го отказва — виж evaluateBelotSpectatorWatchEligibility); тук само
  // спестяваме безсмислен бутон.
  const viewerIsActiveParticipant = t.viewer.isParticipant && isTournamentMatchesLiveRelevant(t.status)

  const live: TournamentLiveMatchCard[] = []
  const historyByRound = new Map<TournamentRoundType, TournamentHistoryMatchCard[]>()

  for (const { round, match } of slots) {
    const stageLabel = stageLabelFor(round.roundType, round.roundIndex, roundMatchCounts.get(round.roundType) ?? 1)
    const teamA = buildTeam(t, match.teamAId)
    const teamB = buildTeam(t, match.teamBId)

    if (isHistoryStatus(match)) {
      const winnerSide = match.winnerTeamId === null
        ? null
        : match.winnerTeamId === match.teamAId
          ? 'A'
          : match.winnerTeamId === match.teamBId
            ? 'B'
            : null
      const scoreA = match.finalScoreTeamA ?? null
      const scoreB = match.finalScoreTeamB ?? null
      const resultNote = match.resultKind === 'walkover'
        ? 'Служебна победа'
        : scoreA === null || scoreB === null
          ? 'Резултатът не е запазен'
          : match.resultKind === 'played_with_bots'
            ? 'Изиграна с участие на бот'
            : null
      const card: TournamentHistoryMatchCard = {
        matchId: match.matchId,
        roundType: round.roundType,
        roundIndex: round.roundIndex,
        stageLabel,
        teamA,
        teamB,
        scoreA,
        scoreB,
        winnerSide,
        resultNote,
        completedAt: match.completedAt,
      }
      const group = historyByRound.get(round.roundType) ?? []
      group.push(card)
      historyByRound.set(round.roundType, group)
      continue
    }

    if (match.status === 'cancelled') continue
    // Срещи на прекратен/отменен турнир, които така и не са завършили, не са
    // "играят в момента" — без измислен статус, просто не се показват.
    if (!isTournamentMatchesLiveRelevant(t.status)) continue

    const isPlaying = match.status === 'in_progress'
    const watch: TournamentLiveMatchCard['watch'] = !isPlaying || match.roomId === null || !spectatingEnabled
      ? 'disabled'
      : viewerIsActiveParticipant
        ? 'participant'
        : 'available'
    live.push({
      matchId: match.matchId,
      roomId: match.roomId,
      roundType: round.roundType,
      roundIndex: round.roundIndex,
      stageLabel,
      teamA,
      teamB,
      scoreA: isPlaying ? match.liveScoreTeamA ?? null : null,
      scoreB: isPlaying ? match.liveScoreTeamB ?? null : null,
      phase: isPlaying ? 'playing' : 'upcoming',
      statusText: isPlaying
        ? 'На живо'
        : match.status === 'countdown'
          ? 'Започва след секунди'
          : 'Изчакват се играчите',
      playedWithBots: match.resultKind === 'played_with_bots',
      watch,
    })
  }

  const history = [...historyByRound.entries()]
    .sort(([left], [right]) => roundOrderIndex(left) - roundOrderIndex(right))
    .map(([roundType, matches]) => ({
      roundType,
      title: getTournamentRoundLabel(roundType)?.title ?? 'Срещи',
      matches,
    }))

  return { live, history }
}

/**
 * Буквите на двата отбора в АКТИВНАТА среща на дадена маса — за етикетите на
 * зрителя ("ОТБОР A" / "ОТБОР H"). teamA е отборът на teamA седалките на
 * масата (coordinator mapping), затова редът A/B е запазен. null, ако масата
 * не е активна среща на този турнир или отборът не е известен.
 */
export function resolveTournamentMatchTeamLetters(
  t: TournamentDetailSnapshot,
  roomId: string,
): { teamA: string; teamB: string } | null {
  for (const round of t.rounds) {
    for (const match of round.matches) {
      if (match.roomId !== roomId || match.status !== 'in_progress') continue
      const teamA = buildTeam(t, match.teamAId).letter
      const teamB = buildTeam(t, match.teamBId).letter
      return teamA !== null && teamB !== null ? { teamA, teamB } : null
    }
  }
  return null
}

/**
 * Прилага live резултат (tournament_match_live_score) към кеширания detail.
 * Връща null, ако срещата не е известна като активна — тогава caller-ът прави
 * authoritative refetch вместо локално да "досъздава" състояние.
 */
export function applyTournamentMatchLiveScore(
  t: TournamentDetailSnapshot,
  update: { matchId: string; roomId: string; scoreTeamA: number; scoreTeamB: number },
): TournamentDetailSnapshot | null {
  let found = false
  const rounds = t.rounds.map((round) => ({
    ...round,
    matches: round.matches.map((match) => {
      if (match.matchId !== update.matchId || match.status !== 'in_progress' || match.roomId !== update.roomId) {
        return match
      }
      found = true
      return { ...match, liveScoreTeamA: update.scoreTeamA, liveScoreTeamB: update.scoreTeamB }
    }),
  }))
  return found ? { ...t, rounds } : null
}

// ─── HTML ──────────────────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function formatDateTime(iso: string | null): string {
  if (iso === null) return ''
  try {
    return new Date(iso).toLocaleString('bg-BG', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

const GREEN_BUTTON_STYLE = `
  border:1px solid rgba(74,222,128,0.55);border-radius:9px;
  background:linear-gradient(180deg,#22c55e 0%,#15803d 100%);
  color:#ffffff;font-weight:900;cursor:pointer;white-space:nowrap;
  box-shadow:0 2px 10px rgba(34,197,94,0.22);
`

export function renderTournamentGamesButton(t: TournamentDetailSnapshot): string {
  if (!shouldShowTournamentGamesButton(t.status)) return ''
  return `
    <button type="button" data-tournament-matches-open="1" style="
      ${GREEN_BUTTON_STYLE}
      height:32px;padding:0 14px;font-size:13px;flex-shrink:0;
    ">Виж игрите</button>
  `
}

function renderTeamRow(
  team: TournamentMatchCardTeam,
  score: string,
  options: { isWinner: boolean; isLoser: boolean; scoreAttributes: string },
): string {
  const names = team.playerNames.length > 0 ? team.playerNames.join(' и ') : 'Няма данни за играчите'
  const letter = team.letter ?? '?'
  const rowBorder = options.isWinner ? 'rgba(212,165,32,0.55)' : 'rgba(255,255,255,0.08)'
  const rowBackground = options.isWinner ? 'rgba(212,165,32,0.10)' : 'rgba(255,255,255,0.03)'
  const nameColor = options.isLoser ? 'rgba(255,255,255,0.55)' : '#ffffff'
  return `
    <div style="display:flex;align-items:center;gap:10px;min-width:0;padding:8px 10px;border-radius:8px;border:1px solid ${rowBorder};background:${rowBackground};">
      <span aria-label="Отбор ${escapeHtml(letter)}" style="
        width:30px;height:30px;flex-shrink:0;border-radius:8px;display:flex;align-items:center;justify-content:center;
        background:#101010;border:1px solid rgba(212,165,32,0.45);color:#d4a520;font-size:14px;font-weight:900;
      ">${escapeHtml(letter)}</span>
      <div style="flex:1;min-width:0;">
        <div style="font-size:10px;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:rgba(255,255,255,0.42);">Отбор ${escapeHtml(letter)}${options.isWinner ? ' · <span style="color:#f4c95b;">Победител</span>' : ''}</div>
        <div title="${escapeHtml(names)}" style="font-size:14px;font-weight:800;color:${nameColor};line-height:1.3;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${escapeHtml(names)}</div>
      </div>
      <div ${options.scoreAttributes} style="flex-shrink:0;min-width:44px;text-align:right;font-size:22px;font-weight:900;font-variant-numeric:tabular-nums;color:${options.isWinner ? '#f4c95b' : options.isLoser ? 'rgba(255,255,255,0.55)' : '#ffffff'};">${escapeHtml(score)}</div>
    </div>
  `
}

function renderLiveCard(card: TournamentLiveMatchCard): string {
  const scoreText = (value: number | null) => (card.phase === 'playing' ? (value === null ? '—' : String(value)) : '')
  const scoreAttributes = (team: 'a' | 'b') => card.phase === 'playing'
    ? `data-tournament-live-score="${escapeHtml(card.matchId)}" data-tournament-live-score-team="${team}"`
    : ''
  const statusPill = card.phase === 'playing'
    ? `<span style="display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:900;color:#4ade80;border:1px solid rgba(74,222,128,0.45);border-radius:999px;padding:3px 9px;white-space:nowrap;"><span style="width:7px;height:7px;border-radius:999px;background:#22c55e;box-shadow:0 0 6px #22c55e;"></span>${escapeHtml(card.statusText)}</span>`
    : `<span style="font-size:11px;font-weight:800;color:rgba(255,255,255,0.6);border:1px solid rgba(255,255,255,0.18);border-radius:999px;padding:3px 9px;white-space:nowrap;">${escapeHtml(card.statusText)}</span>`
  const watchHtml = card.watch === 'available' && card.roomId !== null
    ? `<button type="button" data-watch-tournament-match="${escapeHtml(card.roomId)}" style="${GREEN_BUTTON_STYLE}width:100%;min-height:42px;font-size:14px;margin-top:10px;">🟢 Гледай</button>`
    : card.watch === 'participant'
      ? `<div style="margin-top:10px;font-size:12px;font-weight:700;color:rgba(255,255,255,0.5);text-align:center;">Участниците в турнира не могат да гледат други турнирни маси.</div>`
      : ''
  return `
    <article data-tournament-live-match="${escapeHtml(card.matchId)}" style="box-sizing:border-box;min-width:0;background:#0d0d0d;border:1px solid rgba(212,165,32,0.30);border-radius:12px;padding:12px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
        <span style="font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">${escapeHtml(card.stageLabel)}</span>
        ${statusPill}
      </div>
      <div style="display:grid;gap:6px;">
        ${renderTeamRow(card.teamA, scoreText(card.scoreA), { isWinner: false, isLoser: false, scoreAttributes: scoreAttributes('a') })}
        ${renderTeamRow(card.teamB, scoreText(card.scoreB), { isWinner: false, isLoser: false, scoreAttributes: scoreAttributes('b') })}
      </div>
      ${card.playedWithBots ? '<div style="margin-top:8px;font-size:11px;font-weight:700;color:rgba(255,255,255,0.45);">Играе се с участие на бот.</div>' : ''}
      ${watchHtml}
    </article>
  `
}

function renderHistoryCard(card: TournamentHistoryMatchCard): string {
  const scoreText = (value: number | null) => (value === null ? '—' : String(value))
  const completedAt = formatDateTime(card.completedAt)
  return `
    <article data-tournament-history-match="${escapeHtml(card.matchId)}" style="box-sizing:border-box;min-width:0;background:#0d0d0d;border:1px solid rgba(255,255,255,0.10);border-radius:12px;padding:12px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
        <span style="font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">${escapeHtml(card.stageLabel)}</span>
        <span style="font-size:11px;font-weight:900;color:rgba(255,255,255,0.62);border:1px solid rgba(255,255,255,0.22);border-radius:999px;padding:3px 9px;white-space:nowrap;">Приключила</span>
      </div>
      <div style="display:grid;gap:6px;">
        ${renderTeamRow(card.teamA, scoreText(card.scoreA), { isWinner: card.winnerSide === 'A', isLoser: card.winnerSide === 'B', scoreAttributes: '' })}
        ${renderTeamRow(card.teamB, scoreText(card.scoreB), { isWinner: card.winnerSide === 'B', isLoser: card.winnerSide === 'A', scoreAttributes: '' })}
      </div>
      ${card.resultNote !== null || completedAt !== '' ? `
        <div style="margin-top:8px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:11px;font-weight:700;color:rgba(255,255,255,0.45);">
          <span>${card.resultNote !== null ? escapeHtml(card.resultNote) : ''}</span>
          <span>${completedAt !== '' ? escapeHtml(completedAt) : ''}</span>
        </div>
      ` : ''}
    </article>
  `
}

const CARD_GRID_STYLE = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));gap:10px;'

function renderSectionTitle(title: string, count: number): string {
  return `<div style="display:flex;align-items:center;gap:8px;margin:0 0 10px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.6);">${escapeHtml(title)}<span style="font-size:11px;color:#d4a520;">${count}</span></div>`
}

export function renderTournamentMatchesView(t: TournamentDetailSnapshot): string {
  const model = buildTournamentMatchesViewModel(t)
  const historyCount = model.history.reduce((sum, group) => sum + group.matches.length, 0)

  const liveHtml = model.live.length > 0
    ? `<div style="${CARD_GRID_STYLE}">${model.live.map(renderLiveCard).join('')}</div>`
    : `<div style="padding:18px 12px;border:1px dashed rgba(255,255,255,0.14);border-radius:10px;text-align:center;font-size:13px;color:rgba(255,255,255,0.5);">${isTournamentMatchesLiveRelevant(t.status) ? 'В момента не се играят срещи.' : 'Турнирът приключи — няма активни срещи.'}</div>`

  const historyHtml = model.history.length > 0
    ? model.history.map((group) => `
        <div style="margin-bottom:14px;">
          <div style="font-size:11px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:rgba(212,165,32,0.85);margin-bottom:8px;">${escapeHtml(group.title)}</div>
          <div style="${CARD_GRID_STYLE}">${group.matches.map(renderHistoryCard).join('')}</div>
        </div>
      `).join('')
    : `<div style="padding:18px 12px;border:1px dashed rgba(255,255,255,0.14);border-radius:10px;text-align:center;font-size:13px;color:rgba(255,255,255,0.5);">Все още няма приключили срещи.</div>`

  return `
    <section data-tournament-matches-view="1" style="box-sizing:border-box;padding:0 4px;max-width:720px;margin:0 auto;overflow-x:hidden;">
      <button
        type="button"
        data-tournament-matches-back="1"
        aria-label="Назад към турнира"
        style="
          display:inline-flex;align-items:center;gap:6px;margin-bottom:12px;height:36px;
          padding:0 14px;border-radius:8px;border:1px solid rgba(212,165,32,0.32);
          background:rgba(212,165,32,0.08);color:#d4a520;font-size:13px;font-weight:800;
          cursor:pointer;
        "
      >← Назад към турнира</button>

      <h2 style="font-size:22px;font-weight:900;color:#ffffff;margin:0 0 4px;">Турнирни срещи</h2>
      <div style="font-size:13px;font-weight:700;color:rgba(255,255,255,0.6);margin-bottom:18px;overflow-wrap:anywhere;">${escapeHtml(t.name)}</div>

      <div style="margin-bottom:22px;">
        ${renderSectionTitle('Играят в момента', model.live.length)}
        ${liveHtml}
      </div>

      <div style="margin-bottom:20px;">
        ${renderSectionTitle('История на срещите', historyCount)}
        ${historyHtml}
      </div>
    </section>
  `
}
