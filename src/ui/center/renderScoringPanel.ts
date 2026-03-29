import type { ScoringViewState } from '../../core/state/getScoringViewState'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function renderValidityLabel(isPointTotalValid: boolean): string {
  return isPointTotalValid ? 'Да' : 'Не'
}

function renderCompletenessLabel(isComplete: boolean): string {
  return isComplete ? 'Да' : 'Не'
}

function resolveOutcomeAccent(viewState: ScoringViewState): {
  background: string
  border: string
  text: string
} {
  if (viewState.isInside) {
    return {
      background: 'rgba(127, 29, 29, 0.24)',
      border: 'rgba(248, 113, 113, 0.35)',
      text: '#fecaca',
    }
  }

  if (viewState.isMade) {
    return {
      background: 'rgba(20, 83, 45, 0.24)',
      border: 'rgba(74, 222, 128, 0.35)',
      text: '#bbf7d0',
    }
  }

  if (viewState.isTie) {
    return {
      background: 'rgba(120, 53, 15, 0.24)',
      border: 'rgba(251, 191, 36, 0.35)',
      text: '#fde68a',
    }
  }

  return {
    background: 'rgba(30, 41, 59, 0.82)',
    border: 'rgba(148, 163, 184, 0.16)',
    text: '#e2e8f0',
  }
}

export function renderScoringPanel(viewState: ScoringViewState): string {
  if (!viewState.isVisible) {
    return ''
  }

  const outcomeAccent = resolveOutcomeAccent(viewState)

  return `
    <section
      style="
        width: 100%;
        max-width: 760px;
        margin: 0 auto;
        background: rgba(15, 23, 42, 0.92);
        border: 1px solid rgba(148, 163, 184, 0.22);
        border-radius: 18px;
        padding: 20px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.22);
      "
    >
      <div
        style="
          display: flex;
          flex-direction: column;
          gap: 18px;
        "
      >
        <div>
          <div
            style="
              font-size: 28px;
              font-weight: 800;
              color: #f8fafc;
              margin-bottom: 6px;
            "
          >
            Край на рунда
          </div>

          <div
            style="
              font-size: 14px;
              color: #94a3b8;
            "
          >
            Сурови точки + официално записване
          </div>
        </div>

        ${
          viewState.hasOutcome
            ? `
              <div
                style="
                  background: ${outcomeAccent.background};
                  border: 1px solid ${outcomeAccent.border};
                  border-radius: 14px;
                  padding: 16px;
                "
              >
                <div
                  style="
                    font-size: 22px;
                    font-weight: 800;
                    color: ${outcomeAccent.text};
                    margin-bottom: 12px;
                  "
                >
                  ${escapeHtml(viewState.outcomeLabel)}
                </div>

                <div
                  style="
                    display: grid;
                    grid-template-columns: repeat(3, minmax(0, 1fr));
                    gap: 12px;
                  "
                >
                  <div>
                    <div
                      style="
                        font-size: 12px;
                        color: #94a3b8;
                        margin-bottom: 4px;
                      "
                    >
                      Обявил отбор
                    </div>
                    <div
                      style="
                        font-size: 16px;
                        font-weight: 700;
                        color: #f8fafc;
                      "
                    >
                      ${escapeHtml(viewState.bidderTeamLabel)}
                    </div>
                  </div>

                  <div>
                    <div
                      style="
                        font-size: 12px;
                        color: #94a3b8;
                        margin-bottom: 4px;
                      "
                    >
                      Защита
                    </div>
                    <div
                      style="
                        font-size: 16px;
                        font-weight: 700;
                        color: #f8fafc;
                      "
                    >
                      ${escapeHtml(viewState.defenderTeamLabel)}
                    </div>
                  </div>

                  <div>
                    <div
                      style="
                        font-size: 12px;
                        color: #94a3b8;
                        margin-bottom: 4px;
                      "
                    >
                      Победител в рунда
                    </div>
                    <div
                      style="
                        font-size: 16px;
                        font-weight: 700;
                        color: #f8fafc;
                      "
                    >
                      ${escapeHtml(viewState.winningTeamLabel)}
                    </div>
                  </div>
                </div>

                <div
                  style="
                    margin-top: 14px;
                    display: grid;
                    grid-template-columns: repeat(2, minmax(0, 1fr));
                    gap: 12px;
                  "
                >
                  <div
                    style="
                      background: rgba(15, 23, 42, 0.35);
                      border: 1px solid rgba(148, 163, 184, 0.16);
                      border-radius: 12px;
                      padding: 12px;
                    "
                  >
                    <div
                      style="
                        font-size: 12px;
                        color: #94a3b8;
                        margin-bottom: 4px;
                      "
                    >
                      Точки на обявилия
                    </div>
                    <div
                      style="
                        font-size: 22px;
                        font-weight: 800;
                        color: #f8fafc;
                      "
                    >
                      ${viewState.bidderPoints}
                    </div>
                  </div>

                  <div
                    style="
                      background: rgba(15, 23, 42, 0.35);
                      border: 1px solid rgba(148, 163, 184, 0.16);
                      border-radius: 12px;
                      padding: 12px;
                    "
                  >
                    <div
                      style="
                        font-size: 12px;
                        color: #94a3b8;
                        margin-bottom: 4px;
                      "
                    >
                      Точки на защитата
                    </div>
                    <div
                      style="
                        font-size: 22px;
                        font-weight: 800;
                        color: #f8fafc;
                      "
                    >
                      ${viewState.defenderPoints}
                    </div>
                  </div>
                </div>
              </div>
            `
            : ''
        }

        <div
          style="
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 12px;
          "
        >
          <div
            style="
              background: rgba(30, 41, 59, 0.9);
              border: 1px solid rgba(148, 163, 184, 0.16);
              border-radius: 14px;
              padding: 14px;
            "
          >
            <div
              style="
                font-size: 13px;
                color: #94a3b8;
                margin-bottom: 6px;
              "
            >
              Обява
            </div>
            <div
              style="
                font-size: 20px;
                font-weight: 700;
                color: #f8fafc;
              "
            >
              ${escapeHtml(viewState.winningBidLabel)}
            </div>
          </div>

          <div
            style="
              background: rgba(30, 41, 59, 0.9);
              border: 1px solid rgba(148, 163, 184, 0.16);
              border-radius: 14px;
              padding: 14px;
            "
          >
            <div
              style="
                font-size: 13px;
                color: #94a3b8;
                margin-bottom: 6px;
              "
            >
              Последна взятка
            </div>
            <div
              style="
                font-size: 20px;
                font-weight: 700;
                color: #f8fafc;
              "
            >
              ${escapeHtml(viewState.lastTrickWinnerLabel)}
            </div>
          </div>
        </div>

        <div
          style="
            background: rgba(30, 41, 59, 0.72);
            border: 1px solid rgba(148, 163, 184, 0.16);
            border-radius: 14px;
            padding: 16px;
          "
        >
          <div
            style="
              font-size: 16px;
              font-weight: 800;
              color: #f8fafc;
              margin-bottom: 12px;
            "
          >
            Сурови точки от взятките
          </div>

          <div
            style="
              display: grid;
              grid-template-columns: repeat(2, minmax(0, 1fr));
              gap: 12px;
            "
          >
            <div
              style="
                background: rgba(15, 23, 42, 0.42);
                border: 1px solid rgba(59, 130, 246, 0.22);
                border-radius: 14px;
                padding: 16px;
              "
            >
              <div
                style="
                  font-size: 14px;
                  font-weight: 700;
                  color: #bfdbfe;
                  margin-bottom: 12px;
                "
              >
                Отбор A (Долу + Горе)
              </div>

              <div
                style="
                  display: flex;
                  justify-content: space-between;
                  align-items: center;
                  margin-bottom: 8px;
                  color: #e2e8f0;
                  font-size: 15px;
                "
              >
                <span>Точки</span>
                <strong style="font-size: 22px; color: #f8fafc;">
                  ${viewState.teamARawPoints}
                </strong>
              </div>

              <div
                style="
                  display: flex;
                  justify-content: space-between;
                  align-items: center;
                  color: #cbd5e1;
                  font-size: 14px;
                "
              >
                <span>Спечелени взятки</span>
                <strong>${viewState.teamATricksWon}</strong>
              </div>
            </div>

            <div
              style="
                background: rgba(15, 23, 42, 0.42);
                border: 1px solid rgba(16, 185, 129, 0.22);
                border-radius: 14px;
                padding: 16px;
              "
            >
              <div
                style="
                  font-size: 14px;
                  font-weight: 700;
                  color: #bbf7d0;
                  margin-bottom: 12px;
                "
              >
                Отбор B (Ляво + Дясно)
              </div>

              <div
                style="
                  display: flex;
                  justify-content: space-between;
                  align-items: center;
                  margin-bottom: 8px;
                  color: #e2e8f0;
                  font-size: 15px;
                "
              >
                <span>Точки</span>
                <strong style="font-size: 22px; color: #f8fafc;">
                  ${viewState.teamBRawPoints}
                </strong>
              </div>

              <div
                style="
                  display: flex;
                  justify-content: space-between;
                  align-items: center;
                  color: #cbd5e1;
                  font-size: 14px;
                "
              >
                <span>Спечелени взятки</span>
                <strong>${viewState.teamBTricksWon}</strong>
              </div>
            </div>
          </div>
        </div>

        <div
          style="
            background: rgba(30, 41, 59, 0.72);
            border: 1px solid rgba(148, 163, 184, 0.16);
            border-radius: 14px;
            padding: 16px;
          "
        >
          <div
            style="
              font-size: 16px;
              font-weight: 800;
              color: #f8fafc;
              margin-bottom: 12px;
            "
          >
            Официално записване
          </div>

          <div
            style="
              display: grid;
              grid-template-columns: repeat(2, minmax(0, 1fr));
              gap: 12px;
              margin-bottom: 12px;
            "
          >
            <div
              style="
                background: rgba(15, 23, 42, 0.42);
                border: 1px solid rgba(59, 130, 246, 0.22);
                border-radius: 14px;
                padding: 16px;
              "
            >
              <div
                style="
                  font-size: 14px;
                  font-weight: 700;
                  color: #bfdbfe;
                  margin-bottom: 12px;
                "
              >
                Записан рунд — Отбор A
              </div>
              <div
                style="
                  font-size: 26px;
                  font-weight: 800;
                  color: #f8fafc;
                "
              >
                ${viewState.officialRoundTeamA}
              </div>
            </div>

            <div
              style="
                background: rgba(15, 23, 42, 0.42);
                border: 1px solid rgba(16, 185, 129, 0.22);
                border-radius: 14px;
                padding: 16px;
              "
            >
              <div
                style="
                  font-size: 14px;
                  font-weight: 700;
                  color: #bbf7d0;
                  margin-bottom: 12px;
                "
              >
                Записан рунд — Отбор B
              </div>
              <div
                style="
                  font-size: 26px;
                  font-weight: 800;
                  color: #f8fafc;
                "
              >
                ${viewState.officialRoundTeamB}
              </div>
            </div>
          </div>

          <div
            style="
              display: grid;
              grid-template-columns: repeat(2, minmax(0, 1fr));
              gap: 12px;
              margin-bottom: 12px;
            "
          >
            <div
              style="
                background: rgba(15, 23, 42, 0.42);
                border: 1px solid rgba(59, 130, 246, 0.22);
                border-radius: 14px;
                padding: 16px;
              "
            >
              <div
                style="
                  font-size: 14px;
                  font-weight: 700;
                  color: #bfdbfe;
                  margin-bottom: 12px;
                "
              >
                Общ резултат — Отбор A
              </div>
              <div
                style="
                  font-size: 26px;
                  font-weight: 800;
                  color: #f8fafc;
                "
              >
                ${viewState.matchTotalTeamA}
              </div>
            </div>

            <div
              style="
                background: rgba(15, 23, 42, 0.42);
                border: 1px solid rgba(16, 185, 129, 0.22);
                border-radius: 14px;
                padding: 16px;
              "
            >
              <div
                style="
                  font-size: 14px;
                  font-weight: 700;
                  color: #bbf7d0;
                  margin-bottom: 12px;
                "
              >
                Общ резултат — Отбор B
              </div>
              <div
                style="
                  font-size: 26px;
                  font-weight: 800;
                  color: #f8fafc;
                "
              >
                ${viewState.matchTotalTeamB}
              </div>
            </div>
          </div>

          <div
            style="
              display: grid;
              grid-template-columns: repeat(2, minmax(0, 1fr));
              gap: 12px;
            "
          >
            <div
              style="
                background: rgba(15, 23, 42, 0.42);
                border: 1px solid rgba(59, 130, 246, 0.22);
                border-radius: 14px;
                padding: 16px;
              "
            >
              <div
                style="
                  font-size: 14px;
                  font-weight: 700;
                  color: #bfdbfe;
                  margin-bottom: 12px;
                "
              >
                Висящи точки — Отбор A
              </div>
              <div
                style="
                  font-size: 26px;
                  font-weight: 800;
                  color: #f8fafc;
                "
              >
                ${viewState.carryOverTeamA}
              </div>
            </div>

            <div
              style="
                background: rgba(15, 23, 42, 0.42);
                border: 1px solid rgba(16, 185, 129, 0.22);
                border-radius: 14px;
                padding: 16px;
              "
            >
              <div
                style="
                  font-size: 14px;
                  font-weight: 700;
                  color: #bbf7d0;
                  margin-bottom: 12px;
                "
              >
                Висящи точки — Отбор B
              </div>
              <div
                style="
                  font-size: 26px;
                  font-weight: 800;
                  color: #f8fafc;
                "
              >
                ${viewState.carryOverTeamB}
              </div>
            </div>
          </div>
        </div>

        <div
          style="
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 12px;
          "
        >
          <div
            style="
              background: rgba(30, 41, 59, 0.82);
              border: 1px solid rgba(148, 163, 184, 0.16);
              border-radius: 12px;
              padding: 12px;
            "
          >
            <div style="font-size: 12px; color: #94a3b8; margin-bottom: 4px;">
              Очакван сбор
            </div>
            <div style="font-size: 18px; font-weight: 700; color: #f8fafc;">
              ${viewState.expectedTotalPoints}
            </div>
          </div>

          <div
            style="
              background: rgba(30, 41, 59, 0.82);
              border: 1px solid rgba(148, 163, 184, 0.16);
              border-radius: 12px;
              padding: 12px;
            "
          >
            <div style="font-size: 12px; color: #94a3b8; margin-bottom: 4px;">
              Реален сбор
            </div>
            <div style="font-size: 18px; font-weight: 700; color: #f8fafc;">
              ${viewState.actualTotalPoints}
            </div>
          </div>

          <div
            style="
              background: rgba(30, 41, 59, 0.82);
              border: 1px solid rgba(148, 163, 184, 0.16);
              border-radius: 12px;
              padding: 12px;
            "
          >
            <div style="font-size: 12px; color: #94a3b8; margin-bottom: 4px;">
              8 взятки
            </div>
            <div style="font-size: 18px; font-weight: 700; color: #f8fafc;">
              ${renderCompletenessLabel(viewState.isComplete)}
            </div>
          </div>

          <div
            style="
              background: rgba(30, 41, 59, 0.82);
              border: 1px solid rgba(148, 163, 184, 0.16);
              border-radius: 12px;
              padding: 12px;
            "
          >
            <div style="font-size: 12px; color: #94a3b8; margin-bottom: 4px;">
              Валиден сбор
            </div>
            <div style="font-size: 18px; font-weight: 700; color: #f8fafc;">
              ${renderValidityLabel(viewState.isPointTotalValid)}
            </div>
          </div>
        </div>

        ${
          !viewState.hasBaseRoundScore
            ? `
              <div
                style="
                  background: rgba(127, 29, 29, 0.24);
                  border: 1px solid rgba(248, 113, 113, 0.35);
                  border-radius: 12px;
                  padding: 14px;
                  color: #fecaca;
                  font-size: 14px;
                "
              >
                Няма наличен scoring result за този рунд.
              </div>
            `
            : ''
        }
      </div>
    </section>
  `
}