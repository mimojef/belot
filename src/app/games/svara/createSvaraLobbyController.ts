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
  SvaraStartMode,
} from '../../network/createGameServerClient'
import { sharedServerClock } from '../../network/serverClock'
import { playGameSound } from '../../audio/gameSoundSettings'
import {
  renderSvaraActiveTable,
  patchSvaraResultPresentation,
  patchSvaraDecisionTable,
  renderSvaraSceneSeatHuds,
  renderSvaraSceneStatusHtml,
  svaraScenePotTotal,
  SVARA_FOLD_BUBBLE_TOTAL_MS,
  SVARA_LOOK_FLIP_TOTAL_MS,
  type SvaraActiveFoldEffect,
  type SvaraActiveLookEffect,
  type RenderSvaraActiveTableInput,
} from './table/renderSvaraActiveTable'
import { deriveSvaraActionButtons } from './table/svaraBettingActions'
import { createSvaraBetAnimationTracker } from './table/svaraBetAnimationTracker'
import { createSvaraFoldAnimationTracker } from './table/svaraFoldAnimationTracker'
import { createSvaraLookAnimationTracker } from './table/svaraLookAnimationTracker'
import { computeSvaraDealingVisualState } from './table/svaraTableAnimation'
import { playSvaraFoldVoice } from './table/svaraFoldVoice'
import { getSvaraDecisionWindow, patchSvaraDecisionWindow } from './table/svaraDecisionWindows'
import { fetchSvaraTableCreationOptions, type SvaraTableCreationOptions } from './svaraAccess'
import { createSvaraRealScene } from './table/svaraRealScene'
import { computeSvaraResultVisualState } from './table/svaraResultAnimation'

export type SvaraCreateDialogState = {
  open: boolean
  draft: { capacity: 2 | 3 | 4; entryFee: number; startMode: SvaraStartMode }
  options: SvaraTableCreationOptions | null
}

type Options = {
  root: HTMLElement
  localProfileId: string
  apiBaseUrl?: string
  createDialogState?: SvaraCreateDialogState
  onRefresh: () => void
  onCreate: (capacity: 2 | 3 | 4, entryFee: number, startMode: SvaraStartMode) => void
  onJoin: (matchId: string) => void
  onLeave: (matchId: string) => void
  onStart: (matchId: string) => void
  /** ВРЕМЕННО — тестови ботове (docs/svara-test-bots-local.md). */
  onFillWithBots?: (matchId: string) => void
  onRequestTableState: (matchId: string) => void
  onOpenProfile?: (profileId: string, displayName: string | null) => void
  /** Задание 2Б.3.7.4 §15 — реалните участнически команди (bet/fold/look/all-in/request-return/...). */
  onSubmitCommand: (matchId: string, commandId: string, expectedRevision: number, command: SvaraParticipantCommand) => void
}

const esc = (value: unknown) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!)
const amountFormatter = new Intl.NumberFormat('bg-BG', { useGrouping: 'always' })
const formatAmount = (value: number): string => amountFormatter.format(value)

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
  const dialogState: SvaraCreateDialogState = options.createDialogState ?? { open: false, draft: { capacity: 2, entryFee: 5000, startMode: 'auto' }, options: null }
  let createOpen = dialogState.open
  let createDialogElement: HTMLDialogElement | null = null
  let creationOptions: SvaraTableCreationOptions | null = dialogState.options
  let creationLoading = false
  let creationRequest = 0
  let createDraft = dialogState.draft
  let message = ''
  let leavePending = false
  // ВРЕМЕННО — тестови ботове: една заявка за запълване до следващото обновяване на масата.
  let fillBotsPending = false
  let joinPendingMatchId: string | null = null
  // Задание §15 — само ЕДНА игрова команда наведнъж; бутоните са неактивни,
  // докато чакаме отговор (svara_command_result/svara_command_error),
  // идентифициран по commandId, за да не го обърка закъснял по-стар отговор.
  let actionPending = false
  let pendingActionCommandId: string | null = null
  // An ACK may arrive before the updated snapshot. Keep this choice locked
  // until authoritative state resolves it, rather than enabling a second click.
  let pendingDecision: { key: string; commandId: string } | null = null
  // Задание §14 — проследява кои записи от round.actions вече са анимирани,
  // scoped по roundId (reconnect-safe, виж svaraBetAnimationTracker.ts).
  const betAnimationTracker = createSvaraBetAnimationTracker()
  // Задание §11/§13/§14 — отделни tracker instances (виж коментарите в самите
  // файлове защо не се преизползва betAnimationTracker-а).
  const foldAnimationTracker = createSvaraFoldAnimationTracker()
  const lookAnimationTracker = createSvaraLookAnimationTracker()
  // Общата визуална сцена от демото (места, тесте, карти, чипове, банка,
  // „СВАРА!“, победител). Постоянна: оцелява при всяко обновяване на DOM-а
  // на масата; следва само сървърните snapshot-и.
  const tableScene = createSvaraRealScene({
    onOpenProfile: (playerId) => {
      const player = myTable?.players.find((participant) => participant.playerId === playerId)
      if (player && !player.isBot) options.onOpenProfile?.(player.playerId, player.displayName ?? null) // ВРЕМЕННО: ботовете нямат профил
    },
  })
  // Активните, все още визуализирани fold/look ефекти — анкетирани към
  // АБСОЛЮТНО сървърно "сега" в момента на откриване (sharedServerClock), не
  // локален performance.now()/Date.now() старт; elapsedMs за рендиране се
  // преизчислява наново на всеки render() (виж §7/§14 reconnect/no-restart).
  type ActiveFoldEffectState = { seatIndex: number; voluntary: boolean; startedAtServerMs: number }
  let activeFoldEffects: ActiveFoldEffectState[] = []
  let activeLookEffectStartedAtServerMs: number | null = null
  // Настройка „Анимации“ в Свара — включена по подразбиране, НЕЗАВИСИМО от
  // prefers-reduced-motion/системните настройки; изборът се помни локално.
  // Изключена: сцената показва крайните състояния директно (играта остава
  // напълно функционална; тестето, картите и чиповете остават видими).
  const ANIMATIONS_STORAGE_KEY = 'pika.svara.animations'
  let reducedMotion = (() => { try { return window.localStorage.getItem(ANIMATIONS_STORAGE_KEY) === 'off' } catch { return false } })()
  function setAnimationsEnabled(enabled: boolean): void {
    reducedMotion = !enabled
    try { window.localStorage.setItem(ANIMATIONS_STORAGE_KEY, enabled ? 'on' : 'off') } catch { /* личен режим — само за сесията */ }
    render()
  }

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
    const flashes = Array.from(options.root.querySelectorAll<HTMLElement>('[data-svara-bet-flash]'))
    const html = `<section data-svara-lobby="1" style="background:#030303;color:#fff;font-family:Arial,sans-serif;box-sizing:border-box;padding:clamp(10px,2.4vw,32px);overflow-x:hidden;">
      <div style="max-width:${isActiveTable ? '1100px' : '860px'};margin:0 auto;">
        ${myTable ? '' : `<div style="display:flex;justify-content:flex-end;margin-bottom:16px;"><button data-svara-create-open="1" style="${createButtonStyle}">+ Създай игра</button></div>`}
        ${message ? `<div style="margin-bottom:12px;color:#f4c95b;font-weight:700;">${esc(message)}</div>` : ''}
        ${body}
      </div>
      ${createOpen ? renderCreateModal() : ''}
    </section>`
    // Fullscreen belongs to this exact DOM node. Updating its contents keeps
    // the decision dialog in fullscreen through snapshots and command ACKs.
    const patched = isActiveTable && patchActiveTable(html)
    if (patched) { /* обновено по региони */ } else if (fullscreenSupported && tableElementRef && document.fullscreenElement === tableElementRef && isActiveTable) {
      const template = document.createElement('template')
      template.innerHTML = html
      const nextTable = template.content.querySelector<HTMLElement>('[data-svara-table]')
      if (nextTable) {
        tableElementRef.innerHTML = nextTable.innerHTML
        tableElementRef.style.cssText = nextTable.style.cssText
      }
    } else options.root.innerHTML = html
    if (!patched) {
      const liveTable = options.root.querySelector('[data-svara-table]')
      if (liveTable) recordRegions(liveTable, 'table')
    }
    // Preserve the actual WAAPI nodes through countdown/look/fold renders.
    // Replacing innerHTML used to truncate the 900ms flash at the next tick.
    const flashScope = JSON.stringify([snapshot?.matchId, snapshot?.round?.roundId])
    for (const flash of flashes) {
      if (flash.dataset.svaraBetScope !== flashScope) continue
      options.root.querySelector(`[data-svara-seat-index="${Number(flash.dataset.svaraBetFlash)}"] [data-svara-seat-flash-mount]`)?.appendChild(flash)
    }
    // CSS zoom also scales native top-layer elements while they remain under
    // the lobby shell. Own this modal under body and remove it on every remount.
    createDialogElement?.remove()
    createDialogElement = options.root.querySelector<HTMLDialogElement>('dialog[data-svara-create-backdrop]')
    if (createDialogElement) document.body.appendChild(createDialogElement)
    wire()
    ensureResultFrame()
    syncTableMotion()
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
          <div style="margin-top:6px;color:rgba(255,255,255,.62);font-size:13px;">${table.players.length}/${table.capacity} · ${table.startMode === 'manual' ? 'Ръчен старт' : 'При запълване'}</div>
          ${tableAmountsHtml(table)}
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
    const displayName = player.displayName?.trim() || 'Профилът не е достъпен'
    const avatar = player.avatarUrl
      ? `<img data-svara-player-avatar="1" src="${esc(player.avatarUrl)}" alt="" draggable="false" style="width:100%;height:100%;object-fit:cover;display:block;" />`
      : `<span data-svara-avatar-placeholder="1" aria-hidden="true">${esc(displayName.charAt(0).toUpperCase())}</span>`
    return `<div data-svara-waiting-seat="${esc(player.playerId)}" style="box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0;border:1px solid rgba(255,255,255,.12);border-radius:9px;padding:8px 10px;">
      <button type="button" data-svara-profile-id="${esc(player.playerId)}" aria-label="${esc(`Отвори профила на ${displayName}`)}" style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;border:0;padding:0;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit;">
        <span style="width:34px;height:34px;flex:0 0 34px;border-radius:8px;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#101010;border:1px solid rgba(212,165,32,.34);color:#d4a520;font-size:18px;font-weight:900;">${avatar}</span>
        <span data-svara-player-name="1" title="${esc(displayName)}" style="font-weight:700;font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(displayName)}</span>
        ${isCreator ? '<span data-svara-creator="1" aria-label="Създател на масата" style="color:#f4c95b;flex-shrink:0;">★</span>' : ''}
        ${player.isBot ? '<span data-svara-bot-badge="1" title="Тестов бот" style="flex-shrink:0;border:1px solid rgba(120,190,255,.6);border-radius:5px;padding:1px 5px;font-size:10px;font-weight:800;color:#9fd0ff;">БОТ</span>' : ''}
      </button>
      <span data-svara-player-status="1" style="font-size:11px;color:rgba(255,255,255,.65);flex-shrink:0;">${STATUS_LABEL[player.status]}</span>
    </div>`
  }

  function tableAmountsHtml(table: SvaraPublicTable): string {
    const coin = '<img src="/assets/lobby/icon-coin.png" alt="" aria-hidden="true" style="width:17px;height:17px;display:block;object-fit:contain;flex:0 0 auto;" />'
    return `<div style="display:grid;gap:5px;margin-top:7px;font-size:13px;line-height:1.4;">
      <div data-svara-waiting-entry="1" style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">Вход: <span style="display:inline-flex;align-items:center;gap:5px;">${coin}<span>${formatAmount(table.entryFee)} жълтици</span></span></div>
      <div data-svara-waiting-prize="1" style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;color:#f4c95b;">Тестова награда: <span style="display:inline-flex;align-items:center;gap:5px;">${coin}<span>${formatAmount(table.entryFee * table.capacity * 4 / 5)} жълтици</span></span><span style="font-size:11px;color:rgba(255,255,255,.65);">(Не се изплаща)</span></div>
    </div>`
  }

  function renderWaiting(table: SvaraPublicTable): string {
    const isHost = table.creatorId === options.localProfileId
    const canManualStart = table.startMode === 'manual' && table.players.length === table.capacity
    const slotsHtml = Array.from({ length: table.capacity }, (_, index) => seatSlotHtml(table, index)).join('')
    return `<div data-svara-waiting="1" style="${panel}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:16px;">
        <div style="min-width:0;"><strong>Чакаща маса</strong><div data-svara-waiting-capacity="1" style="color:rgba(255,255,255,.62);margin-top:5px;font-size:13px;">${table.players.length}/${table.capacity} · ${table.startMode === 'manual' ? 'Ръчен старт' : 'При запълване'}</div>${tableAmountsHtml(table)}</div>
        <button data-svara-table-leave="1" ${leavePending ? 'disabled' : ''} style="${button}${leavePending ? 'opacity:.55;cursor:wait;' : ''}">${leavePending ? 'Напускане…' : 'Напусни'}</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));gap:8px;">${slotsHtml}</div>
      ${table.startMode === 'manual' && isHost ? `<button data-svara-table-start="1" ${canManualStart ? '' : 'disabled'} style="${button}width:100%;margin-top:16px;background:${canManualStart ? '#d4a520' : '#242424'};color:${canManualStart ? '#050505' : '#777'};cursor:${canManualStart ? 'pointer' : 'not-allowed'};">Старт</button>` : ''}
      ${table.testBotFill === true && isHost && options.onFillWithBots ? `<button data-svara-table-fill-bots="1" ${fillBotsPending ? 'disabled' : ''} style="${button}width:100%;margin-top:10px;border-color:rgba(120,190,255,.6);color:#9fd0ff;${fillBotsPending ? 'opacity:.55;cursor:wait;' : ''}">${fillBotsPending ? 'Запълване…' : 'Запълни с ботове'}</button><div style="margin-top:6px;font-size:11px;color:rgba(255,255,255,.5);text-align:center;">Само за локално тестване</div>` : ''}
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
  let resultFrame: number | null = null

  function showingResult(): boolean {
    const round = snapshot?.round
    return myTable !== null && myTable.phase !== 'lobby' && snapshot?.matchId === myTable.matchId
      && (round?.kind === 'showdown-display' || (round?.kind === 'reveal-choice' && round.decision === 'revealed'))
  }

  function patchResult(): void {
    if (myTable && showingResult()) { patchSvaraResultPresentation(options.root, activeTableInput(myTable)); syncTableMotion() }
  }

  function showingDecisionPhase(): boolean {
    const round = snapshot?.round
    return myTable !== null && snapshot?.matchId === myTable.matchId
      && (round?.kind === 'svara-joining' || (round?.kind === 'reveal-choice' && round.decision === 'pending'))
  }

  function currentDecision() {
    if (!myTable || snapshot?.matchId !== myTable.matchId) return null
    return getSvaraDecisionWindow(snapshot, timing, sharedServerClock.getServerNow(), options.localProfileId)
  }

  function patchDecision(): void {
    if (!myTable) return
    const model = currentDecision()
    patchSvaraDecisionWindow(options.root.querySelector('[data-svara-decision-mount]'), model,
      actionPending || (pendingDecision !== null && pendingDecision.key === model?.key), message)
    patchSvaraDecisionTable(options.root, activeTableInput(myTable))
    syncTableMotion()
  }

  function handleDecisionClick(event: Event): void {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-svara-decision-action]') : null
    if (!target || !options.root.contains(target) || target.disabled || actionPending || pendingDecision) return
    const model = currentDecision()
    if (!model || model.key !== target.dataset.svaraDecisionKey) return
    const action = model.actions.find((entry) => entry.kind === target.dataset.svaraDecisionAction)
    if (action) { message = ''; submitParticipantCommand(action.command, model.key) }
  }
  options.root.addEventListener('click', handleDecisionClick)

  function ensureResultFrame(): void {
    const deadline = timing?.deadlines.find((entry) => entry.kind === 'showdown-display' || entry.kind === 'payout-display' || entry.kind === 'reveal-display')
    const hasLiveResultDeadline = timing?.matchId === snapshot?.matchId && timing?.revision === snapshot?.revision
      && deadline !== undefined && sharedServerClock.getServerNow() < deadline.deadlineAt
    if (!showingResult() || !hasLiveResultDeadline) {
      if (resultFrame !== null) cancelAnimationFrame(resultFrame)
      resultFrame = null
      return
    }
    if (resultFrame !== null || typeof requestAnimationFrame !== 'function') return
    resultFrame = requestAnimationFrame(() => {
      resultFrame = null
      patchResult()
      ensureResultFrame()
    })
  }

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
  // Раздаване, обръщане и отказ вече са WAAPI анимации в слоя за движение —
  // няма нужда от чести (33 ms) пълни рендерирания; тиковете (250 ms) са само
  // за обратното броене. isDealingAnimationActive остава за диагностика.
  function hasActiveVisualAnimation(): boolean {
    void isDealingAnimationActive
    return false
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
      tickTimer = setInterval(() => {
        if (showingResult()) patchResult()
        else if (showingDecisionPhase()) patchDecision()
        else render()
      }, desiredIntervalMs)
    } else if (!needsTick && tickTimer !== null) {
      clearInterval(tickTimer)
      tickTimer = null
      tickIntervalMs = null
    }
  }

  function activeTableInput(table: SvaraPublicTable): RenderSvaraActiveTableInput {
    const serverNow = sharedServerClock.getServerNow()
    const dealingDeadlineAt = timing?.deadlines.find((deadline) => deadline.kind === 'dealing')?.deadlineAt ?? null
    const dealingVisual = computeSvaraDealingVisualState(snapshot?.round ?? null, dealingDeadlineAt, serverNow, snapshot?.seats ?? [])
    const activeFoldEffectsInput: SvaraActiveFoldEffect[] = activeFoldEffects.map((effect) => ({
      seatIndex: effect.seatIndex,
      voluntary: effect.voluntary,
      elapsedMs: serverNow - effect.startedAtServerMs,
      startedAtServerMs: effect.startedAtServerMs,
    }))
    const activeLookEffectInput: SvaraActiveLookEffect | null = activeLookEffectStartedAtServerMs === null
      ? null
      : { elapsedMs: serverNow - activeLookEffectStartedAtServerMs }
    return {
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
      activeFoldEffects: showingResult() ? [] : activeFoldEffectsInput,
      activeLookEffect: showingResult() ? null : activeLookEffectInput,
      reducedMotion,
      decisionPending: actionPending || (pendingDecision !== null && pendingDecision.key === currentDecision()?.key),
      decisionMessage: message,
    }
  }

  function syncTableMotion(): void {
    const host = options.root.querySelector<HTMLElement>('[data-svara-scene-host]')
    if (!myTable || myTable.phase === 'lobby' || !snapshot || snapshot.matchId !== myTable.matchId || !host) { tableScene.reset(); return }
    const serverNow = sharedServerClock.getServerNow()
    const liveTiming = timing?.matchId === snapshot.matchId ? timing : null
    const tableInput = activeTableInput(myTable)
    tableScene.update(host, {
      snapshot, timing: liveTiming, serverNow, localProfileId: options.localProfileId, animations: !reducedMotion, table: myTable,
      resultVisual: computeSvaraResultVisualState(snapshot, liveTiming, serverNow),
      seatHuds: renderSvaraSceneSeatHuds(tableInput),
      statusHtml: renderSvaraSceneStatusHtml(tableInput),
      potTotal: svaraScenePotTotal(tableInput),
    })
    animateFoldBubbles(serverNow)
  }

  // Балончето „Бягам!“/„Времето изтече!“ — една WAAPI анимация спрямо
  // сървърния момент на отказа; обновяване на масата не я рестартира.
  function animateFoldBubbles(serverNow: number): void {
    if (reducedMotion) return
    for (const el of options.root.querySelectorAll<HTMLElement>('[data-svara-fold-bubble]')) {
      const start = el.dataset.svaraFoldStart ? Number(el.dataset.svaraFoldStart) : NaN
      if (el.dataset.svaraFoldAnimated || !Number.isFinite(start)) continue
      el.dataset.svaraFoldAnimated = '1'
      const total = SVARA_FOLD_BUBBLE_TOTAL_MS
      el.animate([{ opacity: 0, offset: 0 }, { opacity: 1, offset: 150 / total }, { opacity: 1, offset: (total - 250) / total }, { opacity: 0, offset: 1 }],
        { duration: total, delay: -(serverNow - start), fill: 'both' })
    }
  }

  // ── Обновяване по региони вместо пълно преизграждане ─────────────────────
  // Всеки регион (място, център, бар с действия, ...) се подменя САМО ако
  // неговият HTML се е променил. Слоят за движение и летящите „+N“ не са
  // рендирани региони и никога не се унищожават.
  const renderedRegionHtml = new Map<string, string>()
  let renderedShell: string | null = null
  function regionKey(el: Element, index: number): string {
    const data = (el as HTMLElement).dataset
    if (data.svaraSeatIndex !== undefined) return `seat:${data.svaraSeatIndex}`
    for (const name of ['svaraFelt', 'svaraFeltCenter', 'svaraResultOverlay', 'svaraResultBanner', 'svaraDiagnostics', 'svaraActionBar', 'svaraDecisionMount'] as const) {
      if (data[name] !== undefined) return name
    }
    return `#${index}`
  }
  const isPersistentNode = (el: Element) => (el as HTMLElement).dataset.svaraSceneStage !== undefined || (el as HTMLElement).dataset.svaraBetFlash !== undefined
  function recordRegions(container: Element, path: string): void {
    ;[...container.children].filter((c) => !isPersistentNode(c)).forEach((child, i) => {
      const key = `${path}/${regionKey(child, i)}`
      if (regionKey(child, i) === 'svaraFelt') recordRegions(child, key)
      else renderedRegionHtml.set(key, child.outerHTML)
    })
  }
  function reconcileRegions(live: HTMLElement, next: HTMLElement, path: string): void {
    for (const attr of [...next.attributes]) if (live.getAttribute(attr.name) !== attr.value) live.setAttribute(attr.name, attr.value)
    const nextChildren = [...next.children]
    const liveChildren = [...live.children].filter((c) => !isPersistentNode(c))
    const nextKeys = nextChildren.map(regionKey)
    if (nextKeys.join('|') !== liveChildren.map(regionKey).join('|')) {
      const anchor = [...live.children].find(isPersistentNode) ?? null
      for (const child of liveChildren) child.remove()
      for (const child of nextChildren) live.insertBefore(child, anchor)
      recordRegions(live, path)
      return
    }
    nextChildren.forEach((child, i) => {
      const key = `${path}/${nextKeys[i]}`
      if (nextKeys[i] === 'svaraFelt') { reconcileRegions(liveChildren[i] as HTMLElement, child as HTMLElement, key); return }
      const html = child.outerHTML
      if (renderedRegionHtml.get(key) === html) return
      liveChildren[i]!.replaceWith(child)
      renderedRegionHtml.set(key, html)
    })
  }
  /** true — масата е обновена по региони; false — нужно е пълно рендиране. */
  function patchActiveTable(html: string): boolean {
    const template = document.createElement('template')
    template.innerHTML = html
    const section = template.content.firstElementChild
    const nextTable = template.content.querySelector<HTMLElement>('[data-svara-table]')
    const liveTable = options.root.querySelector<HTMLElement>('[data-svara-table]')
    if (!section || !nextTable) { renderedShell = null; renderedRegionHtml.clear(); return false }
    const shellClone = section.cloneNode(true) as HTMLElement
    shellClone.querySelector('[data-svara-table]')?.replaceChildren()
    const shell = shellClone.outerHTML
    if (!liveTable || renderedShell !== shell) {
      renderedShell = shell
      renderedRegionHtml.clear()
      return false
    }
    reconcileRegions(liveTable, nextTable, 'table')
    return true
  }

  function renderActiveTable(table: SvaraPublicTable): string {
    return renderSvaraActiveTable(activeTableInput(table))
  }

  // Задание §13 — floating "+N" над аватара, плавно смалява/избледнява към
  // баджа отдолу. Чисто презентационно — играе се ПОСЛЕ DOM вече отразява
  // новото състояние (badge текстът е актуален), само визуален flourish.
  function playBetFlash(seatIndex: number, amount: number): void {
    const mount = options.root.querySelector<HTMLElement>(`[data-svara-seat-index="${seatIndex}"] [data-svara-seat-flash-mount]`)
    if (!mount) return
    const el = document.createElement('div')
    el.dataset.svaraBetFlash = String(seatIndex)
    el.dataset.svaraBetScope = JSON.stringify([snapshot?.matchId, snapshot?.round?.roundId])
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
    tableScene.onBets(newEntries.flatMap((entry) => {
      const seat = snapshot?.seats.find((s) => s.playerId === entry.playerId)
      return seat ? [{ seatIndex: seat.seatIndex, added: entry.added }] : []
    }))
    syncTableMotion()
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
    if (newLook) { activeLookEffectStartedAtServerMs = sharedServerClock.getServerNow(); tableScene.onLook() }
    if (newFolds.length > 0 || newLook) render()
  }

  function renderCreateModal(): string {
    // Match Ludo's dialog dimensions/styles without changing its component.
    const modalButton = `${button}min-height:42px;`
    const selectStyle = 'width:100%;max-width:100%;min-width:0;box-sizing:border-box;min-height:42px;background:#111;color:#fff;border:1px solid #555;border-radius:7px;padding:0 10px;'
    const entry = creationOptions?.entries.find((option) => option.entryFee === createDraft.entryFee)
    const content = entry && creationOptions ? `<form data-svara-create-form="1">
      <label style="display:grid;gap:7px;margin-bottom:14px;min-width:0;">Брой играчи<select name="capacity" style="${selectStyle}">${[2, 3, 4].map((count) => `<option value="${count}" ${count === createDraft.capacity ? 'selected' : ''}>${count}</option>`).join('')}</select></label>
      <label style="display:grid;gap:7px;margin-bottom:14px;min-width:0;">Вход<select name="entryFee" style="${selectStyle}">${creationOptions.entries.map((option) => `<option value="${option.entryFee}" ${option.entryFee === createDraft.entryFee ? 'selected' : ''}>${formatAmount(option.entryFee)} жълтици</option>`).join('')}</select></label>
      <div style="display:grid;gap:4px;margin:0 0 18px;font-size:13px;line-height:1.4;color:#f4c95b;" aria-live="polite">
        <div data-svara-create-chips="1">Получаваш: ${formatAmount(entry.startingChips)} виртуални чипа</div>
        <div data-svara-create-ante="1">Анте за раздаване: ${formatAmount(entry.entryChips)} чипа</div>
        <div data-svara-create-prize="1">Изчислена тестова награда: ${formatAmount(createDraft.entryFee * createDraft.capacity * 4 / 5)} жълтици (не се изплаща)</div>
      </div>
      <fieldset style="border:0;padding:0;margin:0 0 18px;display:grid;gap:10px;"><legend style="margin-bottom:8px;">Старт</legend><label><input type="radio" name="startMode" value="auto" ${createDraft.startMode === 'auto' ? 'checked' : ''}> При запълване</label><label><input type="radio" name="startMode" value="manual" ${createDraft.startMode === 'manual' ? 'checked' : ''}> Ръчен старт</label></fieldset>
      <div style="display:flex;justify-content:flex-end;gap:8px;"><button type="button" data-svara-create-close="1" style="${modalButton}">Отказ</button><button type="submit" style="${modalButton}background:#d4a520;color:#050505;">Създай</button></div>
    </form>` : `<p role="status">${creationLoading ? 'Зареждане на настройките…' : 'Настройките за създаване не са достъпни. Опитай отново.'}</p>
      <div style="display:flex;justify-content:flex-end;gap:8px;"><button type="button" data-svara-create-close="1" style="${modalButton}">Отказ</button>${creationLoading ? '' : `<button type="button" data-svara-create-retry="1" style="${modalButton}">Опитай отново</button>`}</div>`
    return `<dialog data-svara-create-backdrop="1" aria-labelledby="svara-create-title" style="position:fixed;inset:0;margin:0;border:0;width:100vw;height:100dvh;max-width:none;max-height:none;box-sizing:border-box;background:rgba(0,0,0,.78);color:#fff;font-family:Arial,sans-serif;font-size:16px;display:grid;place-items:center;padding:14px;"><div data-svara-create-panel="1" style="${panel}width:min(100%,420px);max-width:100%;min-width:0;max-height:calc(100dvh - 28px);overflow-y:auto;box-sizing:border-box;">
      <h2 id="svara-create-title" style="margin:0 0 18px;letter-spacing:0;">Създай игра</h2>${content}</div></dialog>`
  }

  async function loadCreationOptions(): Promise<void> {
    const request = ++creationRequest
    creationLoading = true
    creationOptions = null
    dialogState.options = null
    render()
    const result = await fetchSvaraTableCreationOptions(options.apiBaseUrl ?? '')
    if (request !== creationRequest || !createOpen) return
    creationOptions = result
    dialogState.options = result
    creationLoading = false
    render()
  }

  // Слушателите се закачат веднъж на елемент (обновяването по региони пази
  // непроменените елементи — без двойни команди).
  const boundListeners = new WeakMap<Element, Set<string>>()
  function on(el: Element | null | undefined, type: string, listener: (event: Event) => void): void {
    if (!el) return
    const types = boundListeners.get(el) ?? new Set<string>()
    if (types.has(type)) return
    types.add(type)
    boundListeners.set(el, types)
    el.addEventListener(type, listener)
  }

  function wire(): void {
    const createDialog = createDialogElement
    if (createDialog) {
      if (!createDialog.open) createDialog.showModal()
      on(createDialog, 'cancel', (event) => {
        event.preventDefault()
        dialogState.open = createOpen = false
        creationRequest++
        render()
      })
    }
    on(options.root.querySelector('[data-svara-create-open]'), 'click', () => {
      dialogState.open = createOpen = true
      dialogState.draft = createDraft = { capacity: 2, entryFee: 5000, startMode: 'auto' }
      void loadCreationOptions()
    })
    on(createDialog?.querySelector('[data-svara-create-retry]'), 'click', () => { void loadCreationOptions() })
    on(createDialog?.querySelector('[data-svara-create-close]'), 'click', () => { dialogState.open = createOpen = false; creationRequest++; render() })
    options.root.querySelectorAll<HTMLElement>('[data-svara-table-join]').forEach((el) => on(el, 'click', () => {
      const matchId = el.dataset.svaraTableJoin!
      if (joinPendingMatchId) return
      joinPendingMatchId = matchId
      message = ''
      render()
      options.onJoin(matchId)
    }))
    on(options.root.querySelector('[data-svara-table-leave]'), 'click', () => requestExit())
    // Бутонът „Изход“ в банера на приключил/прекратен мач — същото leave_svara_table.
    on(options.root.querySelector('[data-svara-result-exit]'), 'click', () => requestExit())
    on(options.root.querySelector('[data-svara-table-start]'), 'click', () => { if (myTable) options.onStart(myTable.matchId) })
    // ВРЕМЕННО — тестови ботове.
    on(options.root.querySelector('[data-svara-table-fill-bots]'), 'click', () => {
      if (!myTable || fillBotsPending) return
      fillBotsPending = true
      message = ''
      render()
      options.onFillWithBots?.(myTable.matchId)
    })
    on(options.root.querySelector('[data-svara-table-refresh]'), 'click', () => { if (myTable) options.onRequestTableState(myTable.matchId) })
    options.root.querySelectorAll<HTMLElement>('[data-svara-profile-id]').forEach((element) => on(element, 'click', () => {
      const player = myTable?.players.find((participant) => participant.playerId === element.dataset.svaraProfileId)
      if (player && !player.isBot) options.onOpenProfile?.(player.playerId, player.displayName ?? null) // ВРЕМЕННО: ботовете нямат профил
    }))
    const createForm = createDialog?.querySelector<HTMLFormElement>('[data-svara-create-form]')
    if (createForm) on(createForm, 'change', () => {
      const data = new FormData(createForm)
      const capacity = Number(data.get('capacity'))
      const entry = creationOptions?.entries.find((option) => option.entryFee === Number(data.get('entryFee')))
      if (!entry || (capacity !== 2 && capacity !== 3 && capacity !== 4)) return
      dialogState.draft = createDraft = { capacity, entryFee: entry.entryFee, startMode: data.get('startMode') === 'manual' ? 'manual' : 'auto' }
      const chips = createForm.querySelector('[data-svara-create-chips]')
      const ante = createForm.querySelector('[data-svara-create-ante]')
      const prize = createForm.querySelector('[data-svara-create-prize]')
      if (chips) chips.textContent = `Получаваш: ${formatAmount(entry.startingChips)} виртуални чипа`
      if (ante) ante.textContent = `Анте за раздаване: ${formatAmount(entry.entryChips)} чипа`
      if (prize) prize.textContent = `Изчислена тестова награда: ${formatAmount(entry.entryFee * capacity * 4 / 5)} жълтици (не се изплаща)`
    })
    if (createForm) on(createForm, 'submit', (event) => {
      event.preventDefault()
      const data = new FormData(event.currentTarget as HTMLFormElement)
      const capacity = Number(data.get('capacity'))
      const entryFee = Number(data.get('entryFee'))
      const startMode = data.get('startMode')
      if ((capacity !== 2 && capacity !== 3 && capacity !== 4) || !creationOptions?.entries.some((entry) => entry.entryFee === entryFee)
        || (startMode !== 'auto' && startMode !== 'manual')) return
      dialogState.open = createOpen = false
      creationRequest++
      options.onCreate(capacity, entryFee, startMode)
      render()
    })
    tableElementRef = options.root.querySelector<HTMLElement>('[data-svara-table="1"]')
    on(options.root.querySelector('[data-svara-fullscreen-toggle]'), 'click', () => { void toggleFullscreen() })
    on(options.root.querySelector('[data-svara-animations-toggle]'), 'click', () => setAnimationsEnabled(reducedMotion))
    options.root.querySelectorAll<HTMLElement>('[data-svara-action-button]').forEach((el) => on(el, 'click', () => {
      const kind = el.dataset.svaraActionButton
      if (kind === 'request-return') { submitParticipantCommand({ type: 'request-return' }); return }
      const button = deriveSvaraActionButtons(snapshot?.you.betting ?? null, snapshot?.you.looked ?? false).find((b) => b.kind === kind)
      if (button && !button.disabled) submitParticipantCommand(button.command)
    }))
  }

  // Задание §15 — само ЕДНА команда в движение, защитена с commandId/
  // expectedRevision; никога не намаляваме локален баланс/успех оптимистично.
  function submitParticipantCommand(command: SvaraParticipantCommand, decisionKey?: string): void {
    if (actionPending || myTable === null || snapshot === null) return
    const commandId = crypto.randomUUID()
    actionPending = true
    pendingActionCommandId = commandId
    if (decisionKey) pendingDecision = { key: decisionKey, commandId }
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
  if (createOpen && !creationOptions) void loadCreationOptions()
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
      if (table === null) { snapshot = null; timing = null; pendingDecision = null; actionPending = false; pendingActionCommandId = null }
      leavePending = false
      fillBotsPending = false // ВРЕМЕННО — тестови ботове
      joinPendingMatchId = null
      render()
    },
    setSnapshot(next: SvaraMatchSnapshotMessage | null) {
      snapshot = next
      if (pendingDecision) {
        const round = next?.round
        const resolved = !next || !round || pendingDecision.key !== JSON.stringify([next.matchId, round.roundId, round.kind === 'svara-joining' ? 'joining' : 'reveal'])
          || (round.kind === 'svara-joining' ? next.you.svaraDecision !== 'undecided' || round.closed
            : round.kind !== 'reveal-choice' || round.decision !== 'pending')
        if (resolved) { pendingDecision = null; actionPending = false; pendingActionCommandId = null; message = '' }
      }
      render()
      flushFoldAndLookAnimations()
      flushBetAnimations()
    },
    setTiming(next: SvaraMatchTimingMessage | null) { timing = next; render() },
    // Отказана lobby заявка (вкл. напускане) освобождава бутоните — иначе
    // „Изход“ остава завинаги неактивен („…“) до следващо обновяване на масата,
    // което при приключил мач никога не идва.
    showMessage(next: string) { joinPendingMatchId = null; fillBotsPending = false; leavePending = false; message = next; render() },
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
      if (commandId === undefined || pendingDecision?.commandId === commandId) pendingDecision = null
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
      creationRequest++
      createOpen = false
      createDialogElement?.remove()
      createDialogElement = null
      options.root.removeEventListener('click', handleDecisionClick)
      if (resultFrame !== null) { cancelAnimationFrame(resultFrame); resultFrame = null }
      if (tickTimer !== null) { clearInterval(tickTimer); tickTimer = null }
      tableScene.destroy()
      if (fullscreenSupported) document.removeEventListener('fullscreenchange', handleFullscreenChange)
      if (fullscreenSupported && document.fullscreenElement === tableElementRef && tableElementRef !== null) {
        void document.exitFullscreen().catch(() => {})
      }
      options.root.innerHTML = ''
    },
  }
}
