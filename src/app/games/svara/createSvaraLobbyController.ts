// Свара — реален мултиплейър лоби/маса (Етап 2Б.3.7.2/2Б.3.7.3). Чист view
// слой, mirror на createLudoLobbyController.ts: само рендира каквото
// сървърът е изпратил и вика options.onXxx callback-ите при потребителско
// действие. Няма собствена игрова логика, няма локално генериране на
// карти/банки/ред на ход — всичко идва от SvaraPublicTable/
// SvaraMatchSnapshotMessage. Визуалното оформление на активната маса (места,
// карти, дилър, countdown пръстен, fullscreen) е в table/renderSvaraActiveTable.ts.

import type {
  PlayerGender,
  SvaraMatchSnapshotMessage,
  SvaraMatchTimingMessage,
  SvaraPlayerLookedMessage,
  SvaraParticipantCommand,
  SvaraFinishedMatch,
  SvaraPublicTable,
  SvaraSeatStatus,
  SvaraStartMode,
} from '../../network/createGameServerClient'
import { sharedServerClock } from '../../network/serverClock'
import { isGameSoundsEnabled, setGameSoundsEnabled } from '../../audio/gameSoundSettings'
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
import { createSvaraBetAnimationTracker, detectSvaraFinalCall, isSvaraOpeningPay, svaraRaiseAmount, type SvaraNewBetEntry } from './table/svaraBetAnimationTracker'
import { createSvaraFoldAnimationTracker, detectSvaraFinalFold } from './table/svaraFoldAnimationTracker'
import { createSvaraLookAnimationTracker } from './table/svaraLookAnimationTracker'
import { playSvaraLookVoice, preloadSvaraLookVoice } from './table/svaraLookVoice'
import { computeSvaraDealingVisualState } from './table/svaraTableAnimation'
import { playSvaraFoldVoice, preloadSvaraFoldVoice } from './table/svaraFoldVoice'
import { playSvaraAllInVoice, playSvaraBetVoice, playSvaraBlindVoice, playSvaraPayVoice, playSvaraRaiseVoice, preloadSvaraPayVoice } from './table/svaraPayVoice'
import { getSvaraDecisionWindow, patchSvaraDecisionWindow } from './table/svaraDecisionWindows'
import { fetchSvaraTableCreationOptions, type SvaraTableCreationOptions } from './svaraAccess'
import { createSvaraRealScene } from './table/svaraRealScene'
import { VIOLET_3D_BUTTON_CLASS } from '../../../ui/layout/violet3dButton'
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

// ─── Светъл мобилен вариант (телефон, само предигровите екрани) ─────────
// Включва се, когато mount-ът е в data-lobby-member-mobile-light (рамката я
// дава само извън активна игра — виж isMobileSvaraLobbyView в
// renderLobbyScreen.ts) и масата не е активна; активната маса никога не е светла.
// Стиловете са тези на светлото мобилно Ludo (createLudoLobbyController.ts).
const LIGHT_PANEL_STYLE = 'box-sizing:border-box;min-width:0;background:#FFFFFF;border:1px solid #E4E7EC;border-radius:12px;padding:12px;box-shadow:0 1px 2px rgba(16,24,40,0.05);'
const LIGHT_PRIMARY_BUTTON_STYLE = 'border:0;border-radius:10px;color:#FFFFFF;font-family:inherit;font-weight:800;cursor:pointer;white-space:nowrap;'
const LIGHT_SECONDARY_BUTTON_STYLE = 'box-sizing:border-box;border:1px solid #D0D5DD;border-radius:10px;background:#FFFFFF;color:#6941C6;font-family:inherit;font-weight:800;cursor:pointer;white-space:nowrap;'
const LIGHT_DANGER_BUTTON_STYLE = 'box-sizing:border-box;border:1px solid #FECDCA;border-radius:10px;background:#FFFFFF;color:#B42318;font-family:inherit;font-weight:800;cursor:pointer;white-space:nowrap;'
const LIGHT_META_STYLE = 'font-size:12.5px;line-height:1.4;font-weight:600;color:#667085;'
const LIGHT_FIELD_STYLE = 'width:100%;max-width:100%;min-width:0;box-sizing:border-box;height:44px;background:#FFFFFF;color:#111827;border:1px solid #D0D5DD;border-radius:8px;padding:0 12px;font-family:inherit;font-size:16px;color-scheme:light;'
const LIGHT_MESSAGE_STYLE = 'background:#FFFAEB;border:1px solid #FEDF89;color:#B54708;'
const LIGHT_FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"
const LIGHT_PRIMARY_CLASS = `lobby-violet-btn ${VIOLET_3D_BUTTON_CLASS}`
const LIGHT_EMPTY_ICON_URL = '/assets/lobby-mobile/icons/icon-private-tables-svara.webp'
const backChevronSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M15 18l-6-6 6-6"/></svg>'
const createPlusSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14"/></svg>'

// Тъмният (десктоп/таблет) вариант на предигровите екрани — правилата на
// .ludo-lobby-page/.ludo-action-row/.ludo-tabs-row от createLudoLobbyController.
const DARK_LOBBY_CSS = `
  [data-svara-lobby] .svara-action-row [data-svara-back-to-games]:hover { border-color:rgba(212,165,32,.55); color:#f4c95b; background:rgba(212,165,32,.08); }
  .svara-lobby-page { padding:clamp(14px,3vw,32px); }
  .svara-action-row { flex-wrap:nowrap; gap:10px; }
  .svara-tabs-row { display:flex; gap:8px; }
  @media (max-width: 480px) {
    .svara-lobby-page { padding:12px 7px; margin:0 -12px; }
    .svara-action-row { gap:8px; }
    [data-svara-lifecycle-tab] { font-size:12px; }
    .svara-action-row [data-svara-create-open] { padding:0 12px; }
    .svara-tabs-row { display:grid; grid-template-columns:1fr 1fr; grid-template-areas:"playing finished" "waiting waiting"; gap:6px; }
  }
`

type SvaraLifecycleTab = 'waiting' | 'playing' | 'finished'

const STATUS_LABEL: Record<SvaraSeatStatus, string> = {
  active: 'активен',
  absent: 'отсъства',
  exited: 'напуснал',
  eliminated: 'отпаднал',
}

export function createSvaraLobbyController(options: Options) {
  let tables: SvaraPublicTable[] = []
  // Раздел „Приключили“ — последните завършени мачове от сървъра.
  let finishedMatches: SvaraFinishedMatch[] = []
  let lifecycleTab: SvaraLifecycleTab = 'waiting'
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
  // Игровите анимации в истинската Свара са ВИНАГИ включени — без настройка и
  // независимо от prefers-reduced-motion (без тях действията не са разбираеми).
  // Старата локална настройка „Анимации: изкл.“ не се чете; премахва се.
  try { window.localStorage.removeItem('pika.svara.animations') } catch { /* личен режим */ }
  // Менюто „Настройки“ от горния бар на масата (Звуци в играта).
  let settingsOpen = false
  // Потвърждението за напускане от иконата за изход (само при активна маса).
  let exitConfirmOpen = false
  function setExitConfirmOpen(open: boolean): void {
    if (exitConfirmOpen === open) return
    exitConfirmOpen = open
    render()
  }
  function setSettingsOpen(open: boolean): void {
    if (settingsOpen === open) return
    settingsOpen = open
    render()
  }

  const button = 'border:1px solid rgba(212,165,32,.55);border-radius:7px;background:#0b0b0b;color:#f4c95b;min-height:40px;padding:0 16px;font-weight:800;cursor:pointer;'
  const panel = 'background:#090909;border:1px solid rgba(212,165,32,.35);border-radius:8px;padding:16px;'
  // Бутоните „Назад“ / „+ Създай игра“ — същите стилове като createLudoLobbyController.
  const backButtonStyle = 'box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:38px;padding:0 16px 0 12px;border:1px solid rgba(255,255,255,.16);border-radius:999px;background:rgba(255,255,255,.03);color:rgba(255,255,255,.82);font-size:14px;line-height:normal;font-weight:700;cursor:pointer;transition:border-color .15s ease,color .15s ease,background .15s ease;'
  const createButtonStyle = 'box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:8px;height:42px;padding:0 20px;flex:1 1 auto;min-width:0;max-width:220px;border:1px solid rgba(244,201,91,.5);border-radius:10px;background:linear-gradient(135deg,#f6d27a 0%,#d4a520 55%,#c98f13 100%);color:#1a1200;font-size:14px;line-height:normal;font-weight:800;cursor:pointer;box-shadow:0 1px 0 rgba(255,255,255,.25) inset,0 6px 16px rgba(212,165,32,.22);white-space:nowrap;'
  // Светлият вариант — преизчислява се в началото на всеки render().
  let light = false

  function render(): void {
    pruneExpiredEffects(sharedServerClock.getServerNow())
    const isActiveTable = myTable !== null && myTable.phase !== 'lobby'
    light = !isActiveTable && options.root.closest('[data-lobby-member-mobile-light="1"]') !== null
    ensureTick()
    const body = myTable ? (myTable.phase === 'lobby' ? renderWaiting(myTable) : renderActiveTable(myTable)) : renderTableList()
    if (light) {
      options.root.innerHTML = `<section data-svara-lobby="1" data-svara-light="1" style="background:transparent;color:#111827;font-family:inherit;box-sizing:border-box;padding:0;overflow-x:hidden;">
        ${renderLightActionRow()}
        ${message ? `<div data-svara-lobby-message="1" role="status" style="${LIGHT_MESSAGE_STYLE}margin-bottom:12px;padding:10px 12px;border-radius:10px;font-size:13.5px;font-weight:700;line-height:1.4;overflow-wrap:anywhere;">${esc(message)}</div>` : ''}
        ${body}
        ${createOpen ? renderCreateModal() : ''}
      </section>`
      createDialogElement?.remove()
      createDialogElement = options.root.querySelector<HTMLDialogElement>('dialog[data-svara-create-backdrop]')
      if (createDialogElement) document.body.appendChild(createDialogElement)
      wire()
      ensureResultFrame()
      syncTableMotion()
      return
    }
    // Активната маса получава по-широк контейнер (нужно за landscape/desktop
    // без прекомерно разтягане, виж заданието §11/§12) — списъкът/чакащата
    // маса остават в по-тесния 860px panel layout от 2Б.3.7.2.
    const flashes = Array.from(options.root.querySelectorAll<HTMLElement>('[data-svara-bet-flash]'))
    // Активната маса заема цялата налична ширина (сукното е без рамка, като
    // в Белот); списъкът/чакащата маса остават в 860px panel layout.
    // Предигровите екрани следват структурата на „Не се сърди човече“
    // (createLudoLobbyController, тъмният вариант): голям банер, 920px
    // центриран контейнер, ред „Назад“ / „+ Създай игра“, раздел „Чакащи“.
    const html = isActiveTable
      ? `<section data-svara-lobby="1" style="background:#030303;color:#fff;font-family:Arial,sans-serif;box-sizing:border-box;padding:0;overflow-x:hidden;">
      <div style="max-width:none;margin:0 auto;">
        ${message ? `<div style="margin-bottom:12px;color:#f4c95b;font-weight:700;">${esc(message)}</div>` : ''}
        ${body}
      </div>
      ${createOpen ? renderCreateModal() : ''}
    </section>`
      : `<section data-svara-lobby="1" class="svara-lobby-page" style="background:#030303;color:#fff;font-family:Arial,sans-serif;box-sizing:border-box;overflow-x:hidden;">
      <style>${DARK_LOBBY_CSS}</style>
      <div style="max-width:920px;margin:0 auto;">
        <div style="position:relative;border:2px solid rgba(212,165,32,0.78);border-radius:14px;overflow:hidden;line-height:0;margin-bottom:18px;background:#000000;">
          <img src="/images/games/svara-lobby-banner.webp" alt="Свара" width="1643" height="458" style="display:block;width:100%;height:auto;border-radius:12px;">
        </div>
        ${message ? `<div style="margin-bottom:14px;color:#f4c95b;">${esc(message)}</div>` : ''}
        ${renderDarkActionRow()}
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

  // Светъл ред с действия (като Ludo): „Назад“ към „Игри“ (същият
  // data-svara-back-to-games, обслужван от lobby flow controller-а) и
  // „Създай игра“, докато няма собствена маса.
  function renderLightActionRow(): string {
    const back = `<button type="button" data-svara-back-to-games="1" aria-label="Назад" style="${LIGHT_SECONDARY_BUTTON_STYLE}display:inline-flex;align-items:center;gap:6px;height:42px;padding:0 14px 0 10px;color:#344054;font-size:14px;line-height:normal;flex-shrink:0;">${backChevronSvg}<span>Назад</span></button>`
    const create = myTable || lifecycleTab !== 'waiting' ? '' : `<button type="button" data-svara-create-open="1" class="${LIGHT_PRIMARY_CLASS}" style="${LIGHT_PRIMARY_BUTTON_STYLE}display:inline-flex;align-items:center;justify-content:center;gap:8px;height:42px;padding:0 14px;flex:1 1 auto;min-width:0;font-size:14px;line-height:normal;">${createPlusSvg}<span>Създай игра</span></button>`
    return `<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:nowrap;gap:8px;margin-bottom:12px;">${back}${create}</div>`
  }

  // Тъмен ред с действия — същите стилове като „Не се сърди човече“.
  function renderDarkActionRow(): string {
    return `<div class="svara-action-row" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
      <button type="button" data-svara-back-to-games="1" aria-label="Назад" style="${backButtonStyle}flex-shrink:0;">${backChevronSvg}<span>Назад</span></button>
      ${myTable || lifecycleTab !== 'waiting' ? '' : `<button type="button" data-svara-create-open="1" style="${createButtonStyle}">${createPlusSvg}<span>Създай игра</span></button>`}
    </div>`
  }

  // Раздели „Чакащи“ / „Играещи“ / „Приключили“ — същите стилове като
  // lifecycleTabButtonHtml в createLudoLobbyController (тъмен и светъл вариант).
  // Данните: чакащи = маси във фаза lobby, играещи = in-progress (от
  // svara_tables_list), приключили = finished от сървъра (последните 2 часа).
  function lifecycleTabButtonHtml(tab: SvaraLifecycleTab, label: string, count: number): string {
    const isActive = lifecycleTab === tab
    if (light) {
      return `<button type="button" data-svara-lifecycle-tab="${tab}" data-active="${isActive ? 'true' : 'false'}" aria-selected="${isActive ? 'true' : 'false'}" style="
      flex:1 1 0;min-width:0;display:flex;align-items:center;justify-content:center;gap:4px;
      height:40px;padding:0 4px;box-sizing:border-box;border-radius:10px;
      border:1px solid ${isActive ? '#D9CCFF' : '#E4E7EC'};background:${isActive ? '#F4F0FF' : '#FFFFFF'};
      color:${isActive ? '#6941C6' : '#475467'};box-shadow:0 1px 2px rgba(16,24,40,0.05);
      font-family:inherit;font-size:12px;font-weight:800;cursor:pointer;white-space:nowrap;
    "><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;">${label}</span>
      <span style="
        flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;
        background:${isActive ? '#7950E8' : '#F2F4F7'};color:${isActive ? '#FFFFFF' : '#475467'};
        border-radius:999px;font-size:11px;font-weight:800;
      ">${count}</span>
    </button>`
    }
    return `<button type="button" data-svara-lifecycle-tab="${tab}" data-active="${isActive ? 'true' : 'false'}" aria-selected="${isActive ? 'true' : 'false'}" style="
      display:flex;align-items:center;gap:4px;min-width:0;grid-area:${tab};
      background:${isActive ? 'rgba(212,165,32,0.18)' : 'rgba(255,255,255,0.05)'};
      border:1px solid ${isActive ? 'rgba(212,165,32,0.55)' : 'rgba(255,255,255,0.1)'};
      border-radius:9px;color:${isActive ? '#f4c95b' : 'rgba(255,255,255,0.6)'};
      font-size:13px;font-weight:700;cursor:pointer;flex:1 1 auto;justify-content:center;padding:7px 4px;
    "><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;">${label}</span>
      <span style="
        display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 4px;flex-shrink:0;
        background:${isActive ? 'rgba(212,165,32,0.35)' : 'rgba(255,255,255,0.1)'};
        border-radius:999px;font-size:11px;font-weight:800;
      ">${count}</span>
    </button>`
  }

  function formatDateTime(timestampMs: number): string {
    const date = new Date(timestampMs)
    return `${date.toLocaleDateString('bg-BG', { day: '2-digit', month: '2-digit' })} ${date.toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' })}`
  }

  /** Играч в карта на играещ/приключил мач (без бутони за действие). */
  function playerChipHtml(player: { playerId: string; displayName?: string | null; avatarUrl?: string | null; isBot?: boolean }, trailing: string): string {
    const displayName = player.displayName?.trim() || 'Профилът не е достъпен'
    const avatar = player.avatarUrl
      ? `<img src="${esc(player.avatarUrl)}" alt="" draggable="false" style="width:100%;height:100%;object-fit:cover;display:block;" />`
      : `<span aria-hidden="true">${esc(displayName.charAt(0).toUpperCase())}</span>`
    const bot = player.isBot ? `<span data-svara-bot-badge="1" title="Тестов бот" style="flex-shrink:0;${light ? 'border:1px solid #B2DDFF;background:#EFF8FF;color:#175CD3;' : 'border:1px solid rgba(120,190,255,.6);color:#9fd0ff;'}border-radius:6px;padding:1px 5px;font-size:10px;font-weight:800;">БОТ</span>` : ''
    return `<div style="box-sizing:border-box;display:flex;align-items:center;gap:8px;min-width:0;${light ? 'border:1px solid #E4E7EC;border-radius:10px;background:#F9FAFB;' : 'border:1px solid rgba(255,255,255,.12);border-radius:9px;'}padding:8px 10px;">
      <span style="width:34px;height:34px;flex:0 0 34px;border-radius:9px;overflow:hidden;display:flex;align-items:center;justify-content:center;${light ? 'background:#F4F0FF;border:1px solid #D9CCFF;color:#6941C6;' : 'background:#101010;border:1px solid rgba(212,165,32,.34);color:#d4a520;'}font-size:17px;font-weight:800;">${avatar}</span>
      <span title="${esc(displayName)}" style="font-weight:700;font-size:${light ? '13px' : '12px'};${light ? 'color:#111827;' : ''}min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${esc(displayName)}</span>
      ${bot}${trailing}
    </div>`
  }

  function slotsGridStyle(): string {
    return light ? 'display:grid;grid-template-columns:minmax(0,1fr);gap:8px;' : 'display:grid;grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));gap:8px;'
  }

  function gameCardHtml(header: string, meta: string, slots: string, footer: string): string {
    return `<article style="${light ? LIGHT_PANEL_STYLE : panel}">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:12px;">
        ${header}
        <div style="${light ? LIGHT_META_STYLE : 'color:rgba(255,255,255,.62);font-size:13px;'}">${meta}</div>
      </div>
      <div style="${slotsGridStyle()}">${slots}</div>
      ${footer}
    </article>`
  }

  function playingCardHtml(table: SvaraPublicTable): string {
    const slots = table.players.map((player) => playerChipHtml(player, `<span style="font-size:11px;${light ? 'color:#667085;font-weight:600;' : 'color:rgba(255,255,255,.65);'}flex-shrink:0;">${STATUS_LABEL[player.status]}</span>`)).join('')
    return gameCardHtml(`<strong style="color:${light ? '#6941C6' : '#f4c95b'};">Играе се</strong>`, `${table.players.length} играчи · Вход ${formatAmount(table.entryFee)}`, slots, '')
  }

  function finishedCardHtml(match: SvaraFinishedMatch): string {
    const winner = match.winnerId === null ? null : match.players.find((player) => player.playerId === match.winnerId) ?? null
    const slots = match.players.map((player) => playerChipHtml(player, player.playerId === match.winnerId ? '<span aria-label="Победител" style="flex-shrink:0;">🏆</span>' : '')).join('')
    const winnerLine = winner ? `<div style="margin-top:10px;font-size:12px;font-weight:800;color:${light ? '#B54708' : '#f4c95b'};overflow-wrap:anywhere;">🏆 Победител: ${esc(winner.displayName?.trim() || 'Профилът не е достъпен')}</div>` : ''
    const footer = `${winnerLine}<div style="margin-top:10px;${light ? 'font-size:12px;font-weight:600;color:#667085;' : 'font-size:11px;color:rgba(255,255,255,.45);'}">Приключила: ${formatDateTime(match.finishedAt)}</div>`
    return gameCardHtml(`<strong style="color:${light ? '#475467' : 'rgba(255,255,255,.85)'};">Приключила</strong>`, `${match.players.length} играчи · Вход ${formatAmount(match.entryFee)}`, slots, footer)
  }

  function renderEmptyState(text: string): string {
    if (light) {
      return `<div style="${LIGHT_PANEL_STYLE}padding:28px 16px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:12px;">
        <img src="${LIGHT_EMPTY_ICON_URL}" alt="" width="64" height="64" decoding="async" style="width:64px;height:64px;display:block;object-fit:contain;opacity:.9;">
        <div style="font-size:15px;font-weight:700;color:#667085;line-height:1.45;">${esc(text)}</div>
      </div>`
    }
    return `<div style="background:linear-gradient(180deg,#0d0d0d 0%,#080808 100%);border:1px solid rgba(212,165,32,.4);border-radius:16px;padding:clamp(28px,5vw,44px) 20px;box-shadow:0 1px 0 rgba(255,255,255,.03) inset,0 14px 34px rgba(0,0,0,.35);display:flex;flex-direction:column;align-items:center;text-align:center;gap:14px;">
      <img src="${LIGHT_EMPTY_ICON_URL}" alt="" width="80" height="80" decoding="async" style="width:80px;height:80px;display:block;object-fit:contain;">
      <div style="font-size:17px;font-weight:800;color:#fff;">${esc(text)}</div>
    </div>`
  }

  function tableCardHtml(table: SvaraPublicTable): string {
    const joining = joinPendingMatchId === table.matchId
    const full = table.players.length >= table.capacity
    const disabled = joining || full
    const actionLabel = joining ? 'Влизане…' : full ? 'Пълна' : 'Влез'
    if (light) {
      return `<article style="${LIGHT_PANEL_STYLE}">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;">
        <div style="flex:1;min-width:0;">
          <strong style="display:block;min-width:0;font-size:15px;font-weight:800;line-height:1.3;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Маса ${esc(table.matchId.slice(0, 8))}</strong>
          <div style="${LIGHT_META_STYLE}margin-top:3px;">${table.players.length}/${table.capacity} · ${table.startMode === 'manual' ? 'Ръчен старт' : 'При запълване'}</div>
          ${tableAmountsHtml(table)}
        </div>
        <button type="button" data-svara-table-join="${esc(table.matchId)}" ${disabled ? 'disabled' : ''} class="${LIGHT_PRIMARY_CLASS}" style="${LIGHT_PRIMARY_BUTTON_STYLE}flex:0 0 auto;height:40px;padding:0 16px;font-size:14px;${disabled ? 'opacity:.55;cursor:not-allowed;' : ''}">${actionLabel}</button>
      </div>
    </article>`
    }
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
    const waiting = tables.filter((table) => table.phase === 'lobby')
    const playing = tables.filter((table) => table.phase === 'in-progress')
    const tabsHtml = `<div class="svara-tabs-row" style="${light ? 'display:flex;gap:6px;margin-bottom:12px;' : 'margin-bottom:16px;'}" role="tablist">
      ${lifecycleTabButtonHtml('waiting', 'Чакащи', waiting.length)}
      ${lifecycleTabButtonHtml('playing', 'Играещи', playing.length)}
      ${lifecycleTabButtonHtml('finished', 'Приключили', finishedMatches.length)}
    </div>`
    const list = (cards: string[]) => `<div style="display:grid;gap:10px;">${cards.join('')}</div>`
    const content = lifecycleTab === 'waiting'
      ? (waiting.length === 0 ? renderEmptyState('В момента няма чакащи маси за Свара.') : list(waiting.map(tableCardHtml)))
      : lifecycleTab === 'playing'
        ? (playing.length === 0 ? renderEmptyState('В момента няма играещи маси за Свара.') : list(playing.map(playingCardHtml)))
        : (finishedMatches.length === 0 ? renderEmptyState('В момента няма приключили маси за Свара.') : list(finishedMatches.map(finishedCardHtml)))
    return `${tabsHtml}${content}`
  }

  function seatSlotHtml(table: SvaraPublicTable, index: number): string {
    const player = table.players[index]
    if (!player && light) return `<div style="box-sizing:border-box;min-height:52px;border-radius:10px;border:1px dashed #D0D5DD;background:#FFFFFF;color:#667085;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;">Свободно място</div>`
    if (!player) return `<div style="box-sizing:border-box;min-height:50px;border-radius:9px;border:1px dashed rgba(255,255,255,.14);background:rgba(255,255,255,.03);color:rgba(255,255,255,.35);font-size:12px;display:flex;align-items:center;justify-content:center;">Свободно място</div>`
    const isCreator = player.playerId === table.creatorId
    const displayName = player.displayName?.trim() || 'Профилът не е достъпен'
    const avatar = player.avatarUrl
      ? `<img data-svara-player-avatar="1" src="${esc(player.avatarUrl)}" alt="" draggable="false" style="width:100%;height:100%;object-fit:cover;display:block;" />`
      : `<span data-svara-avatar-placeholder="1" aria-hidden="true">${esc(displayName.charAt(0).toUpperCase())}</span>`
    if (light) {
      return `<div data-svara-waiting-seat="${esc(player.playerId)}" style="box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0;border:1px solid #E4E7EC;border-radius:10px;background:#F9FAFB;padding:8px 10px;">
      <button type="button" data-svara-profile-id="${esc(player.playerId)}" aria-label="${esc(`Отвори профила на ${displayName}`)}" style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;border:0;padding:0;background:transparent;color:#111827;text-align:left;cursor:pointer;font:inherit;">
        <span style="width:34px;height:34px;flex:0 0 34px;border-radius:9px;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#F4F0FF;border:1px solid #D9CCFF;color:#6941C6;font-size:17px;font-weight:800;">${avatar}</span>
        <span data-svara-player-name="1" title="${esc(displayName)}" style="font-weight:700;font-size:13px;color:#111827;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(displayName)}</span>
        ${isCreator ? '<span data-svara-creator="1" aria-label="Създател на масата" style="color:#6941C6;flex-shrink:0;">★</span>' : ''}
        ${player.isBot ? '<span data-svara-bot-badge="1" title="Тестов бот" style="flex-shrink:0;border:1px solid #B2DDFF;border-radius:6px;background:#EFF8FF;padding:1px 5px;font-size:10px;font-weight:800;color:#175CD3;">БОТ</span>' : ''}
      </button>
      <span data-svara-player-status="1" style="font-size:11.5px;font-weight:600;color:#667085;flex-shrink:0;">${STATUS_LABEL[player.status]}</span>
    </div>`
    }
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

  /** Етап 3В.2: текстът на наградата във формата — само от сървърната стойност. */
  function createPrizeText(prize: number | null): string {
    if (prize === null) return ''
    return creationOptions?.paid ? `Награда за победителя: ${formatAmount(prize)} жълтици` : `Изчислена тестова награда: ${formatAmount(prize)} жълтици (не се изплаща)`
  }

  function tableAmountsHtml(table: SvaraPublicTable): string {
    // Етап 3В.2: само сървърната награда — без локален разчет.
    const prize = typeof table.prizeAmount === 'number' && Number.isSafeInteger(table.prizeAmount) && table.prizeAmount > 0 ? table.prizeAmount : null
    const coin = '<img src="/assets/lobby/icon-coin.png" alt="" aria-hidden="true" style="width:17px;height:17px;display:block;object-fit:contain;flex:0 0 auto;" />'
    if (light) {
      return `<div style="display:grid;gap:4px;margin-top:6px;font-size:12.5px;line-height:1.4;font-weight:600;color:#344054;">
      <div data-svara-waiting-entry="1" style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">Вход: <span style="display:inline-flex;align-items:center;gap:5px;">${coin}<span>${formatAmount(table.entryFee)} жълтици</span></span></div>
      ${prize === null ? '' : `<div data-svara-waiting-prize="1" style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;color:#B54708;">${table.paid ? 'Награда' : 'Тестова награда'}: <span style="display:inline-flex;align-items:center;gap:5px;">${coin}<span>${formatAmount(prize)} жълтици</span></span>${table.paid ? '' : '<span style="font-size:11px;color:#667085;">(Не се изплаща)</span>'}</div>`}
    </div>`
    }
    return `<div style="display:grid;gap:5px;margin-top:7px;font-size:13px;line-height:1.4;">
      <div data-svara-waiting-entry="1" style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">Вход: <span style="display:inline-flex;align-items:center;gap:5px;">${coin}<span>${formatAmount(table.entryFee)} жълтици</span></span></div>
      ${prize === null ? '' : `<div data-svara-waiting-prize="1" style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;color:#f4c95b;">${table.paid ? 'Награда' : 'Тестова награда'}: <span style="display:inline-flex;align-items:center;gap:5px;">${coin}<span>${formatAmount(prize)} жълтици</span></span>${table.paid ? '' : '<span style="font-size:11px;color:rgba(255,255,255,.65);">(Не се изплаща)</span>'}</div>`}
    </div>`
  }

  function renderWaiting(table: SvaraPublicTable): string {
    const isHost = table.creatorId === options.localProfileId
    const canManualStart = table.startMode === 'manual' && table.players.length === table.capacity
    const slotsHtml = Array.from({ length: table.capacity }, (_, index) => seatSlotHtml(table, index)).join('')
    if (light) {
      return `<div data-svara-waiting="1" style="${LIGHT_PANEL_STYLE}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:14px;">
        <div style="flex:1;min-width:0;"><strong style="font-size:15px;font-weight:800;color:#17233C;">Чакаща маса</strong><div data-svara-waiting-capacity="1" style="${LIGHT_META_STYLE}margin-top:3px;">${table.players.length}/${table.capacity} · ${table.startMode === 'manual' ? 'Ръчен старт' : 'При запълване'}</div>${tableAmountsHtml(table)}</div>
        <button type="button" data-svara-table-leave="1" ${leavePending ? 'disabled' : ''} style="${LIGHT_DANGER_BUTTON_STYLE}flex:0 0 auto;height:40px;padding:0 14px;font-size:14px;${leavePending ? 'opacity:.55;cursor:wait;' : ''}">${leavePending ? 'Напускане…' : 'Напусни'}</button>
      </div>
      <div style="display:grid;grid-template-columns:minmax(0,1fr);gap:8px;">${slotsHtml}</div>
      ${table.startMode === 'manual' && isHost ? `<button type="button" data-svara-table-start="1" ${canManualStart ? '' : 'disabled'} class="${LIGHT_PRIMARY_CLASS}" style="${LIGHT_PRIMARY_BUTTON_STYLE}width:100%;height:44px;margin-top:14px;font-size:15px;${canManualStart ? '' : 'opacity:.55;cursor:not-allowed;'}">Старт</button>` : ''}
      ${table.testBotFill === true && isHost && options.onFillWithBots ? `<button type="button" data-svara-table-fill-bots="1" ${fillBotsPending ? 'disabled' : ''} style="${LIGHT_SECONDARY_BUTTON_STYLE}width:100%;height:42px;margin-top:10px;border-color:#B2DDFF;color:#175CD3;font-size:14px;${fillBotsPending ? 'opacity:.55;cursor:wait;' : ''}">${fillBotsPending ? 'Запълване…' : 'Запълни с ботове'}</button><div style="margin-top:6px;font-size:11px;font-weight:600;color:#667085;text-align:center;">Само за локално тестване</div>` : ''}
    </div>`
    }
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
      reducedMotion: false,
      decisionPending: actionPending || (pendingDecision !== null && pendingDecision.key === currentDecision()?.key),
      decisionMessage: message,
      settingsOpen,
      exitConfirmOpen,
      gameSoundsEnabled: isGameSoundsEnabled(),
    }
  }

  function syncTableMotion(): void {
    const host = options.root.querySelector<HTMLElement>('[data-svara-scene-host]')
    if (!myTable || myTable.phase === 'lobby' || !snapshot || snapshot.matchId !== myTable.matchId || !host) { tableScene.reset(); return }
    const serverNow = sharedServerClock.getServerNow()
    const liveTiming = timing?.matchId === snapshot.matchId ? timing : null
    const tableInput = activeTableInput(myTable)
    tableScene.update(host, {
      snapshot, timing: liveTiming, serverNow, localProfileId: options.localProfileId, animations: true, table: myTable,
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
    for (const name of ['svaraFelt', 'svaraFeltCenter', 'svaraResultOverlay', 'svaraResultBanner', 'svaraDiagnostics', 'svaraActionBar', 'svaraDecisionMount', 'svaraTopBar', 'svaraSettingsMount', 'svaraExitConfirmMount'] as const) {
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

  // Звукът на чиповете е в сцената, при КАЦАНЕТО им (svaraRealScene.ts:
  // betChipsWithLandingSound — играч → банка; payout — банка → спечелил).

  // Последното „Плати“, приключило наддаването направо в сравняване (виж
  // detectSvaraFinalCall): „+N“ и звукът както при всяко „Плати“; чиповете
  // ги пуска сцената (там е и редът спрямо обръщането на картите).
  let previousSnapshotForBets: SvaraMatchSnapshotMessage | null = null
  const finalCallsShown = new Set<string>()
  function flushFinalCall(): void {
    const prev = previousSnapshotForBets
    previousSnapshotForBets = snapshot
    const finalCall = detectSvaraFinalCall(prev, snapshot)
    if (!finalCall || !snapshot || finalCallsShown.has(`${snapshot.matchId}:${finalCall.roundId}`)) return
    finalCallsShown.add(`${snapshot.matchId}:${finalCall.roundId}`)
    const seat = snapshot.seats.find((s) => s.playerId === finalCall.playerId)
    if (seat) playBetFlash(seat.seatIndex, finalCall.added)
    if (seat && finalCall.allIn) announceAllIn(seat.seatIndex, finalCall.added)
    else if (seat && finalCall.call) announcePay(seat.seatIndex, finalCall.added)
  }

  // „Плати“ (call, без повишаване): гласът „Плащам!“, балончето „Плащам N“ и
  // „+N“ над банката (същото като при „Вдигам“) тръгват заедно; N е реално
  // внесеното с това действие. Вика се само за
  // нови действия (виж betAnimationTracker / finalCallsShown) — без повторение
  // при reconnect или дублиран snapshot.
  // Полът на профила на играча на това място (както в Белот: от сървърните
  // данни на профила, ботовете вкл.); без пол → мъжкият запис.
  function seatVoiceGender(seatIndex: number): PlayerGender | null {
    const playerId = snapshot?.seats.find((s) => s.seatIndex === seatIndex)?.playerId
    return playerId ? myTable?.players.find((p) => p.playerId === playerId)?.gender ?? null : null
  }

  function announcePay(seatIndex: number, added: number): void {
    tableScene.showSpeech(seatIndex, `Плащам ${formatAmount(added)}`)
    tableScene.showPotRaise(formatAmount(added))
    playSvaraPayVoice(seatVoiceGender(seatIndex))
  }

  // „Заложи“ или ×N при първо откриване на светло (виж isSvaraOpeningPay): гласът
  // „Залагам!“, балончето „Залагам N“ и „+N“ над банката; N = реално внесеното.
  function announceOpeningBet(seatIndex: number, added: number): void {
    tableScene.showSpeech(seatIndex, `Залагам ${formatAmount(added)}`)
    tableScene.showPotRaise(formatAmount(added))
    playSvaraBetVoice(seatVoiceGender(seatIndex))
  }

  // Реален Ол-ин (действието изразходва цялата наличност — сървърният флаг
  // allIn или бутонът Ол-ин): гласът „Ол-ин!“, балончето „ОЛ-ИН!“ и „+N“ над
  // банката (N = реално внесеното). С приоритет пред „Залагам“, „Вдигам“,
  // „Плащам“ и „Тъмни“ — вместо тях, не заедно с тях.
  function announceAllIn(seatIndex: number, added: number): void {
    tableScene.showSpeech(seatIndex, 'ОЛ-ИН!')
    tableScene.showPotRaise(formatAmount(added))
    playSvaraAllInVoice(seatVoiceGender(seatIndex))
  }

  // Повишаване (обикновен залог над текущия, вкл. ×5/×10/×20/×50, но не
  // първото откриване на светло — то е „Залагам“): гласът
  // „Вдигам!“, балончето „Вдигам +N“ и „+N“ над банката тръгват заедно.
  // N = увеличението на текущия залог (новото ниво минус предишното), не
  // внесената сума. Видовете повишаване — виж svaraRaiseAmount (обикновен
  // залог, Ол-ин и на тъмно над текущия залог); „Плати“ (call) не е.
  //
  // Залог на тъмно (blind-bet или Ол-ин без поглеждане) — вместо „Вдигам“: гласът „Тъмни!“ и балончето
  // „Тъмни N“ (N = реално внесеното с действието), а „+N“ над банката само
  // ако реално вдига текущия залог (N там = увеличението, като при „Вдигам“).
  function announceRaiseIfAny(seatIndex: number, entry: SvaraNewBetEntry): void {
    const amount = svaraRaiseAmount(entry)
    // Ол-ин без поглеждане: сървърът го записва с blind: true (само тогава).
    if (entry.kind === 'blind-bet' || (entry.kind === 'all-in' && entry.blind)) {
      tableScene.showSpeech(seatIndex, `Тъмни ${formatAmount(entry.added)}`)
      if (amount !== null) tableScene.showPotRaise(formatAmount(amount))
      playSvaraBlindVoice(seatVoiceGender(seatIndex))
      return
    }
    if (amount === null) return
    const raise = formatAmount(amount)
    tableScene.showSpeech(seatIndex, `Вдигам +${raise}`)
    tableScene.showPotRaise(raise)
    playSvaraRaiseVoice(seatVoiceGender(seatIndex))
  }

  function flushBetAnimations(): void {
    if (snapshot) { preloadSvaraPayVoice(); preloadSvaraFoldVoice(); preloadSvaraLookVoice() }
    flushFinalCall()
    const round = snapshot?.round ?? null
    const newEntries = betAnimationTracker.detectNewEntries(round)
    if (newEntries.length === 0 || !snapshot) return
    for (const entry of newEntries) {
      const seat = snapshot.seats.find((s) => s.playerId === entry.playerId)
      if (seat) playBetFlash(seat.seatIndex, entry.added)
      if (seat && (entry.allIn || entry.kind === 'all-in')) { announceAllIn(seat.seatIndex, entry.added); continue }
      if (seat && entry.kind === 'call') announcePay(seat.seatIndex, entry.added)
      if (seat) announceRaiseIfAny(seat.seatIndex, entry)
      // Първо откриване на светло („Заложи“ или ×N при текущ залог 0): не е
      // „Вдигам“ и не е „Плащам“ — балонче „Залагам N“, „+N“ и глас „Залагам!“.
      if (seat && isSvaraOpeningPay(entry)) announceOpeningBet(seat.seatIndex, entry.added)
    }
    tableScene.onBets(newEntries.flatMap((entry) => {
      const seat = snapshot?.seats.find((s) => s.playerId === entry.playerId)
      return seat ? [{ seatIndex: seat.seatIndex, added: entry.added }] : []
    }))
    syncTableMotion()
  }

  // Задание §9/§10/§11/§13/§14 — открива РЕАЛНО нови (неанимирани досега)
  // откази/поглеждания спрямо последния snapshot и стартира съответния
  // ефект, анкетиран към сървърното "сега" в момента на откриване. Baseline
  // при първо виждане на даден roundId (reconnect/remount) никога не
  // анимира тук — виж самите tracker файлове. Гласът „Бягам!“ се пуска
  // ТОЧНО за доброволните откази, никога за forced-fold (задание §13).
  // Доброволно „Бягам“: гласът „Бягам!“ и балончето „Бягам!“ (балончето от
  // Белот, като при „Плащам“/„Вдигам“) тръгват заедно; без „+N“ над банката.
  // Само за нови откази — без повторение при reconnect/дублиран snapshot.
  const finalFoldsShown = new Set<string>()
  // „Виж“ на всеки играч — по изричното сървърно събитие 'svara_player_looked'
  // (праща се само след успешна команда look, след snapshot-а със същата
  // revision; не се повтаря при reconnect). Гласът „Поглеждам!“ и балончето
  // „Поглеждам!“ тръгват заедно; без „+N“. Обръщането на картите не се пипа.
  const looksShown = new Set<string>()
  function announceLook(event: SvaraPlayerLookedMessage): void {
    if (!snapshot || snapshot.matchId !== event.matchId || event.revision < snapshot.revision) return
    const key = `${event.matchId}:${event.revision}:${event.playerId}`
    if (looksShown.has(key)) return
    looksShown.add(key)
    const seat = snapshot.seats.find((s) => s.playerId === event.playerId)
    if (!seat) return
    tableScene.showSpeech(seat.seatIndex, 'Поглеждам!')
    playSvaraLookVoice(seatVoiceGender(seat.seatIndex))
  }
  function announceFold(seatIndex: number): void {
    tableScene.showSpeech(seatIndex, 'Бягам!')
    playSvaraFoldVoice(seatVoiceGender(seatIndex))
  }

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
        if (fold.voluntary) announceFold(seat.seatIndex)
      }
    }
    // Последното „Бягам“ (наддаването приключва направо в „Покажи/Скрий“ или
    // сравняване). previousSnapshotForBets все още е предишният snapshot —
    // обновява се след това във flushFinalCall (виж setSnapshot).
    const finalFold = detectSvaraFinalFold(previousSnapshotForBets, snapshot)
    if (finalFold && !finalFoldsShown.has(`${snapshot.matchId}:${finalFold.roundId}`)) {
      finalFoldsShown.add(`${snapshot.matchId}:${finalFold.roundId}`)
      const seat = snapshot.seats.find((s) => s.playerId === finalFold.playerId)
      if (seat) announceFold(seat.seatIndex)
    }
    const newLook = lookAnimationTracker.detectNewLook(round?.roundId ?? null, snapshot.you.looked)
    if (newLook) { activeLookEffectStartedAtServerMs = sharedServerClock.getServerNow(); tableScene.onLook() }
    if (newFolds.length > 0 || newLook) render()
  }

  // Светлият вариант на „Създай игра“ (като светлото Ludo): същата форма,
  // същите data-атрибути и обработчици — различен е само видът. Диалогът се
  // мести в document.body (извън рамката), затова шрифтът е зададен изрично.
  function renderLightCreateModal(): string {
    const labelStyle = 'display:grid;gap:6px;margin-bottom:14px;min-width:0;font-size:13px;font-weight:700;color:#17233C;'
    const choiceStyle = 'display:flex;align-items:center;gap:10px;min-height:44px;padding:0 12px;box-sizing:border-box;border:1px solid #D0D5DD;border-radius:10px;background:#FFFFFF;font-size:14px;font-weight:700;color:#111827;cursor:pointer;'
    const radioStyle = 'width:18px;height:18px;margin:0;flex-shrink:0;accent-color:#7950E8;cursor:pointer;'
    const cancel = `<button type="button" data-svara-create-close="1" style="${LIGHT_SECONDARY_BUTTON_STYLE}height:44px;color:#344054;font-size:14px;">Отказ</button>`
    const entry = creationOptions?.entries.find((option) => option.entryFee === createDraft.entryFee)
    // Етап 3В.2: наградата идва от сървъра (prizeByCapacity) — без локален разчет.
    const createPrize = entry?.prizeByCapacity?.[createDraft.capacity as 2 | 3 | 4] ?? null
    const content = entry && creationOptions ? `<form data-svara-create-form="1">
      <label style="${labelStyle}">Брой играчи<select name="capacity" style="${LIGHT_FIELD_STYLE}">${[2, 3, 4].map((count) => `<option value="${count}" ${count === createDraft.capacity ? 'selected' : ''}>${count}</option>`).join('')}</select></label>
      <label style="${labelStyle}">Вход<select name="entryFee" style="${LIGHT_FIELD_STYLE}">${creationOptions.entries.map((option) => `<option value="${option.entryFee}" ${option.entryFee === createDraft.entryFee ? 'selected' : ''}>${formatAmount(option.entryFee)} жълтици</option>`).join('')}</select></label>
      <div style="display:grid;gap:4px;margin:0 0 16px;padding:10px 12px;border:1px solid #E4E7EC;border-radius:10px;background:#F9FAFB;font-size:13px;font-weight:600;line-height:1.4;color:#344054;" aria-live="polite">
        <div data-svara-create-chips="1">Получаваш: ${formatAmount(entry.startingChips)} виртуални чипа</div>
        <div data-svara-create-ante="1">Анте за раздаване: ${formatAmount(entry.entryChips)} чипа</div>
        <div data-svara-create-prize="1" style="color:#B54708;" ${createPrize === null ? 'hidden' : ''}>${createPrizeText(createPrize)}</div>
      </div>
      <fieldset style="border:0;padding:0;margin:0 0 18px;display:grid;gap:8px;min-width:0;"><legend style="padding:0;margin-bottom:6px;font-size:13px;font-weight:700;color:#17233C;">Старт</legend><label style="${choiceStyle}"><input type="radio" name="startMode" value="auto" ${createDraft.startMode === 'auto' ? 'checked' : ''} style="${radioStyle}"> При запълване</label><label style="${choiceStyle}"><input type="radio" name="startMode" value="manual" ${createDraft.startMode === 'manual' ? 'checked' : ''} style="${radioStyle}"> Ръчен старт</label></fieldset>
      <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;">${cancel}<button type="submit" class="${LIGHT_PRIMARY_CLASS}" style="${LIGHT_PRIMARY_BUTTON_STYLE}height:44px;font-size:15px;">Създай</button></div>
    </form>` : `<p role="status" style="margin:0 0 16px;font-size:14px;font-weight:600;color:#667085;">${creationLoading ? 'Зареждане на настройките…' : 'Настройките за създаване не са достъпни. Опитай отново.'}</p>
      <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;">${cancel}${creationLoading ? '' : `<button type="button" data-svara-create-retry="1" style="${LIGHT_SECONDARY_BUTTON_STYLE}height:44px;font-size:14px;">Опитай отново</button>`}</div>`
    return `<dialog data-svara-create-backdrop="1" aria-labelledby="svara-create-title" style="position:fixed;inset:0;margin:0;border:0;width:100vw;height:100dvh;max-width:none;max-height:none;box-sizing:border-box;background:rgba(16,24,40,0.45);color:#111827;font-family:${LIGHT_FONT_FAMILY};font-size:16px;display:grid;place-items:center;padding:16px;"><div data-svara-create-panel="1" style="width:min(100%,420px);max-width:100%;min-width:0;max-height:calc(100dvh - 32px);overflow-y:auto;overscroll-behavior:contain;box-sizing:border-box;padding:20px;background:#FFFFFF;border:1px solid #E4E7EC;border-radius:16px;box-shadow:0 20px 48px rgba(16,24,40,0.18);color:#111827;">
      <h2 id="svara-create-title" style="margin:0 0 16px;letter-spacing:0;color:#17233C;font-size:20px;font-weight:800;line-height:1.2;">Създай игра</h2>${content}</div></dialog>`
  }

  function renderCreateModal(): string {
    if (light) return renderLightCreateModal()
    // Match Ludo's dialog dimensions/styles without changing its component.
    const modalButton = `${button}min-height:42px;`
    const selectStyle = 'width:100%;max-width:100%;min-width:0;box-sizing:border-box;min-height:42px;background:#111;color:#fff;border:1px solid #555;border-radius:7px;padding:0 10px;'
    const entry = creationOptions?.entries.find((option) => option.entryFee === createDraft.entryFee)
    // Етап 3В.2: наградата идва от сървъра (prizeByCapacity) — без локален разчет.
    const createPrize = entry?.prizeByCapacity?.[createDraft.capacity as 2 | 3 | 4] ?? null
    const content = entry && creationOptions ? `<form data-svara-create-form="1">
      <label style="display:grid;gap:7px;margin-bottom:14px;min-width:0;">Брой играчи<select name="capacity" style="${selectStyle}">${[2, 3, 4].map((count) => `<option value="${count}" ${count === createDraft.capacity ? 'selected' : ''}>${count}</option>`).join('')}</select></label>
      <label style="display:grid;gap:7px;margin-bottom:14px;min-width:0;">Вход<select name="entryFee" style="${selectStyle}">${creationOptions.entries.map((option) => `<option value="${option.entryFee}" ${option.entryFee === createDraft.entryFee ? 'selected' : ''}>${formatAmount(option.entryFee)} жълтици</option>`).join('')}</select></label>
      <div style="display:grid;gap:4px;margin:0 0 18px;font-size:13px;line-height:1.4;color:#f4c95b;" aria-live="polite">
        <div data-svara-create-chips="1">Получаваш: ${formatAmount(entry.startingChips)} виртуални чипа</div>
        <div data-svara-create-ante="1">Анте за раздаване: ${formatAmount(entry.entryChips)} чипа</div>
        <div data-svara-create-prize="1" ${createPrize === null ? 'hidden' : ''}>${createPrizeText(createPrize)}</div>
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
    // Етап 4В: входовете са от сървъра (админ може да изключи 5 000) — ако
    // избраният го няма, се избира първият разрешен, без твърдо зададен списък.
    if (result && result.entries.length > 0 && !result.entries.some((entry) => entry.entryFee === createDraft.entryFee)) {
      dialogState.draft = createDraft = { ...createDraft, entryFee: result.entries[0]!.entryFee }
    }
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
    options.root.querySelectorAll<HTMLElement>('[data-svara-lifecycle-tab]').forEach((el) => on(el, 'click', () => {
      const tab = el.dataset.svaraLifecycleTab
      if ((tab === 'waiting' || tab === 'playing' || tab === 'finished') && tab !== lifecycleTab) { lifecycleTab = tab; render() }
    }))
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
    // Активна маса: иконата за изход първо иска потвърждение; в чакалнята
    // („Напусни“) напускането е веднага, както досега.
    on(options.root.querySelector('[data-svara-table-leave]'), 'click', () => {
      if (myTable && myTable.phase !== 'lobby') { if (!leavePending) { settingsOpen = false; setExitConfirmOpen(true) } } else requestExit()
    })
    on(options.root.querySelector('[data-svara-exit-cancel]'), 'click', () => { if (!leavePending) setExitConfirmOpen(false) })
    on(options.root.querySelector('[data-svara-exit-confirm-backdrop]'), 'click', (event) => {
      if (event.target === event.currentTarget && !leavePending) setExitConfirmOpen(false)
    })
    // „Напусни“ — съществуващата логика; requestExit() пази от двойно изпращане (leavePending).
    on(options.root.querySelector('[data-svara-exit-confirm]'), 'click', () => requestExit())
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
      // Етап 3В.2: сървърната награда за избрания брой играчи (без локален разчет).
      const serverPrize = entry.prizeByCapacity?.[capacity as 2 | 3 | 4] ?? null
      if (prize instanceof HTMLElement) { prize.textContent = createPrizeText(serverPrize); prize.hidden = serverPrize === null }
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
    on(options.root.querySelector('[data-svara-settings-toggle]'), 'click', () => setSettingsOpen(!settingsOpen))
    on(options.root.querySelector('[data-svara-settings-close]'), 'click', () => setSettingsOpen(false))
    on(options.root.querySelector('[data-svara-settings-backdrop]'), 'click', () => setSettingsOpen(false))
    // Общата настройка „Звуци в играта“ (запазва се в gameSoundSettings.ts;
    // изключването спира и вече звучащите игрови звуци).
    on(options.root.querySelector('[data-svara-sounds-toggle]'), 'click', () => { setGameSoundsEnabled(!isGameSoundsEnabled()); render() })
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
  // Escape затваря потвърждението за напускане (освен докато напускането тече).
  function handleExitConfirmKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && exitConfirmOpen && !leavePending) setExitConfirmOpen(false)
  }
  document.addEventListener('keydown', handleExitConfirmKeydown)

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
    setTables(next: SvaraPublicTable[], finished?: SvaraFinishedMatch[]) {
      tables = next
      if (finished) finishedMatches = finished
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
      if (table?.matchId !== myTable?.matchId) { settingsOpen = false; exitConfirmOpen = false }
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
    onPlayerLooked(event: SvaraPlayerLookedMessage) { announceLook(event) },
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
    /** Пренася се през принудителен remount (виж lobby flow controller-а). */
    getMyTable(): SvaraPublicTable | null { return myTable },
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
      document.removeEventListener('keydown', handleExitConfirmKeydown)
      if (fullscreenSupported && document.fullscreenElement === tableElementRef && tableElementRef !== null) {
        void document.exitFullscreen().catch(() => {})
      }
      options.root.innerHTML = ''
    },
  }
}
