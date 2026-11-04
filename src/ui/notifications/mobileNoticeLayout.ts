import { isPhoneLayoutViewport } from '../layout/viewportStage.js'

// Позициониране и тема на глобалните турнирни известия на телефон.
//
// Известията се рендират в собствени контейнери в <body> (виж main.ts) и
// не знаят върху кой екран стоят. Този модул следи активния изглед в #app и
// само на телефон:
//   - светла мобилна рамка (лоби/страници с data-lobby-*-mobile-light):
//     известията горе застават под хедъра (лого, камбанка, писмо), едно под
//     друго, без да се застъпват; лентата за изчакване стои над долната
//     навигация (или над долния ръб, ако навигацията липсва); визията е
//     светла (стиловете по-долу, по data-mobile-notice-part атрибутите);
//   - игрови/други екрани без лоби (#app без data-lobby-screen-root):
//     визията остава тъмна; горните известия запазват мястото си, но се
//     нареждат едно под друго, а лентата за изчакване минава горе при тях,
//     за да не покрива картите и игровите бутони долу.
// Desktop/таблет и тъмните мобилни екрани: нищо не се променя (всички
// override-и се махат). Условията за показване, текстовете, таймерите и
// обработчиците остават изцяло в самите компоненти.

type MobileNoticeContext = 'light' | 'game' | 'none'

const STYLE_ID = 'mobile-notice-layout-style'
const GAP_PX = 8
const SIDE_PX = 12
// Свойствата, които модулът може да променя (типът на override()).
const MANAGED_PROPERTIES = ['top', 'bottom', 'left', 'right', 'width', 'max-width', 'transform', 'white-space', 'flex-wrap', 'justify-content', 'text-align'] as const

const LIGHT = 'body[data-mobile-notice-context="light"]'
const NOTICE_STYLES = `
  ${LIGHT} [data-mobile-notice] {
    background:#FFFFFF !important;color:#111827 !important;border:1px solid #E4E7EC !important;
    border-radius:12px !important;box-shadow:0 12px 32px rgba(16,24,40,0.16) !important;
  }
  ${LIGHT} [data-mobile-notice-part="eyebrow"] { color:#6941C6 !important; }
  ${LIGHT} [data-mobile-notice-part="title"] { color:#17233C !important; }
  ${LIGHT} [data-mobile-notice-part="text"] { color:#667085 !important; }
  ${LIGHT} [data-mobile-notice-part="muted"] { color:#98A2B3 !important; }
  ${LIGHT} [data-mobile-notice-part="success"] { color:#067647 !important; }
  ${LIGHT} [data-mobile-notice-part="warning"] { color:#B54708 !important; }
  ${LIGHT} [data-mobile-notice-part="danger"] { color:#B42318 !important; }
  ${LIGHT} [data-mobile-notice-part="primary"] {
    background:#7950E8 !important;color:#FFFFFF !important;border:0 !important;border-radius:8px !important;
  }
  ${LIGHT} [data-mobile-notice-part="secondary"] {
    background:#FFFFFF !important;color:#344054 !important;border:1px solid #D0D5DD !important;border-radius:8px !important;
  }
  ${LIGHT} [data-mobile-notice-part="icon-button"] {
    background:#F2F4F7 !important;color:#475467 !important;border:1px solid #F2F4F7 !important;
  }
  ${LIGHT} [data-mobile-notice-part="avatar"] {
    background:#F4F0FF !important;color:#6941C6 !important;border-color:#E9E2FF !important;
  }
  ${LIGHT} [data-mobile-notice-part="progress"] { background:#7950E8 !important; }
  ${LIGHT} [data-mobile-notice-part="overlay"] { background:rgba(16,24,40,0.55) !important;backdrop-filter:none !important; }
  ${LIGHT} [data-mobile-notice-part="card"] {
    background:#FFFFFF !important;color:#111827 !important;border:1px solid #E4E7EC !important;
    border-radius:12px !important;box-shadow:0 20px 48px rgba(16,24,40,0.18) !important;
  }
  ${LIGHT} #session-in-game-overlay [data-mobile-notice-part="card"] {
    width:calc(100% - 32px);max-width:400px;padding:24px 20px;
  }
  ${LIGHT} #session-in-game-overlay [data-mobile-notice-part="primary"] { width:100%;font-size:15px !important;letter-spacing:0 !important; }
`

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = NOTICE_STYLES
  document.head.appendChild(style)
}

function resolveContext(appRoot: HTMLElement): { context: MobileNoticeContext; lobbyRoot: HTMLElement | null } {
  if (!isPhoneLayoutViewport()) return { context: 'none', lobbyRoot: null }
  const lobbyRoot = appRoot.querySelector<HTMLElement>('[data-lobby-screen-root="1"]')
  if (lobbyRoot === null) return { context: 'game', lobbyRoot: null }
  const isLight = lobbyRoot.hasAttribute('data-lobby-member-mobile-light') || lobbyRoot.hasAttribute('data-lobby-guest-mobile-light')
  return { context: isLight ? 'light' : 'none', lobbyRoot }
}

// Долният ръб по layout позицията (без transform) — входните анимации
// (translateY) не трябва да влияят на подредбата.
function layoutBottom(el: HTMLElement): number {
  return el.offsetTop + el.offsetHeight
}

function isShown(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

export function installMobileNoticeLayout(options: {
  appRoot: HTMLElement
  /** В реда, в който се нареждат отгоре надолу. */
  topContainers: HTMLElement[]
  bottomContainers: HTMLElement[]
}): void {
  ensureStyles()
  // Оригиналните inline стойности на всяко променено свойство — връщат се
  // точно при смяна на контекста (компонентите не се пре-рендират тогава).
  const managed = new Map<HTMLElement, Map<string, { value: string; priority: string }>>()

  function override(el: HTMLElement, values: Partial<Record<(typeof MANAGED_PROPERTIES)[number], string>>): void {
    let originals = managed.get(el)
    if (originals === undefined) {
      originals = new Map()
      managed.set(el, originals)
    }
    for (const [property, value] of Object.entries(values)) {
      if (!originals.has(property)) {
        originals.set(property, { value: el.style.getPropertyValue(property), priority: el.style.getPropertyPriority(property) })
      }
      el.style.setProperty(property, value, 'important')
    }
  }

  function resetManaged(): void {
    for (const [el, originals] of managed) {
      if (!el.isConnected) continue
      for (const [property, original] of originals) {
        if (original.value === '') el.style.removeProperty(property)
        else el.style.setProperty(property, original.value, original.priority)
      }
    }
    managed.clear()
  }

  const noticeIn = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-mobile-notice]')

  function apply(): void {
    const { context, lobbyRoot } = resolveContext(options.appRoot)
    resetManaged()
    if (context === 'none') {
      delete document.body.dataset.mobileNoticeContext
      return
    }
    document.body.dataset.mobileNoticeContext = context

    const top = options.topContainers.map(noticeIn).filter((el): el is HTMLElement => el !== null && isShown(el))
    const bottom = options.bottomContainers.map(noticeIn).filter((el): el is HTMLElement => el !== null && isShown(el))

    if (context === 'light') {
      const header = lobbyRoot?.querySelector<HTMLElement>('[data-lobby-guest-mobile-header="1"]') ?? null
      let cursor = header !== null ? header.getBoundingClientRect().bottom + GAP_PX : SIDE_PX
      for (const el of top) {
        override(el, { top: `${cursor}px`, left: `${SIDE_PX}px`, right: `${SIDE_PX}px`, width: 'auto', 'max-width': 'none', transform: 'none' })
        cursor = layoutBottom(el) + GAP_PX
      }
      const nav = lobbyRoot?.querySelector<HTMLElement>('[data-lobby-guest-bottom-nav="1"]') ?? null
      const bottomOffset = nav !== null && isShown(nav)
        ? `${Math.max(0, window.innerHeight - nav.getBoundingClientRect().top) + GAP_PX}px`
        : `calc(${SIDE_PX}px + env(safe-area-inset-bottom, 0px))`
      for (const el of bottom) {
        override(el, {
          bottom: bottomOffset, left: `${SIDE_PX}px`, right: `${SIDE_PX}px`, width: 'auto', 'max-width': 'none', transform: 'none',
          'white-space': 'normal', 'flex-wrap': 'wrap', 'justify-content': 'center', 'text-align': 'center',
        })
      }
      return
    }

    // Игрови екран: първото горно известие остава на собствената си височина;
    // всички са на цялата ширина (центрираното с left:50% иначе става тясно и
    // високо), следващите (и лентата за изчакване) се нареждат под него.
    let cursor: number | null = null
    for (const el of top) {
      override(el, { left: `${SIDE_PX}px`, right: `${SIDE_PX}px`, width: 'auto', 'max-width': 'none', transform: 'none' })
      if (cursor !== null) override(el, { top: `${cursor}px` })
      cursor = layoutBottom(el) + GAP_PX
    }
    for (const el of bottom) {
      override(el, {
        top: cursor !== null ? `${cursor}px` : `calc(${SIDE_PX}px + env(safe-area-inset-top, 0px))`, bottom: 'auto',
        left: `${SIDE_PX}px`, right: `${SIDE_PX}px`, width: 'auto', 'max-width': 'none', transform: 'none',
        'white-space': 'normal', 'flex-wrap': 'wrap', 'justify-content': 'center', 'text-align': 'center',
      })
      cursor = layoutBottom(el) + GAP_PX
    }
  }

  // Наблюдават се само childList промени (не атрибути) — собствените
  // override-и не задействат нов apply().
  const observer = new MutationObserver(() => apply())
  observer.observe(options.appRoot, { childList: true })
  for (const container of [...options.topContainers, ...options.bottomContainers]) {
    observer.observe(container, { childList: true, subtree: true })
  }
  window.addEventListener('resize', apply)
  window.visualViewport?.addEventListener('resize', apply)
  apply()
}
