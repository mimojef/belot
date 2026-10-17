// Свара — реален мултиплейър лоби/маса (Етап 2Б.3.7.2/2Б.3.7.3). Чист view
// слой, mirror на createLudoLobbyController.ts: само рендира каквото
// сървърът е изпратил и вика options.onXxx callback-ите при потребителско
// действие. Няма собствена игрова логика, няма локално генериране на
// карти/банки/ред на ход — всичко идва от SvaraPublicTable/
// SvaraMatchSnapshotMessage. Визуалното оформление на активната маса (места,
// карти, дилър, countdown пръстен, fullscreen) е в table/renderSvaraActiveTable.ts.

import type {
  SvaraMatchSnapshotMessage,
  SvaraMatchTimingMessage,
  SvaraPublicTable,
  SvaraSeatStatus,
} from '../../network/createGameServerClient'
import { sharedServerClock } from '../../network/serverClock'
import { renderSvaraActiveTable } from './table/renderSvaraActiveTable'

type Options = {
  root: HTMLElement
  localProfileId: string
  onRefresh: () => void
  onCreate: (capacity: 2 | 3 | 4, entryFee: number) => void
  onJoin: (matchId: string) => void
  onLeave: (matchId: string) => void
  onStart: (matchId: string) => void
  onRequestTableState: (matchId: string) => void
}

const esc = (value: unknown) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!)

const STATUS_LABEL: Record<SvaraSeatStatus, string> = {
  active: 'активен',
  absent: 'отсъства',
  exited: 'напуснал',
  eliminated: 'отпаднал',
}

export function createSvaraLobbyController(options: Options) {
  let tables: SvaraPublicTable[] = []
  let myTable: SvaraPublicTable | null = null
  let snapshot: SvaraMatchSnapshotMessage | null = null
  let timing: SvaraMatchTimingMessage | null = null
  let createOpen = false
  let message = ''
  let leavePending = false
  let joinPendingMatchId: string | null = null

  const button = 'border:1px solid rgba(212,165,32,.55);border-radius:7px;background:#0b0b0b;color:#f4c95b;min-height:40px;padding:0 16px;font-weight:800;cursor:pointer;'
  const panel = 'background:#090909;border:1px solid rgba(212,165,32,.35);border-radius:8px;padding:16px;'
  const createButtonStyle = 'box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:8px;height:42px;padding:0 20px;border:1px solid rgba(244,201,91,.5);border-radius:10px;background:linear-gradient(135deg,#f6d27a 0%,#d4a520 55%,#c98f13 100%);color:#1a1200;font-size:14px;font-weight:800;cursor:pointer;white-space:nowrap;'

  function render(): void {
    const isActiveTable = myTable !== null && myTable.phase !== 'lobby'
    ensureTick()
    const body = myTable ? (myTable.phase === 'lobby' ? renderWaiting(myTable) : renderActiveTable(myTable)) : renderTableList()
    // Активната маса получава по-широк контейнер (нужно за landscape/desktop
    // без прекомерно разтягане, виж заданието §11/§12) — списъкът/чакащата
    // маса остават в по-тесния 860px panel layout от 2Б.3.7.2.
    options.root.innerHTML = `<section data-svara-lobby="1" style="background:#030303;color:#fff;font-family:Arial,sans-serif;box-sizing:border-box;padding:clamp(10px,2.4vw,32px);overflow-x:hidden;">
      <div style="max-width:${isActiveTable ? '1100px' : '860px'};margin:0 auto;">
        ${myTable ? '' : `<div style="display:flex;justify-content:flex-end;margin-bottom:16px;"><button data-svara-create-open="1" style="${createButtonStyle}">+ Нова маса</button></div>`}
        ${message ? `<div style="margin-bottom:12px;color:#f4c95b;font-weight:700;">${esc(message)}</div>` : ''}
        ${body}
      </div>
      ${createOpen ? renderCreateModal() : ''}
    </section>`
    wire()
  }

  function renderEmptyState(text: string): string {
    return `<div style="${panel}text-align:center;color:rgba(255,255,255,.6);">${esc(text)}</div>`
  }

  function tableCardHtml(table: SvaraPublicTable): string {
    const joining = joinPendingMatchId === table.matchId
    const full = table.players.length >= table.capacity
    const disabled = joining || full
    const actionLabel = joining ? 'Влизане…' : full ? 'Пълна' : 'Влез'
    return `<article style="${panel}">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;">
        <div>
          <strong>Маса ${esc(table.matchId.slice(0, 8))}</strong>
          <div style="margin-top:6px;color:rgba(255,255,255,.62);font-size:13px;">${table.players.length}/${table.capacity} · Вход ${table.entryFee} жълтици (${table.entryPercent}%) · ${table.startMode === 'manual' ? 'Ръчен старт' : 'При запълване'}</div>
        </div>
        <button data-svara-table-join="${esc(table.matchId)}" ${disabled ? 'disabled' : ''} style="${button}${disabled ? 'opacity:.55;cursor:not-allowed;' : ''}">${actionLabel}</button>
      </div>
    </article>`
  }

  function renderTableList(): string {
    return tables.length === 0
      ? renderEmptyState('В момента няма чакащи маси за Свара.')
      : `<div style="display:grid;gap:10px;">${tables.map(tableCardHtml).join('')}</div>`
  }

  function seatSlotHtml(table: SvaraPublicTable, index: number): string {
    const player = table.players[index]
    if (!player) return `<div style="box-sizing:border-box;min-height:50px;border-radius:9px;border:1px dashed rgba(255,255,255,.14);background:rgba(255,255,255,.03);color:rgba(255,255,255,.35);font-size:12px;display:flex;align-items:center;justify-content:center;">Свободно място</div>`
    const isCreator = player.playerId === table.creatorId
    return `<div style="box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;gap:6px;border:1px solid rgba(255,255,255,.12);border-radius:9px;padding:8px 10px;">
      <span style="font-weight:700;font-size:12px;overflow:hidden;text-overflow:ellipsis;">${esc(player.playerId.slice(0, 8))}${isCreator ? ' ★' : ''}</span>
      <span style="font-size:11px;color:rgba(255,255,255,.55);">${STATUS_LABEL[player.status]}</span>
    </div>`
  }

  function renderWaiting(table: SvaraPublicTable): string {
    const isHost = table.creatorId === options.localProfileId
    const canManualStart = table.startMode === 'manual' && table.players.length === table.capacity
    const slotsHtml = Array.from({ length: table.capacity }, (_, index) => seatSlotHtml(table, index)).join('')
    return `<div style="${panel}">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px;">
        <div><strong>Чакаща маса</strong><div style="color:rgba(255,255,255,.62);margin-top:5px;font-size:13px;">${table.players.length}/${table.capacity} · Вход ${table.entryFee} жълтици · ${table.startMode === 'manual' ? 'Ръчен старт' : 'При запълване'}</div></div>
        <button data-svara-table-leave="1" ${leavePending ? 'disabled' : ''} style="${button}${leavePending ? 'opacity:.55;cursor:wait;' : ''}">${leavePending ? 'Напускане…' : 'Напусни'}</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;">${slotsHtml}</div>
      ${table.startMode === 'manual' && isHost ? `<button data-svara-table-start="1" ${canManualStart ? '' : 'disabled'} style="${button}width:100%;margin-top:16px;background:${canManualStart ? '#d4a520' : '#242424'};color:${canManualStart ? '#050505' : '#777'};cursor:${canManualStart ? 'pointer' : 'not-allowed'};">Старт</button>` : ''}
    </div>`
  }

  // Етап 2Б.3.7.3 — поддържа ли браузърът Fullscreen API изобщо (напр. iOS
  // Safari не поддържа requestFullscreen за произволен елемент) и дали
  // МАСАТА в момента е в цял екран; само за видимостта на бутона/иконата —
  // реалното превключване е browser-native (requestFullscreen/exitFullscreen).
  const fullscreenSupported = typeof document !== 'undefined' && typeof document.documentElement.requestFullscreen === 'function'
  let isFullscreen = false
  let tableElementRef: HTMLElement | null = null
  // Периодичен re-render САМО докато чака активен сървърен срок (ход/избор и
  // т.н.) — пръстенът/текстът винаги се извеждат наново от deadlineAt +
  // sharedServerClock на всеки тик, никога от локален "старт" timestamp,
  // затова rerender/reconnect никога не го рестартира (виж svaraCountdown.ts).
  let tickTimer: ReturnType<typeof setInterval> | null = null
  function ensureTick(): void {
    const hasActiveDeadline = (timing?.deadlines.length ?? 0) > 0
    if (hasActiveDeadline && tickTimer === null) {
      tickTimer = setInterval(() => render(), 250)
    } else if (!hasActiveDeadline && tickTimer !== null) {
      clearInterval(tickTimer)
      tickTimer = null
    }
  }

  function renderActiveTable(table: SvaraPublicTable): string {
    return renderSvaraActiveTable({
      table,
      snapshot,
      timing,
      localProfileId: options.localProfileId,
      serverNow: sharedServerClock.getServerNow(),
      isFullscreen,
      fullscreenSupported,
      leavePending,
    })
  }

  function renderCreateModal(): string {
    return `<div data-svara-create-backdrop="1" style="position:fixed;inset:0;background:rgba(0,0,0,.78);display:grid;place-items:center;padding:14px;z-index:2;"><form data-svara-create-form="1" style="${panel}width:min(100%,380px);max-width:100%;box-sizing:border-box;">
      <h2 style="margin:0 0 18px;">Нова маса</h2>
      <label style="display:grid;gap:7px;margin-bottom:14px;">Брой играчи<select name="capacity" style="width:100%;box-sizing:border-box;min-height:40px;background:#111;color:#fff;border:1px solid #555;border-radius:7px;padding:0 10px;"><option value="2">2</option><option value="3">3</option><option value="4">4</option></select></label>
      <label style="display:grid;gap:7px;margin-bottom:18px;">Такса за участие (жълтици)<input name="entryFee" type="number" min="10" step="10" value="1000" style="width:100%;box-sizing:border-box;min-height:40px;background:#111;color:#fff;border:1px solid #555;border-radius:7px;padding:0 10px;" /></label>
      <div style="display:flex;justify-content:flex-end;gap:8px;"><button type="button" data-svara-create-close="1" style="${button}">Отказ</button><button type="submit" style="${button}background:#d4a520;color:#050505;">Създай</button></div>
    </form></div>`
  }

  function wire(): void {
    options.root.querySelector('[data-svara-create-open]')?.addEventListener('click', () => { createOpen = true; render() })
    options.root.querySelector('[data-svara-create-close]')?.addEventListener('click', () => { createOpen = false; render() })
    options.root.querySelectorAll<HTMLElement>('[data-svara-table-join]').forEach((el) => el.addEventListener('click', () => {
      const matchId = el.dataset.svaraTableJoin!
      if (joinPendingMatchId) return
      joinPendingMatchId = matchId
      message = ''
      render()
      options.onJoin(matchId)
    }))
    options.root.querySelector('[data-svara-table-leave]')?.addEventListener('click', () => requestExit())
    options.root.querySelector('[data-svara-table-start]')?.addEventListener('click', () => { if (myTable) options.onStart(myTable.matchId) })
    options.root.querySelector('[data-svara-table-refresh]')?.addEventListener('click', () => { if (myTable) options.onRequestTableState(myTable.matchId) })
    options.root.querySelector<HTMLFormElement>('[data-svara-create-form]')?.addEventListener('submit', (event) => {
      event.preventDefault()
      const data = new FormData(event.currentTarget as HTMLFormElement)
      createOpen = false
      options.onCreate(Number(data.get('capacity')) as 2 | 3 | 4, Number(data.get('entryFee')))
      render()
    })
    tableElementRef = options.root.querySelector<HTMLElement>('[data-svara-table="1"]')
    options.root.querySelector('[data-svara-fullscreen-toggle]')?.addEventListener('click', () => { void toggleFullscreen() })
  }

  // Етап 2Б.3.7.3, задание §13 — бутонът само отразява/предизвиква реалния
  // browser Fullscreen API; НЕ опитва принудително fullscreen при зареждане,
  // само вследствие на explicit click. Отказ/липса на поддръжка се поглъща
  // тихо (напр. браузър без permission) — бутонът просто остава в same state.
  async function toggleFullscreen(): Promise<void> {
    if (!fullscreenSupported || !tableElementRef) return
    try {
      if (document.fullscreenElement === tableElementRef) {
        await document.exitFullscreen()
      } else {
        await tableElementRef.requestFullscreen()
      }
    } catch {
      // Отказан/неподдържан достъп — без промяна, без throw нагоре.
    }
  }

  function handleFullscreenChange(): void {
    const next = document.fullscreenElement === tableElementRef && tableElementRef !== null
    if (next !== isFullscreen) {
      isFullscreen = next
      render()
    }
  }
  if (fullscreenSupported) document.addEventListener('fullscreenchange', handleFullscreenChange)

  function requestExit(): void {
    if (leavePending || myTable === null) return
    leavePending = true
    message = ''
    render()
    options.onLeave(myTable.matchId)
  }

  render()
  options.onRefresh()
  return {
    // Автоматично разпознаване на собствена маса от общия списък — покрива
    // restore след reconnect/page reload: сървърът праща svara_tables_list
    // (вкл. in-progress маси, виж publicTables() филтъра) при всяко mount,
    // а тук откриваме дали локалният профил вече е участник, без да чакаме
    // отделен join-success/table_updated event, който reload-ът е пропуснал.
    setTables(next: SvaraPublicTable[]) {
      tables = next
      if (myTable === null) {
        const owned = next.find((table) => table.players.some((p) => p.playerId === options.localProfileId && p.status !== 'exited'))
        if (owned) {
          myTable = owned
          leavePending = false
          joinPendingMatchId = null
          if (owned.phase !== 'lobby') options.onRequestTableState(owned.matchId)
        }
      }
      render()
    },
    /** myTable===null напуска локално (lobby list); иначе актуализира текущата маса (lobby или активна фаза). */
    setMyTable(table: SvaraPublicTable | null) {
      myTable = table
      if (table === null) { snapshot = null; timing = null }
      leavePending = false
      joinPendingMatchId = null
      render()
    },
    setSnapshot(next: SvaraMatchSnapshotMessage | null) { snapshot = next; render() },
    setTiming(next: SvaraMatchTimingMessage | null) { timing = next; render() },
    showMessage(next: string) { joinPendingMatchId = null; message = next; render() },
    getMyTableId(): string | null { return myTable?.matchId ?? null },
    // Mirror на Ludo's _ludoController !== null сигнала за PWA update
    // safety (виж pwaUpdateCoordinator.ts's hasActiveSvaraMatch doc
    // коментар) — true само докато масата реално играе, не само докато
    // потребителят разглежда списъка/чакащата стая.
    isInActiveMatch(): boolean { return myTable !== null && myTable.phase !== 'lobby' },
    requestExit,
    destroy() {
      if (tickTimer !== null) { clearInterval(tickTimer); tickTimer = null }
      if (fullscreenSupported) document.removeEventListener('fullscreenchange', handleFullscreenChange)
      if (fullscreenSupported && document.fullscreenElement === tableElementRef && tableElementRef !== null) {
        void document.exitFullscreen().catch(() => {})
      }
      options.root.innerHTML = ''
    },
  }
}
