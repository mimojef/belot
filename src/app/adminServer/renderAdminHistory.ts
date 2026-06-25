import type { MonitoringHistoryResult, MonitoringPeaks, MonitoringPeakMoments, HistoryWindow } from './adminServerTypes.js'

function safeNum(v: number | null | undefined): number {
  if (v === null || v === undefined || !isFinite(v)) return 0
  return v
}

function peakFmt(v: number | null, decimals = 1): string {
  if (v === null || !isFinite(v)) return '—'
  return decimals === 0 ? v.toFixed(0) : v.toFixed(decimals)
}

function fmtMomentTime(ms: number, window: HistoryWindow): string {
  try {
    const d = new Date(ms)
    if (window === '1h') {
      return d.toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' })
    }
    return d.toLocaleString('bg-BG', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function fmtLastPoint(ms: number, window: HistoryWindow): string {
  try {
    const d = new Date(ms)
    if (window === '1h') {
      return d.toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' })
    }
    return d.toLocaleString('bg-BG', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return '—'
  }
}

const WINDOW_LABELS: Record<HistoryWindow, string> = {
  '1h': '1 час',
  '24h': '24 часа',
  '7d': '7 дни',
}

export function getWindowLabel(w: HistoryWindow): string {
  return WINDOW_LABELS[w]
}

export function renderPeakCards(peaks: MonitoringPeaks, esc: (s: string) => string): string {
  const card = (label: string, value: string, unit: string) => `
    <div style="background:#0d0d0d;border:1px solid rgba(212,165,32,0.18);border-radius:8px;padding:10px 12px;min-height:62px;box-sizing:border-box;display:flex;flex-direction:column;justify-content:space-between;">
      <div style="font-size:9px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.45);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(label)}</div>
      <div style="display:flex;align-items:baseline;gap:3px;min-width:0;">
        <span style="font-size:18px;font-weight:900;color:#e2c75a;white-space:nowrap;">${esc(value)}</span>
        ${unit ? `<span style="font-size:10px;color:rgba(255,255,255,0.38);white-space:nowrap;">${esc(unit)}</span>` : ''}
      </div>
    </div>
  `

  const fmtMb = (mb: number): { value: string; unit: string } => {
    if (mb >= 1024) return { value: (mb / 1024).toFixed(1), unit: 'GB' }
    return { value: mb.toFixed(0), unit: 'MB' }
  }

  const rss = fmtMb(safeNum(peaks.rssMb))
  const ram = fmtMb(safeNum(peaks.ramUsedMb))

  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:6px;">
      ${card('VPS CPU пик', peakFmt(peaks.serverCpu), '%')}
      ${card('Node CPU пик', peakFmt(peaks.nodeCpu), '%')}
      ${card('RAM пик', ram.value, ram.unit)}
      ${card('RAM% пик', peakFmt(peaks.ramPercent), '%')}
      ${card('RSS пик', rss.value, rss.unit)}
      ${card('WS връзки пик', peakFmt(peaks.wsConns, 0), '')}
      ${card('Играчи пик', peakFmt(peaks.onlinePlayers, 0), '')}
      ${card('Стаи пик', peakFmt(peaks.activeRooms, 0), '')}
      ${card('Опашка пик', peakFmt(peaks.mmWaiters, 0), '')}
    </div>
  `
}

export function renderPeakMoments(
  pm: MonitoringPeakMoments,
  window: HistoryWindow,
  esc: (s: string) => string,
): string {
  const noMeasurement = 'Няма измерване за периода'

  const momentCard = (
    title: string,
    value: number,
    valueLabel: string,
    sampledAt: number | null,
  ) => {
    const timeHtml = sampledAt !== null
      ? `
        <div style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.46);line-height:1.35;">Последно достигнат:</div>
        <div style="font-size:12px;font-weight:800;color:rgba(255,255,255,0.68);line-height:1.35;white-space:normal;overflow-wrap:break-word;">${esc(fmtMomentTime(sampledAt, window))}</div>
      `
      : `<div style="font-size:12px;font-weight:800;color:rgba(255,255,255,0.68);line-height:1.35;white-space:normal;overflow-wrap:break-word;">${esc(noMeasurement)}</div>`
    return `
      <div style="background:#0d0d0d;border:1px solid rgba(96,165,250,0.2);border-radius:8px;padding:12px 14px;min-width:0;box-sizing:border-box;">
        <div style="font-size:11px;font-weight:800;letter-spacing:0.04em;text-transform:uppercase;color:rgba(255,255,255,0.48);line-height:1.35;min-height:30px;margin-bottom:8px;white-space:normal;overflow-wrap:break-word;">${esc(title)}</div>
        <div style="font-size:22px;font-weight:900;color:#ffffff;line-height:1.1;margin-bottom:8px;">${esc(String(value))} <span style="font-size:13px;font-weight:600;color:rgba(255,255,255,0.5);">${esc(valueLabel)}</span></div>
        <div style="display:grid;gap:2px;min-width:0;">
          ${timeHtml}
        </div>
      </div>
    `
  }

  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:8px;">
      ${momentCard('Най-много играчи онлайн', pm.onlinePlayers.value, 'играчи', pm.onlinePlayers.sampledAt)}
      ${momentCard('Най-много активни маси', pm.activeRooms.value, 'маси', pm.activeRooms.sampledAt)}
      ${momentCard('Най-много чакащи', pm.mmWaiters.value, 'играчи', pm.mmWaiters.sampledAt)}
      ${momentCard('Най-много WS връзки', pm.wsConns.value, 'връзки', pm.wsConns.sampledAt)}
    </div>
  `
}

export function renderHistoryInfoRow(
  result: MonitoringHistoryResult,
  window: HistoryWindow,
  esc: (s: string) => string,
): string {
  const pts = result.points
  const count = pts.length
  const lastPt = pts.length > 0 ? pts[pts.length - 1] : null
  const lastStr = lastPt !== null ? fmtLastPoint(lastPt.t, window) : '—'

  return `
    <div style="display:flex;flex-wrap:wrap;gap:4px 20px;font-size:11px;color:rgba(255,255,255,0.38);margin-top:10px;">
      <span>Точки за периода: <strong style="color:rgba(255,255,255,0.6);">${esc(String(count))}</strong></span>
      <span>Последен запис: <strong style="color:rgba(255,255,255,0.6);">${esc(lastStr)}</strong></span>
    </div>
  `
}
