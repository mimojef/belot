function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

export type TournamentFeederWaitingState = {
  tournamentId: string
  label: string
  scoreA: number | null
  scoreB: number | null
  status: 'in_progress' | 'completed'
}

type TournamentFeederWaitingStripController = {
  setState: (state: TournamentFeederWaitingState | null) => void
}

// Компактна постоянна лента (§8 в task spec-а: "Играчът може да навигира из
// сайта, но трябва да остане компактна постоянна tournament лента"),
// показвана между "спечели рунда" и "получи tournament_match_assigned за
// следващия кръг" — тоест докато другият feeder мач още не е приключил и
// следващият bracket мач все още не съществува. Веднъж щом пристигне
// tournament_match_assigned, tournamentMatchStartPopup поема (различен UI,
// вече с реален countdown), затова тази лента се крие тогава (виж setState(null)
// извикването в main.ts при tournament_match_assigned).
export function createTournamentFeederWaitingStrip(options: {
  container: HTMLElement
}): TournamentFeederWaitingStripController {
  function render(state: TournamentFeederWaitingState | null): void {
    if (state === null) {
      options.container.innerHTML = ''
      return
    }
    const scoreText = state.scoreA !== null && state.scoreB !== null
      ? `${state.scoreA}–${state.scoreB}`
      : 'в ход'
    options.container.innerHTML = `
      <div style="position:fixed;bottom:14px;left:50%;transform:translateX(-50%);z-index:90000;display:flex;align-items:center;gap:8px;border:1px solid rgba(148,163,253,0.4);border-radius:999px;background:#101625;color:#f8fafc;box-shadow:0 12px 34px rgba(0,0,0,0.5);padding:8px 16px;font-family:Inter,system-ui,sans-serif;font-size:12px;font-weight:800;white-space:nowrap;">
        <span style="color:#93c5fd;">Очаквате следващия си турнирен мач</span>
        <span style="color:rgba(248,250,252,0.5);">—</span>
        <span>${escapeHtml(state.label)}: ${escapeHtml(scoreText)}</span>
      </div>
    `
  }

  return {
    setState(state) {
      render(state)
    },
  }
}
