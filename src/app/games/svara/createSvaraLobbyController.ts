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
  SvaraParticipantCommand,
  SvaraPublicTable,
  SvaraSeatStatus,
} from '../../network/createGameServerClient'
import { sharedServerClock } from '../../network/serverClock'
import { playGameSound } from '../../audio/gameSoundSettings'
import {
  renderSvaraActiveTable,
  SVARA_FOLD_BUBBLE_TOTAL_MS,
  SVARA_LOOK_FLIP_TOTAL_MS,
  type SvaraActiveFoldEffect,
  type SvaraActiveLookEffect,
} from './table/renderSvaraActiveTable'
import { deriveSvaraActionButtons } from './table/svaraBettingActions'
import { createSvaraBetAnimationTracker } from './table/svaraBetAnimationTracker'
import { createSvaraFoldAnimationTracker } from './table/svaraFoldAnimationTracker'
import { createSvaraLookAnimationTracker } from './table/svaraLookAnimationTracker'
import { computeSvaraDealingVisualState } from './table/svaraTableAnimation'
import { playSvaraFoldVoice } from './table/svaraFoldVoice'

type Options = {
  root: HTMLElement
  localProfileId: string
  onRefresh: () => void
  onCreate: (capacity: 2 | 3 | 4, entryFee: number) => void
  onJoin: (matchId: string) => void
  onLeave: (matchId: string) => void
  onStart: (matchId: string) => void
  onRequestTableState: (matchId: string) => void
  /** Задание 2Б.3.7.4 §15 — реалните участнически команди (bet/fold/look/all-in/request-return/...). */
  onSubmitCommand: (matchId: string, commandId: string, expectedRevision: number, command: SvaraParticipantCommand) => void
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
  // Задание §15 — само ЕДНА игрова команда наведнъж; бутоните са неактивни,
  // докато чакаме отговор (svara_command_result/svara_command_error),
  // идентифициран по commandId, за да не го обърка закъснял по-стар отговор.
  let actionPending = false
  let pendingActionCommandId: string | null = null
  // Задание §14 — проследява кои записи от round.actions вече са анимирани,
  // scoped по roundId (reconnect-safe, виж svaraBetAnimationTracker.ts).
  const betAnimationTracker = createSvaraBetAnimationTracker()
  // Задание §11/§13/§14 — отделни tracker instances (виж коментарите в самите
  // файлове защо не се преизползва betAnimationTracker-а).
  const foldAnimationTracker = createSvaraFoldAnimationTracker()
  const lookAnimationTracker = createSvaraLookAnimationTracker()
  // Активните, все още визуализирани fold/look ефекти — анкетирани към
  // АБСОЛЮТНО сървърно "сега" в момента на откриване (sharedServerClock), не
  // локален performance.now()/Date.now() старт; elapsedMs за рендиране се
  // преизчислява наново на всеки render() (виж §7/§14 reconnect/no-restart).
  type ActiveFoldEffectState = { seatIndex: number; voluntary: boolean; startedAtServerMs: number }
  let activeFoldEffects: ActiveFoldEffectState[] = []
  let activeLookEffectStartedAtServerMs: number | null = null
  // Задание §15 — prefers-reduced-motion: спира само летящите спрайтове/флип
  // завъртания (виж renderSvaraActiveTable.ts), НИКОГА сървърния timeline.
  const reducedMotionQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null
  let reducedMotion = reducedMotionQuery?.matches ?? false
  function handleReducedMotionChange(): void {
    reducedMotion = reducedMotionQuery?.matches ?? false
    render()
  }
  reducedMotionQuery?.addEventListener('change', handleReducedMotionChange)

  const button = 'border:1px solid rgba(212,165,32,.55);border-radius:7px;background:#0b0b0b;color:#f4c95b;min-height:40px;padding:0 16px;font-weight:800;cursor:pointer;'
  const panel = 'background:#090909;border:1px solid rgba(212,165,32,.35);border-radius:8px;padding:16px;'
  const createButtonStyle = 'box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:8px;height:42px;padding:0 20px;border:1px solid rgba(244,201,91,.5);border-radius:10px;background:linear-gradient(135deg,#f6d27a 0%,#d4a520 55%,#c98f13 100%);color:#1a1200;font-size:14px;font-weight:800;cursor:pointer;white-space:nowrap;'

  function render(): void {
    pruneExpiredEffects(sharedServerClock.getServerNow())
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
  let tickIntervalMs: number | null = null

  // Задание §5/§9/§11 — докато дадена ЧИСТО презентационна анимация реално
  // тече (раздаване/look-flip/fold-fade), тиковете трябва да са достатъчно
  // чести за плавност (~30fps); извън това старите 250ms са напълно
  // достатъчни за countdown текст/пръстен. Никога не променя сървърния
  // дедлайн — само честотата на локалния re-render.
  function isDealingAnimationActive(): boolean {
    const round = snapshot?.round ?? null
    if (!round || (round.kind !== 'ordinary' && round.kind !== 'svara') || !round.dealing) return false
    return timing?.deadlines.some((deadline) => deadline.kind === 'dealing') ?? false
  }
  function hasActiveVisualAnimation(): boolean {
    if (reducedMotion) return false
    return activeFoldEffects.length > 0 || activeLookEffectStartedAtServerMs !== null || isDealingAnimationActive()
  }

  // Задание §11/§14 — изхвърля fold балончета/look-flip ефекти, чиято пълна
  // визуална продължителност вече е изтекла спрямо АБСОЛЮТНОТО сървърно
  // "сега" (не локален timeout) — пазят се само докато реално се рисуват.
  function pruneExpiredEffects(serverNow: number): void {
    activeFoldEffects = activeFoldEffects.filter((effect) => serverNow - effect.startedAtServerMs < SVARA_FOLD_BUBBLE_TOTAL_MS)
    if (activeLookEffectStartedAtServerMs !== null && serverNow - activeLookEffectStartedAtServerMs >= SVARA_LOOK_FLIP_TOTAL_MS) {
      activeLookEffectStartedAtServerMs = null
    }
  }

  function ensureTick(): void {
    const hasActiveDeadline = (timing?.deadlines.length ?? 0) > 0
    const needsTick = hasActiveDeadline || hasActiveVisualAnimation()
    const desiredIntervalMs = hasActiveVisualAnimation() ? 33 : 250
    if (needsTick && (tickTimer === null || tickIntervalMs !== desiredIntervalMs)) {
      if (tickTimer !== null) clearInterval(tickTimer)
      tickIntervalMs = desiredIntervalMs
      tickTimer = setInterval(() => render(), desiredIntervalMs)
    } else if (!needsTick && tickTimer !== null) {
      clearInterval(tickTimer)
      tickTimer = null
      tickIntervalMs = null
    }
  }

  function renderActiveTable(table: SvaraPublicTable): string {
    const serverNow = sharedServerClock.getServerNow()
    const dealingDeadlineAt = timing?.deadlines.find((deadline) => deadline.kind === 'dealing')?.deadlineAt ?? null
    const dealingVisual = computeSvaraDealingVisualState(snapshot?.round ?? null, dealingDeadlineAt, serverNow, snapshot?.seats ?? [])
    const activeFoldEffectsInput: SvaraActiveFoldEffect[] = activeFoldEffects.map((effect) => ({
      seatIndex: effect.seatIndex,
      voluntary: effect.voluntary,
      elapsedMs: serverNow - effect.startedAtServerMs,
    }))
    const activeLookEffectInput: SvaraActiveLookEffect | null = activeLookEffectStartedAtServerMs === null
      ? null
      : { elapsedMs: serverNow - activeLookEffectStartedAtServerMs }
    return renderSvaraActiveTable({
      table,
      snapshot,
      timing,
      localProfileId: options.localProfileId,
      serverNow,
      isFullscreen,
      fullscreenSupported,
      leavePending,
      actionPending,
      dealingVisual,
      activeFoldEffects: activeFoldEffectsInput,
      activeLookEffect: activeLookEffectInput,
      reducedMotion,
    })
  }

  // Задание §13 — floating "+N" над аватара, плавно смалява/избледнява към
  // баджа отдолу. Чисто презентационно — играе се ПОСЛЕ DOM вече отразява
  // новото състояние (badge текстът е актуален), само визуален flourish.
  function playBetFlash(seatIndex: number, amount: number): void {
    const mount = options.root.querySelector<HTMLElement>(`[data-svara-seat-index="${seatIndex}"] [data-svara-seat-flash-mount]`)
    if (!mount) return
    const el = document.createElement('div')
    el.textContent = `+${amount}`
    el.style.cssText = 'position:absolute;left:50%;top:4%;transform:translate(-50%,0);font-size:clamp(16px,5vw,26px);font-weight:900;color:#f4c95b;text-shadow:0 2px 6px rgba(0,0,0,.9);pointer-events:none;z-index:10;white-space:nowrap;'
    mount.appendChild(el)
    try {
      const animation = el.animate(
        [
          { transform: 'translate(-50%,0) scale(1.3)', opacity: 1, offset: 0 },
          { transform: 'translate(-50%,36px) scale(0.75)', opacity: 0, offset: 1 },
        ],
        { duration: 900, easing: 'ease-out', fill: 'forwards' },
      )
      animation.onfinish = () => el.remove()
      animation.oncancel = () => el.remove()
    } catch {
      // Браузър без Element.animate() поддръжка (изключително рядко) — просто
      // премахваме елемента веднага, без да чупим рендирането.
      el.remove()
    }
  }

  // Задание §13 — кратък системен звук при потвърден залог; реизползва
  // съществуващия Белот sound-settings hook (уважава mute настройката,
  // никаква нова аудио зависимост). Ако липсва подходящ файл в бъдеще,
  // смени само src-а тук — asset hook-ът остава същият.
  function playBetSound(): void {
    playGameSound('/audio/game-sounds/coins.mp3', { volume: 0.5 })
  }

  function flushBetAnimations(): void {
    const round = snapshot?.round ?? null
    const newEntries = betAnimationTracker.detectNewEntries(round)
    if (newEntries.length === 0 || !snapshot) return
    for (const entry of newEntries) {
      const seat = snapshot.seats.find((s) => s.playerId === entry.playerId)
      if (seat) playBetFlash(seat.seatIndex, entry.added)
    }
    playBetSound()
  }

  // Задание §9/§10/§11/§13/§14 — открива РЕАЛНО нови (неанимирани досега)
  // откази/поглеждания спрямо последния snapshot и стартира съответния
  // ефект, анкетиран към сървърното "сега" в момента на откриване. Baseline
  // при първо виждане на даден roundId (reconnect/remount) никога не
  // анимира тук — виж самите tracker файлове. Гласът „Бягам!“ се пуска
  // ТОЧНО за доброволните откази, никога за forced-fold (задание §13).
  function flushFoldAndLookAnimations(): void {
    if (!snapshot) return
    const round = snapshot.round
    const newFolds = foldAnimationTracker.detectNewFolds(round)
    if (newFolds.length > 0) {
      const nowServer = sharedServerClock.getServerNow()
      for (const fold of newFolds) {
        const seat = snapshot.seats.find((s) => s.playerId === fold.playerId)
        if (!seat) continue
        activeFoldEffects.push({ seatIndex: seat.seatIndex, voluntary: fold.voluntary, startedAtServerMs: nowServer })
        if (fold.voluntary) playSvaraFoldVoice(null)
      }
    }
    const newLook = lookAnimationTracker.detectNewLook(round?.roundId ?? null, snapshot.you.looked)
    if (newLook) activeLookEffectStartedAtServerMs = sharedServerClock.getServerNow()
    if (newFolds.length > 0 || newLook) render()
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
    options.root.querySelectorAll<HTMLElement>('[data-svara-action-button]').forEach((el) => el.addEventListener('click', () => {
      const kind = el.dataset.svaraActionButton
      if (kind === 'request-return') { submitParticipantCommand({ type: 'request-return' }); return }
      const button = deriveSvaraActionButtons(snapshot?.you.betting ?? null, snapshot?.you.looked ?? false).find((b) => b.kind === kind)
      if (button && !button.disabled) submitParticipantCommand(button.command)
    }))
  }

  // Задание §15 — само ЕДНА команда в движение, защитена с commandId/
  // expectedRevision; никога не намаляваме локален баланс/успех оптимистично.
  function submitParticipantCommand(command: SvaraParticipantCommand): void {
    if (actionPending || myTable === null || snapshot === null) return
    const commandId = crypto.randomUUID()
    actionPending = true
    pendingActionCommandId = commandId
    render()
    options.onSubmitCommand(myTable.matchId, commandId, snapshot.revision, command)
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
    setSnapshot(next: SvaraMatchSnapshotMessage | null) {
      snapshot = next
      render()
      flushBetAnimations()
      flushFoldAndLookAnimations()
    },
    setTiming(next: SvaraMatchTimingMessage | null) { timing = next; render() },
    showMessage(next: string) { joinPendingMatchId = null; message = next; render() },
    // Задание §15 — само СЪЩАТА (или вече изчистената) commandId освобождава
    // бутоните; закъснял отговор за по-стара/отменена команда никога не
    // засяга по-новото pending действие.
    onCommandResult(commandId: string) {
      if (pendingActionCommandId !== commandId) return
      actionPending = false
      pendingActionCommandId = null
      render()
    },
    onCommandError(nextMessage: string, commandId?: string) {
      if (commandId !== undefined && pendingActionCommandId !== commandId) return
      actionPending = false
      pendingActionCommandId = null
      message = nextMessage
      render()
    },
    getMyTableId(): string | null { return myTable?.matchId ?? null },
    // Mirror на Ludo's _ludoController !== null сигнала за PWA update
    // safety (виж pwaUpdateCoordinator.ts's hasActiveSvaraMatch doc
    // коментар) — true само докато масата реално играе, не само докато
    // потребителят разглежда списъка/чакащата стая.
    isInActiveMatch(): boolean { return myTable !== null && myTable.phase !== 'lobby' },
    requestExit,
    destroy() {
      if (tickTimer !== null) { clearInterval(tickTimer); tickTimer = null }
      reducedMotionQuery?.removeEventListener('change', handleReducedMotionChange)
      if (fullscreenSupported) document.removeEventListener('fullscreenchange', handleFullscreenChange)
      if (fullscreenSupported && document.fullscreenElement === tableElementRef && tableElementRef !== null) {
        void document.exitFullscreen().catch(() => {})
      }
      options.root.innerHTML = ''
    },
  }
}
