import type { RoomGameSnapshot, Seat } from '../network/createGameServerClient'

type RenderPlayingDebugScreenOptions = {
  root: HTMLDivElement
  game: RoomGameSnapshot
  localSeat: Seat
  roomId: string
  submitPlayCard: (roomId: string, cardId: string) => void
}

export function renderPlayingDebugScreen(options: RenderPlayingDebugScreenOptions): void {
  const { root, game, localSeat, roomId, submitPlayCard } = options
  const { authoritativePhase, playing, ownHand } = game

  const isMyTurn = playing?.currentTurnSeat === localSeat
  const validCardIds = playing?.validCardIds ?? null

  const trickPlaysHtml =
    playing && playing.currentTrickPlays.length > 0
      ? playing.currentTrickPlays
          .map((p) => `<div>${p.seat}: ${p.card.rank} ${p.card.suit} (${p.card.id})</div>`)
          .join('')
      : '<div>—</div>'

  const validWarning =
    isMyTurn && validCardIds === null
      ? '<div style="color:#f59e0b;margin-top:4px;">⚠ validCardIds липсва от snapshot</div>'
      : ''

  const handButtonsHtml =
    ownHand.length > 0
      ? ownHand
          .map((c) => {
            const isValid = !isMyTurn || validCardIds === null || validCardIds.includes(c.id)
            const disabled = !isValid ? 'disabled' : ''
            const style = isValid
              ? 'margin:2px;padding:4px 8px;cursor:pointer;background:#1e40af;color:#fff;border:1px solid #3b82f6;border-radius:4px;'
              : 'margin:2px;padding:4px 8px;cursor:not-allowed;background:#374151;color:#6b7280;border:1px solid #4b5563;border-radius:4px;opacity:0.5;'
            return `<button class="play-card-btn" data-card-id="${c.id}" ${disabled} style="${style}">${c.rank} ${c.suit}</button>`
          })
          .join('')
      : '<div>няма карти</div>'

  root.innerHTML = `
    <div style="padding:24px;font-family:monospace;color:#fff;background:#1a1a2e;min-height:100vh;">
      <h2 style="margin:0 0 16px;">Playing phase</h2>
      <div style="margin-bottom:8px;"><b>authoritativePhase:</b> ${authoritativePhase ?? '—'}</div>
      <div style="margin-bottom:8px;"><b>localSeat:</b> ${localSeat}</div>
      <div style="margin-bottom:8px;"><b>currentTurnSeat:</b> ${playing?.currentTurnSeat ?? '—'}</div>
      <div style="margin-bottom:8px;"><b>completedTricks:</b> ${playing?.completedTricksCount ?? 0} / 8</div>
      <div style="margin-bottom:16px;">
        <b>Текуща взятка:</b>
        <div style="margin-left:12px;">${trickPlaysHtml}</div>
      </div>
      <div>
        <b>Ръката ми (${ownHand.length} карти)${isMyTurn ? ' — ВАШ РЕД' : ''}:</b>
        ${validWarning}
        <div style="margin-top:8px;">${handButtonsHtml}</div>
      </div>
    </div>
  `

  root.querySelectorAll<HTMLButtonElement>('.play-card-btn:not([disabled])').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cardId = btn.dataset.cardId
      if (cardId) {
        submitPlayCard(roomId, cardId)
      }
    })
  })
}
