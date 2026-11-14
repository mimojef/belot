// Гласов чат — интерфейс: мобилно (Етап 4) и desktop (Етап 5).
//
// Само визуализация върху съществуващия VoiceController (без дублирана
// логика): чете snapshot-а и вика действията му. Desktop използва СЪЩИТЕ
// компоненти (лента, панел, прозорец, индикатор) — различни са само темата
// (черно-златиста) и позиционирането:
//   * игра: бутон 52px веднага след ⚙️ в долния ляв flex
//     ([data-active-room-desktop-action-bar]); без лентата (край на мача) —
//     на същото място, самостоятелно; панелът се отваря над бутона;
//   * чакалня: тъмна лента, панел под лентата, тъмен прозорец за включване.
// Мобилно — елементите живеят в document.body (fixed), извън innerHTML
// прерисуванията на екраните:
//   * чакалня: лента „Гласов чат“ (host в чакалнята) + прозорец за включване
//     веднъж за посещение (2.5) + светъл панел;
//   * игра: кръгъл 40px бутон вляво от „Фрази“ (отваря панела, НЕ превключва
//     микрофона) + тъмен панел над долната лента с прозрачен backdrop (първият
//     tap извън панела само го затваря — без tap-through към картите);
//   * говорещи: един <style> (voiceSpeakingIndicator) — без прерисуване.
// В игра няма автоматични прозорци (2.5: нищо модално по време на хода).

import type { VoiceController, VoiceSnapshot } from '../createVoiceController'
import type { VoiceOwnVipStatus } from '../voiceOwnVipStatus'
import type { VoiceSpeakPreview } from '../voiceSpeakPreview'
import { resolveVoiceJoinOffer, type VoiceJoinOffer } from './voiceJoinOffer'
import { applyVoiceSpeakingProfiles, ensureVoiceSpeakingStyles } from './voiceSpeakingIndicator'
import { voiceIcon } from './voiceUiIcons'
import { describeVoiceStatus, isInVoice, type VoiceUiSeat, type VoiceUiTheme } from './voiceUiStatus'

/** Панелът и прозорците — lazy chunk (renderVoicePanel.ts), извън основния bundle. */
type VoicePanelView = typeof import('./renderVoicePanel')

export type VoiceMobileUiDeps = {
  voice: VoiceController
  /** Местата на масата в реда на екрана (имена/аватари от авторитетните snapshot-и). */
  getSeats: () => readonly VoiceUiSeat[]
  /** Собственият VIP статус от /api/vip/status (voiceOwnVipStatus) — НЕ profile.isVip от сесията. */
  getOwnVipStatus: () => VoiceOwnVipStatus
  /** Сървърното решение за говорене преди включване от WS snapshot-ите (voiceSpeakPreview); null = неизвестно. */
  getSpeakPreview: (voiceTableId: string) => VoiceSpeakPreview | null
  isPhoneLayout: () => boolean
  /** „Вземи VIP“ (само от чакалнята — магазинът е достъпен там). */
  onGetVip: () => void
  doc?: Document
  /** Само за тестове; по подразбиране import('./renderVoicePanel'). */
  loadPanelView?: () => Promise<VoicePanelView>
}

export type VoiceMobileUi = {
  /** След всяко рендериране на чакалнята: попълва лентата в нейния host. */
  syncWaitingStrip: (root: ParentNode) => void
  openPanel: () => void
  closePanel: () => void
  isPanelOpen: () => boolean
  /** Преизчисляване без нов snapshot от гласа (напр. зареден VIP статус). */
  refresh: () => void
  dispose: () => void
}

const STYLE_ID = 'pika-voice-mobile-ui'
const GAME_BUTTON_SELECTOR = '[data-voice-game-toggle="1"]'
const LAYER_SELECTOR = '[data-voice-panel-layer="1"]'
const PROMPT_SELECTOR = '[data-voice-prompt-layer="1"]'
const STRIP_SELECTOR = '[data-voice-waiting-strip="1"]'
const DESKTOP_SETTINGS_SELECTOR = '[data-active-room-desktop-action-bar="1"] [data-active-room-settings-button="1"]'

const EXTRA_STYLES = `
  .pvs { width:100%; min-height:52px; box-sizing:border-box; display:flex; align-items:center; gap:10px; padding:8px 10px 8px 8px; border:1px solid #D9CCFF; border-radius:12px; background:#FFFFFF; box-shadow:0 1px 2px rgba(16,24,40,0.05); font-family:inherit; text-align:left; cursor:pointer; color:#111827; -webkit-tap-highlight-color:transparent; }
  .pvs-ico { width:36px; height:36px; flex:0 0 auto; border-radius:999px; display:flex; align-items:center; justify-content:center; background:#F4F0FF; border:1px solid #D9CCFF; color:#6941C6; }
  .pvs-copy { min-width:0; flex:1 1 auto; display:flex; flex-direction:column; gap:1px; }
  .pvs-title { font-size:14px; font-weight:800; color:#17233C; line-height:1.25; }
  .pvs-sub { font-size:12px; font-weight:700; line-height:1.3; color:#667085; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .pvs-sub--ok { color:#067647; } .pvs-sub--busy { color:#B54708; } .pvs-sub--error { color:#B42318; }
  .pvs-cta { flex:0 0 auto; min-height:36px; padding:0 12px; border-radius:9px; display:inline-flex; align-items:center; font-size:13px; font-weight:800; background:#7950E8; color:#FFFFFF; }
  .pvs-cta--open { background:#F4F0FF; color:#6941C6; }
  .pvg { position:fixed; bottom:5px; right:112px; z-index:9998; width:40px; height:40px; padding:0; border:0; border-radius:50%; background:rgba(20,20,24,0.92); border:2px solid rgba(212,165,32,0.80); box-shadow:0 0 12px rgba(212,165,32,0.25), 0 6px 20px rgba(0,0,0,0.50); display:flex; align-items:center; justify-content:center; color:#F4C432; cursor:pointer; -webkit-backdrop-filter:blur(8px); backdrop-filter:blur(8px); -webkit-tap-highlight-color:transparent; }
  .pvg::before { content:''; position:absolute; inset:-3px -2px -5px -2px; }
  .pvg--idle { color:rgba(244,196,50,0.62); }
  .pvg[aria-expanded="true"] { background:rgba(212,165,32,0.22); }
  .pvl-backdrop { position:fixed; inset:0; z-index:10000; background:transparent; }
  .pvl-backdrop--light { background:rgba(16,24,40,0.28); }
  .pvl-panel { position:fixed; z-index:10001; max-height:calc(100dvh - 74px); overflow-y:auto; overscroll-behavior:contain; }
  .pvl-panel--dark { right:16px; bottom:58px; width:min(280px, calc(100vw - 32px)); }
  .pvl-panel--light { left:50%; bottom:12px; transform:translateX(-50%); width:min(400px, calc(100vw - 24px)); max-height:calc(100dvh - 24px); }
  /* Desktop (Етап 5) */
  .pvs--dark { border-color:rgba(212,165,32,0.45); background:rgba(18,18,22,0.92); color:#F8FAFC; box-shadow:none; transition:border-color 140ms ease; }
  .pvs--dark:hover { border-color:rgba(212,165,32,0.85); }
  .pvs--dark .pvs-ico { background:rgba(212,165,32,0.14); border-color:rgba(212,165,32,0.55); color:#F4C432; }
  .pvs--dark .pvs-title { color:#F8FAFC; }
  .pvs--dark .pvs-sub { color:rgba(248,250,252,0.6); }
  .pvs--dark .pvs-sub--ok { color:#4ADE80; } .pvs--dark .pvs-sub--busy { color:#FBBF24; } .pvs--dark .pvs-sub--error { color:#F87171; }
  .pvs--dark .pvs-cta { background:linear-gradient(180deg,#F4C95B 0%,#C98F13 100%); color:#080808; }
  .pvs--dark .pvs-cta--open { background:rgba(212,165,32,0.14); border:1px solid rgba(212,165,32,0.55); color:#F4C432; }
  .pvg--desktop, .pvg--desktop-free { width:52px; height:52px; right:auto; bottom:auto; flex:0 0 auto; transition:background 140ms ease, color 140ms ease; }
  .pvg--desktop { position:relative; z-index:auto; }
  .pvg--desktop-free { position:fixed; left:18px; bottom:24px; z-index:9400; }
  .pvg--desktop:hover, .pvg--desktop-free:hover { background:rgba(212,165,32,0.16); color:#FFE08A; }
  .pvg--desktop::before, .pvg--desktop-free::before { content:none; }
  .pvl-panel--desk { width:352px; max-height:calc(100dvh - 32px); }
`

export function createVoiceMobileUi(deps: VoiceMobileUiDeps): VoiceMobileUi {
  const doc = deps.doc ?? document
  const voice = deps.voice
  let panelOpen = false
  let promptOpen = false
  /** Вариантът в отворения прозорец — при промяна (напр. зареден статус) съдържанието се обновява. */
  let promptOffer: VoiceJoinOffer | null = null
  let lastScreen: VoiceSnapshot['screen'] = null
  /** Прозорецът за включване е отработен за текущото посещение на чакалнята. */
  let promptHandledThisVisit = false
  let disposed = false
  /** Заявено отваряне на панела, докато lazy chunk-ът още се зарежда. */
  let pendingOpen = false
  let view: VoicePanelView | null = null
  let viewPromise: Promise<VoicePanelView> | null = null
  const loadPanelView = deps.loadPanelView ?? (() => import('./renderVoicePanel'))

  ensureVoiceSpeakingStyles(doc)
  if (doc.getElementById(STYLE_ID) === null) {
    const style = doc.createElement('style')
    style.id = STYLE_ID
    style.textContent = EXTRA_STYLES
    doc.head.appendChild(style)
  }

  /** Един път; неуспешно зареждане не се кешира (следващият опит зарежда наново). */
  function loadView(): Promise<VoicePanelView> {
    viewPromise ??= loadPanelView().then(
      (module) => {
        module.ensureVoicePanelStyles(doc)
        view = module
        return module
      },
      (error: unknown) => {
        viewPromise = null
        throw error
      },
    )
    return viewPromise
  }

  const isDesktop = (): boolean => !deps.isPhoneLayout()
  /** Преди включване: последното сървърно решение от WS snapshot-ите (в гласа — това на контролера). */
  const preJoinSpeakOf = (snapshot: VoiceSnapshot): VoiceSpeakPreview | null =>
    snapshot.voiceTableId === null || isInVoice(snapshot) ? null : deps.getSpeakPreview(snapshot.voiceTableId)
  const joinOfferOf = (snapshot: VoiceSnapshot): VoiceJoinOffer =>
    resolveVoiceJoinOffer(preJoinSpeakOf(snapshot) ?? snapshot.speak, deps.getOwnVipStatus())
  /** Мобилно: игра — тъмна, чакалня — светла. Desktop: навсякъде черно-златиста. */
  const themeFor = (snapshot: VoiceSnapshot): VoiceUiTheme | null =>
    snapshot.voiceTableId === null ? null
      : snapshot.screen === 'game' ? 'dark'
        : snapshot.screen === 'waiting' ? (isDesktop() ? 'dark' : 'light') : null

  /** Desktop: панелът е закотвен към бутона (игра) или към лентата (чакалня). */
  function positionDesktopPanel(panel: HTMLElement, snapshot: VoiceSnapshot): void {
    const width = 352
    const viewportWidth = doc.documentElement.clientWidth
    const viewportHeight = doc.documentElement.clientHeight
    const clampLeft = (left: number) => Math.max(16, Math.min(left, viewportWidth - width - 16))
    const anchor = snapshot.screen === 'game'
      ? doc.querySelector<HTMLElement>(GAME_BUTTON_SELECTOR)
      : doc.querySelector<HTMLElement>(`${STRIP_SELECTOR} .pvs`)
    const rect = anchor?.getBoundingClientRect() ?? null
    let style: string
    if (rect === null || rect.width === 0) {
      style = `left:50%;top:50%;transform:translate(-50%,-50%);`
    } else if (snapshot.screen === 'game') {
      style = `left:${clampLeft(rect.left)}px;bottom:${Math.max(16, viewportHeight - rect.top + 10)}px;`
    } else {
      style = `left:${clampLeft(rect.right - width)}px;top:${Math.min(rect.bottom + 8, viewportHeight - 120)}px;`
    }
    if (panel.dataset.position !== style) {
      panel.dataset.position = style
      panel.setAttribute('style', style)
    }
  }

  // ─── Действия (делегирано) ──────────────────────────────────────────

  function runAction(action: string): void {
    switch (action) {
      case 'open-panel': openPanel(); return
      case 'close': closePanel(); return
      case 'join-mic': closePrompt(true); voice.joinWithMicrophone(); return
      case 'join-listen': closePrompt(true); voice.joinAsListener(); return
      case 'not-now': closePrompt(true); voice.notNow(); return
      case 'mic-on': voice.enableMicrophone(); return
      case 'mic-off': voice.disableMicrophone(); return
      case 'retry-mic': voice.retryMicrophone(); return
      case 'retry-connection': voice.retryConnection(); return
      case 'unlock-audio': voice.unlockAudio(); return
      case 'leave': voice.leaveVoice(); return
      case 'get-vip':
        closePrompt(true)
        closePanel()
        deps.onGetVip()
        return
    }
  }

  function onDelegatedClick(event: Event): void {
    const target = event.target as Element | null
    if (target === null) return
    const muteToggle = target.closest<HTMLElement>('[data-voice-mute-toggle]')
    if (muteToggle !== null) {
      const profileId = muteToggle.getAttribute('data-voice-mute-toggle') ?? ''
      const participant = voice.getSnapshot().participants.find((p) => p.profileId === profileId)
      if (participant?.locallyMuted) voice.unmuteRemoteParticipant(profileId)
      else voice.muteRemoteParticipant(profileId)
      return
    }
    const actionElement = target.closest<HTMLElement>('[data-voice-action]')
    if (actionElement !== null && !(actionElement as HTMLButtonElement).disabled) runAction(actionElement.getAttribute('data-voice-action') ?? '')
  }

  // ─── Панел ──────────────────────────────────────────────────────────

  function renderPanelInto(layer: HTMLElement, snapshot: VoiceSnapshot, theme: VoiceUiTheme): void {
    if (view === null) return
    const html = view.renderVoicePanel({
      snapshot,
      seats: deps.getSeats(),
      theme,
      joinOffer: joinOfferOf(snapshot),
      preJoinSpeak: preJoinSpeakOf(snapshot),
      // Магазинът е достъпен от чакалнята (мобилно и desktop), не в активна игра.
      canOpenShop: snapshot.screen === 'waiting',
    })
    const panel = layer.querySelector<HTMLElement>('.pvl-panel')
    if (panel === null) return
    const placement = isDesktop() ? 'desk' : theme
    if (panel.dataset.placement !== placement) {
      panel.dataset.placement = placement
      panel.className = `pvl-panel pvl-panel--${placement}`
      panel.removeAttribute('style')
      delete panel.dataset.position
      layer.querySelector<HTMLElement>('.pvl-backdrop')!.className = `pvl-backdrop pvl-backdrop--${placement}`
    }
    if (panel.innerHTML !== html) panel.innerHTML = html
    if (placement === 'desk') positionDesktopPanel(panel, snapshot)
  }

  function openPanel(): void {
    if (disposed) return
    const snapshot = voice.getSnapshot()
    const theme = themeFor(snapshot)
    if (theme === null) return
    if (view === null) {
      // Обикновено вече е зареден (prefetch на гласова маса); иначе — веднага след зареждането.
      pendingOpen = true
      void loadView().then(() => {
        if (pendingOpen && !disposed) {
          pendingOpen = false
          openPanel()
        }
      }, () => { pendingOpen = false })
      return
    }
    pendingOpen = false
    closePrompt(true)
    let layer = doc.querySelector<HTMLElement>(LAYER_SELECTOR)
    if (layer === null) {
      layer = doc.createElement('div')
      layer.setAttribute('data-voice-panel-layer', '1')
      layer.innerHTML = '<div class="pvl-backdrop" data-voice-action="close"></div><div class="pvl-panel"></div>'
      layer.addEventListener('click', onDelegatedClick)
      doc.body.appendChild(layer)
    }
    panelOpen = true
    renderPanelInto(layer, snapshot, theme)
    syncGameButton(snapshot)
  }

  function closePanel(): void {
    panelOpen = false
    pendingOpen = false
    doc.querySelector(LAYER_SELECTOR)?.remove()
    syncGameButton(voice.getSnapshot())
  }

  // ─── Прозорец за включване (само чакалня) ───────────────────────────

  function closePrompt(handled: boolean): void {
    if (handled) promptHandledThisVisit = true
    promptOpen = false
    promptOffer = null
    doc.querySelector(PROMPT_SELECTOR)?.remove()
  }

  function syncPrompt(snapshot: VoiceSnapshot): void {
    const eligible = snapshot.voiceTableId !== null && snapshot.screen === 'waiting' && snapshot.status === 'idle'
      && !promptHandledThisVisit && !panelOpen
    if (!eligible) {
      if (promptOpen) closePrompt(false)
      return
    }
    // Неизвестният VIP статус НЕ е „без VIP“: прозорецът изчаква (без грешен
    // първи кадър). Вече отворен прозорец остава с последния известен вариант.
    const offer = joinOfferOf(snapshot)
    if (offer === 'pending') return
    if (view === null) {
      // Lazy chunk-ът още се зарежда — прозорецът се показва веднага след него (ако още е уместен).
      void loadView().then(() => { if (!disposed) syncPrompt(voice.getSnapshot()) }, () => {})
      return
    }
    const html = view.renderVoiceJoinPrompt({ offer, canOpenShop: true, theme: isDesktop() ? 'dark' : 'light' })
    const existing = promptOpen ? doc.querySelector<HTMLElement>(PROMPT_SELECTOR) : null
    if (existing !== null) {
      if (promptOffer !== offer) {
        existing.innerHTML = html
        promptOffer = offer
      }
      return
    }
    const layer = doc.createElement('div')
    layer.setAttribute('data-voice-prompt-layer', '1')
    layer.innerHTML = html
    layer.addEventListener('click', (event) => {
      if (event.target === layer.firstElementChild) {
        closePrompt(true)
        voice.notNow()
        return
      }
      onDelegatedClick(event)
    })
    doc.body.appendChild(layer)
    promptOpen = true
    promptOffer = offer
  }

  // ─── Бутон в игра ───────────────────────────────────────────────────

  function gameButtonIcon(snapshot: VoiceSnapshot, size: number): { html: string; idle: boolean } {
    if (!isInVoice(snapshot)) return { html: voiceIcon.mic(size), idle: true }
    if (snapshot.speak?.blockedReason === 'muted') return { html: voiceIcon.micOff(size), idle: false }
    if (snapshot.microphone === 'live') return { html: voiceIcon.mic(size), idle: false }
    return { html: voiceIcon.headphones(size), idle: false }
  }

  /**
   * Desktop: лентата „Изход“ + ⚙️ се mount-ва/маха от activeRoom (напр. край на
   * мача) — наблюдава се само body childList (без subtree), за да остане
   * бутонът веднага след ⚙️, без промени в activeRoom контролера.
   */
  let actionBarObserver: MutationObserver | null = null
  function watchDesktopActionBar(active: boolean): void {
    if (!active) {
      actionBarObserver?.disconnect()
      actionBarObserver = null
      return
    }
    if (actionBarObserver !== null || typeof MutationObserver === 'undefined') return
    actionBarObserver = new MutationObserver(() => {
      const button = doc.querySelector(GAME_BUTTON_SELECTOR)
      const settings = doc.querySelector(DESKTOP_SETTINGS_SELECTOR)
      if (button === null || (settings !== null && button.previousElementSibling !== settings) || (settings === null && button.parentElement !== doc.body)) {
        syncGameButton(voice.getSnapshot())
      }
    })
    actionBarObserver.observe(doc.body, { childList: true })
  }

  function syncGameButton(snapshot: VoiceSnapshot): void {
    const shouldShow = snapshot.voiceTableId !== null && snapshot.screen === 'game'
    const desktop = isDesktop()
    let buttonElement = doc.querySelector<HTMLButtonElement>(GAME_BUTTON_SELECTOR)
    watchDesktopActionBar(shouldShow && desktop)
    if (!shouldShow) {
      buttonElement?.remove()
      return
    }
    if (buttonElement === null) {
      buttonElement = doc.createElement('button')
      buttonElement.type = 'button'
      buttonElement.setAttribute('data-voice-game-toggle', '1')
      buttonElement.addEventListener('click', () => {
        if (panelOpen) closePanel()
        else openPanel()
      })
    }
    let placementClass = ''
    if (desktop) {
      // Веднага след ⚙️ в същия flex; без лентата — на същото място, самостоятелно.
      const settings = doc.querySelector(DESKTOP_SETTINGS_SELECTOR)
      if (settings !== null) {
        if (buttonElement.previousElementSibling !== settings) settings.after(buttonElement)
        placementClass = ' pvg--desktop'
      } else {
        if (buttonElement.parentElement !== doc.body) doc.body.appendChild(buttonElement)
        placementClass = ' pvg--desktop-free'
      }
    } else if (buttonElement.parentElement !== doc.body) {
      doc.body.appendChild(buttonElement)
    }
    const icon = gameButtonIcon(snapshot, desktop ? 24 : 20)
    const className = `pvg${placementClass}${icon.idle ? ' pvg--idle' : ''}`
    if (buttonElement.className !== className) buttonElement.className = className
    if (buttonElement.dataset.iconKey !== icon.html) {
      buttonElement.dataset.iconKey = icon.html
      buttonElement.innerHTML = icon.html
    }
    const label = `Гласов чат: ${describeVoiceStatus(snapshot).label}`
    if (buttonElement.getAttribute('aria-label') !== label) buttonElement.setAttribute('aria-label', label)
    buttonElement.setAttribute('aria-expanded', panelOpen ? 'true' : 'false')
  }

  // ─── Лента в чакалнята ──────────────────────────────────────────────

  function stripHtml(snapshot: VoiceSnapshot): string {
    const status = describeVoiceStatus(snapshot)
    const inVoice = isInVoice(snapshot)
    const cta = inVoice ? 'Отвори' : snapshot.canRestore ? 'Възстанови' : 'Включи се'
    return `
      <button type="button" class="pvs${isDesktop() ? ' pvs--dark' : ''}" data-voice-action="open-panel" aria-label="Гласов чат: ${status.label}">
        <span class="pvs-ico">${inVoice && snapshot.microphone !== 'live' ? voiceIcon.headphones(18) : voiceIcon.mic(18)}</span>
        <span class="pvs-copy">
          <span class="pvs-title">Гласов чат</span>
          <span class="pvs-sub pvs-sub--${status.tone}">${status.label}</span>
        </span>
        <span class="pvs-cta${inVoice ? ' pvs-cta--open' : ''}">${cta}</span>
      </button>
    `
  }

  function syncWaitingStrip(root: ParentNode): void {
    if (disposed) return
    const host = root.querySelector<HTMLElement>(STRIP_SELECTOR)
    if (host === null) return
    const html = stripHtml(voice.getSnapshot())
    if (host.dataset.voiceStripHtml !== html) {
      host.dataset.voiceStripHtml = html
      host.innerHTML = html
    }
    if (host.dataset.voiceStripBound !== '1') {
      host.dataset.voiceStripBound = '1'
      host.addEventListener('click', onDelegatedClick)
    }
  }

  // ─── Абонаменти ─────────────────────────────────────────────────────

  function onSnapshot(snapshot: VoiceSnapshot): void {
    if (disposed) return
    if (snapshot.screen === 'waiting' && lastScreen !== 'waiting') promptHandledThisVisit = false // ново посещение
    lastScreen = snapshot.screen
    if (isInVoice(snapshot)) promptHandledThisVisit = true
    const theme = themeFor(snapshot)
    // Prefetch на панела само на гласова маса (чакалня/игра) — малък chunk, без SDK.
    if (theme !== null && view === null) void loadView().catch(() => {})
    if (panelOpen) {
      const layer = doc.querySelector<HTMLElement>(LAYER_SELECTOR)
      if (theme === null || layer === null) closePanel()
      else renderPanelInto(layer, snapshot, theme)
    }
    syncPrompt(snapshot)
    syncGameButton(snapshot)
    syncWaitingStrip(doc)
  }

  const unsubscribe = voice.subscribe(onSnapshot)
  const unsubscribeSpeaking = voice.subscribeSpeaking((profileIds) => applyVoiceSpeakingProfiles(profileIds, doc))
  onSnapshot(voice.getSnapshot())

  return {
    syncWaitingStrip,
    openPanel,
    closePanel,
    isPanelOpen: () => panelOpen,
    refresh() {
      onSnapshot(voice.getSnapshot())
    },
    dispose() {
      disposed = true
      unsubscribe()
      unsubscribeSpeaking()
      watchDesktopActionBar(false)
      doc.querySelector(LAYER_SELECTOR)?.remove()
      doc.querySelector(PROMPT_SELECTOR)?.remove()
      doc.querySelector(GAME_BUTTON_SELECTOR)?.remove()
      applyVoiceSpeakingProfiles([], doc)
    },
  }
}
