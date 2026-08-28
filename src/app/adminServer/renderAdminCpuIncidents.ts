import type { CpuIncidentSummary, CpuIncidentDetail, CpuIncidentDetectionType } from './adminServerTypes.js'

function fmtPercent(v: number | null): string {
  if (v === null || !isFinite(v)) return '—'
  return `${v.toFixed(1)}%`
}

function fmtDuration(ms: number | null): string {
  if (ms === null || !isFinite(ms) || ms < 0) return '—'
  const totalSec = Math.round(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min === 0) return `${sec} сек.`
  return `${min}м ${sec}с`
}

function fmtDateTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString('bg-BG', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return '—'
  }
}

function fmtRatePerMin(v: number): string {
  if (!isFinite(v) || v <= 0) return '0/мин'
  if (v < 10) return `${v.toFixed(1)}/мин`
  return `${Math.round(v)}/мин`
}

const DETECTION_TYPE_LABELS: Record<CpuIncidentDetectionType, string> = {
  extreme_spike: 'Кратък пик',
  sustained_high: 'Продължителен',
  sustained_with_spike: 'Продължителен + пик',
}

const DETECTION_TYPE_COLORS: Record<CpuIncidentDetectionType, string> = {
  extreme_spike: '#f59e0b',
  sustained_high: '#ef4444',
  sustained_with_spike: '#ef4444',
}

export function renderCpuIncidentsEmptyState(): string {
  return `<p style="color:rgba(255,255,255,0.35);font-size:12px;font-style:italic;margin:0;">Няма регистрирани CPU инциденти.</p>`
}

export type CpuIncidentDetailLoadState = {
  loading: boolean
  detail: CpuIncidentDetail | null
  errorText: string | null
}

export function renderCpuIncidentsList(
  incidents: CpuIncidentSummary[],
  expandedIncidentId: number | null,
  detailLoadState: CpuIncidentDetailLoadState | null,
  esc: (s: string) => string,
): string {
  if (incidents.length === 0) {
    return renderCpuIncidentsEmptyState()
  }

  const cards = incidents.map((incident) => {
    const typeColor = DETECTION_TYPE_COLORS[incident.detectionType]
    const typeLabel = DETECTION_TYPE_LABELS[incident.detectionType]
    const isExpanded = incident.id === expandedIncidentId

    let detailHtml = ''
    if (isExpanded && detailLoadState !== null) {
      if (detailLoadState.loading) {
        detailHtml = `<div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08);font-size:12px;color:#d4a520;font-weight:700;">Зареждане на времева линия...</div>`
      } else if (detailLoadState.errorText !== null) {
        detailHtml = `<div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08);font-size:12px;color:#fca5a5;">${esc(detailLoadState.errorText)}</div>`
      } else if (detailLoadState.detail !== null) {
        detailHtml = renderCpuIncidentDetailTimeline(detailLoadState.detail, esc)
      }
    }

    return `
      <div style="background:#0d0d0d;border:1px solid ${isExpanded ? 'rgba(212,165,32,0.5)' : 'rgba(212,165,32,0.2)'};border-radius:10px;padding:14px 16px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;margin-bottom:8px;">
          <span style="font-size:12px;color:rgba(255,255,255,0.5);font-weight:700;">${esc(fmtDateTime(incident.startedAtMs))}</span>
          <span style="display:inline-flex;align-items:center;gap:6px;">
            <span style="font-size:10px;font-weight:800;letter-spacing:0.04em;text-transform:uppercase;color:${typeColor};background:${typeColor}22;border-radius:20px;padding:2px 10px;">${esc(typeLabel)}</span>
            <span style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.45);">${esc(fmtDuration(incident.durationMs))}</span>
          </span>
        </div>

        <div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:10px;">
          <div>
            <span style="font-size:24px;font-weight:900;color:#e2c75a;">${esc(fmtPercent(incident.processCpuMax))}</span>
            <span style="font-size:11px;color:rgba(255,255,255,0.4);margin-left:4px;">макс.</span>
          </div>
          <div style="font-size:12px;color:rgba(255,255,255,0.55);">Средно: <strong style="color:rgba(255,255,255,0.75);">${esc(fmtPercent(incident.processCpuAvg))}</strong></div>
          ${incident.processCpuP95 !== null ? `<div style="font-size:12px;color:rgba(255,255,255,0.55);">P95: <strong style="color:rgba(255,255,255,0.75);">${esc(fmtPercent(incident.processCpuP95))}</strong></div>` : ''}
        </div>

        ${incident.gameWorkerCpuMax !== null || incident.nonGameWorkerProcessCpuMax !== null || incident.eventLoopUtilizationMax !== null ? `
          <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:rgba(255,255,255,0.45);margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,0.08);">
            ${incident.gameWorkerCpuMax !== null ? `<span>CPU на игровите workers: <strong style="color:rgba(255,255,255,0.65);">${esc(fmtPercent(incident.gameWorkerCpuMax))}</strong></span>` : ''}
            ${incident.nonGameWorkerProcessCpuMax !== null ? `<span>CPU извън игровите workers: <strong style="color:rgba(255,255,255,0.65);">${esc(fmtPercent(incident.nonGameWorkerProcessCpuMax))}</strong></span>` : ''}
            ${incident.eventLoopUtilizationMax !== null ? `<span>Event loop utilization: <strong style="color:rgba(255,255,255,0.65);">${esc((incident.eventLoopUtilizationMax * 100).toFixed(1))}%</strong></span>` : ''}
            ${incident.eventLoopDelayP99MaxMs !== null ? `<span>Event loop P99 delay: <strong style="color:rgba(255,255,255,0.65);">${esc(incident.eventLoopDelayP99MaxMs.toFixed(0))} мс</strong></span>` : ''}
          </div>
        ` : ''}

        <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:rgba(255,255,255,0.45);margin-bottom:10px;">
          ${incident.onlinePlayersAvg !== null ? `<span>Онлайн: <strong style="color:rgba(255,255,255,0.65);">${esc(Math.round(incident.onlinePlayersAvg).toString())}</strong></span>` : ''}
          ${incident.activeMatchesAvg !== null ? `<span>Активни маси: <strong style="color:rgba(255,255,255,0.65);">${esc(Math.round(incident.activeMatchesAvg).toString())}</strong></span>` : ''}
          ${incident.wsConnectionsAvg !== null ? `<span>WS връзки: <strong style="color:rgba(255,255,255,0.65);">${esc(Math.round(incident.wsConnectionsAvg).toString())}</strong></span>` : ''}
        </div>

        <div style="display:flex;gap:10px 16px;flex-wrap:wrap;font-size:11px;color:rgba(255,255,255,0.4);margin-bottom:12px;">
          <span>Gameplay: <strong style="color:rgba(255,255,255,0.6);">${esc(fmtRatePerMin(incident.activityRates.gameplayPerMin))}</strong></span>
          <span>Lobby chat: <strong style="color:rgba(255,255,255,0.6);">${esc(fmtRatePerMin(incident.activityRates.lobbyChatPerMin))}</strong></span>
          <span>Direct chat: <strong style="color:rgba(255,255,255,0.6);">${esc(fmtRatePerMin(incident.activityRates.directChatPerMin))}</strong></span>
          <span>Pika Team chat: <strong style="color:rgba(255,255,255,0.6);">${esc(fmtRatePerMin(incident.activityRates.pikaTeamChatPerMin))}</strong></span>
          <span>Официален support: <strong style="color:rgba(255,255,255,0.6);">${esc(fmtRatePerMin(incident.activityRates.officialSupportPerMin))}</strong></span>
          <span>Частни стаи (чат): <strong style="color:rgba(255,255,255,0.6);">${esc(fmtRatePerMin(incident.activityRates.privateRoomChatPerMin))}</strong></span>
          <span>Topics: <strong style="color:rgba(255,255,255,0.6);">${esc(fmtRatePerMin(incident.activityRates.topicsPerMin))}</strong></span>
          <span>Lafche: <strong style="color:rgba(255,255,255,0.6);">${esc(fmtRatePerMin(incident.activityRates.lafchePerMin))}</strong></span>
          <span>HTTP: <strong style="color:rgba(255,255,255,0.6);">${esc(fmtRatePerMin(incident.activityRates.httpPerMin))}</strong></span>
        </div>

        <button type="button" data-cpu-incident-detail-toggle="${incident.id}" style="height:28px;padding:0 12px;border:1px solid rgba(212,165,32,0.4);border-radius:6px;background:transparent;color:#d4a520;font-size:11px;font-weight:800;cursor:pointer;">${isExpanded ? 'Скрий детайли' : 'Детайли'}</button>

        ${detailHtml}
      </div>
    `
  })

  return cards.join('')
}

function sparklinePoints(values: Array<number | null>, width: number, height: number): string {
  const validValues = values.filter((v): v is number => v !== null)
  if (validValues.length === 0) return ''
  const max = Math.max(...validValues, 1)
  const step = values.length > 1 ? width / (values.length - 1) : width
  const points: string[] = []
  values.forEach((v, i) => {
    if (v === null) return
    const x = i * step
    const y = height - (v / max) * height
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`)
  })
  return points.join(' ')
}

export function renderCpuIncidentDetailTimeline(detail: CpuIncidentDetail, esc: (s: string) => string): string {
  const { timeline } = detail
  if (timeline.length === 0) {
    return `<p style="color:rgba(255,255,255,0.35);font-size:12px;font-style:italic;margin:8px 0 0;">Няма запазена времева линия.</p>`
  }

  const width = 560
  const height = 90
  const cpuValues = timeline.map((s) => s.processCpu)
  const points = sparklinePoints(cpuValues, width, height)

  const tableRows = timeline.map((s) => `
    <tr>
      <td style="padding:4px 8px;font-size:11px;color:rgba(255,255,255,0.5);white-space:nowrap;">${esc(new Date(s.t).toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit', second: '2-digit' }))}</td>
      <td style="padding:4px 8px;font-size:11px;color:rgba(255,255,255,0.5);white-space:nowrap;">${s.sampleResolutionMs}мс</td>
      <td style="padding:4px 8px;font-size:11px;color:#e2c75a;font-weight:700;white-space:nowrap;">${esc(fmtPercent(s.processCpu))}</td>
      <td style="padding:4px 8px;font-size:11px;color:rgba(255,255,255,0.5);white-space:nowrap;">${esc(fmtPercent(s.gameWorkerCpu))}</td>
      <td style="padding:4px 8px;font-size:11px;color:rgba(255,255,255,0.5);white-space:nowrap;">${s.eventLoopDelayP99Ms !== null ? esc(s.eventLoopDelayP99Ms.toFixed(0)) + ' мс' : '—'}</td>
      <td style="padding:4px 8px;font-size:11px;color:rgba(255,255,255,0.5);white-space:nowrap;">${s.onlinePlayers ?? '—'}</td>
      <td style="padding:4px 8px;font-size:11px;color:rgba(255,255,255,0.5);white-space:nowrap;">${s.activeMatches ?? '—'}</td>
    </tr>
  `).join('')

  return `
    <div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08);">
      <div style="font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.4);margin-bottom:6px;">CPU на Node процеса — времева линия</div>
      <svg viewBox="0 0 ${width} ${height}" style="width:100%;max-width:${width}px;height:${height}px;display:block;margin-bottom:10px;">
        <polyline points="${points}" fill="none" stroke="#e2c75a" stroke-width="2" />
      </svg>
      <div style="overflow-x:auto;max-height:260px;overflow-y:auto;border:1px solid rgba(255,255,255,0.08);border-radius:6px;">
        <table style="width:100%;border-collapse:collapse;">
          <thead>
            <tr style="position:sticky;top:0;background:#141414;">
              <th style="padding:4px 8px;font-size:10px;text-align:left;color:rgba(255,255,255,0.4);text-transform:uppercase;">Час</th>
              <th style="padding:4px 8px;font-size:10px;text-align:left;color:rgba(255,255,255,0.4);text-transform:uppercase;">Резолюция</th>
              <th style="padding:4px 8px;font-size:10px;text-align:left;color:rgba(255,255,255,0.4);text-transform:uppercase;">CPU на Node процеса</th>
              <th style="padding:4px 8px;font-size:10px;text-align:left;color:rgba(255,255,255,0.4);text-transform:uppercase;">CPU на игровите workers</th>
              <th style="padding:4px 8px;font-size:10px;text-align:left;color:rgba(255,255,255,0.4);text-transform:uppercase;">Event loop P99 delay</th>
              <th style="padding:4px 8px;font-size:10px;text-align:left;color:rgba(255,255,255,0.4);text-transform:uppercase;">Онлайн</th>
              <th style="padding:4px 8px;font-size:10px;text-align:left;color:rgba(255,255,255,0.4);text-transform:uppercase;">Маси</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </div>
  `
}
