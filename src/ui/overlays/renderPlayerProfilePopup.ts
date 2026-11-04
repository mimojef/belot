import type {
  AdminProfileLinkedProfileRow,
  PlayerPublicProfileSnapshot,
  PlayerCampaignProfileSummary,
  ActiveCampaignProfileProgress,
  PlayerCampaignTierView,
  PlayerCampaignTierRewardEntry,
  PlayerCampaignTierRewardView,
  Seat,
  TopicMuteSnapshot,
} from '../../app/network/createGameServerClient'
import { VIOLET_3D_BUTTON_CLASS } from '../layout/violet3dButton'

export type RenderPlayerProfilePopupOptions = {
  isOpen: boolean
  /**
   * Светлата палитра на новото мобилно лоби за гости (само от лобито, когато
   * е показан светлият екран). Сменя само цветовете на частите, които гост
   * вижда; съдържанието, бутоните и data-атрибутите са същите.
   */
  light?: boolean
  seat: Seat | null
  profile: PlayerPublicProfileSnapshot | null
  isLoading?: boolean
  canEdit?: boolean
  isOwnProfile?: boolean
  /**
   * Самоизтриване (Етап 4I) — "Изтрий" до "Редакция" в СОБСТВЕНИЯ профил.
   * Server-derived (session.profileSelfDeletionAvailable: флаг + роля);
   * никога за чужд профил. Отделно от административното "Изтрий"
   * (data-player-profile-delete-open). Сървърът проверява всичко при подаване.
   */
  canSelfDelete?: boolean
  isAdmin?: boolean
  friendshipAction?: PlayerProfileFriendshipAction | null
  /**
   * Virtual item gift system (Етап 1) — ОТДЕЛЕН бутон от "Подари жълтици"
   * (friendshipAction.giftFriendshipId/giftBypassProfileId по-горе, за
   * директен coin transfer). Non-null само когато !isOwnProfile и
   * profile.profileId съществува — виж giftItemStore.ts.
   */
  giftItemRecipientProfileId?: string | null
  /**
   * "Подари авоари" (Paid Gift Shop) — ОТДЕЛЕН бутон от служебното "Подари
   * жълтици" (friendshipAction.giftFriendshipId/giftBypassProfileId, само
   * privileged) и от Item Gift System (giftItemRecipientProfileId, §38 в
   * брифа — НЕ се пипа). Non-null само когато !isOwnProfile и
   * profile.profileId съществува — видим за ВСЕКИ друг потребител (normal
   * ИЛИ staff), независимо от friendship статус. Отваря Shop в gift mode
   * (/shop?giftTo=<profileId>) — eligibility на получателя се проверява
   * authoritative server-side при checkout (§13 в брифа), тук е само UI
   * видимост на самия бутон.
   */
  giftShopRecipientProfileId?: string | null
  skipAnimation?: boolean
  /**
   * Вижда се само когато ТЕКУЩИЯТ логнат профил е официалният Pika.bg
   * профил (проверено server-side при действителния start-заявка; тук е
   * чисто UI видимост) И разглежданият профил не е собствения/гост. Не
   * зависи от friendshipAction — PIKABG трябва да може да пише дори на
   * non-friend.
   */
  showPikaSupportChatButton?: boolean
  showTopicsPersonalMessageButton?: boolean
  /**
   * Само за ПЪЛЕН администратор (не субадмин) — управлява видимостта на
   * "Субадмин" баджа и бутоните "Направи/Премахни субадмин". Обикновени
   * потребители и субадмини никога не трябва да виждат чужд субадмин статус.
   */
  viewerIsFullAdmin?: boolean
  /**
   * Текуща роля на разглеждания акаунт — null докато не е известна (все
   * още не е заредена) или ако профилът няма акаунт (бот/гост/временен).
   * Ползва се само когато viewerIsFullAdmin е true.
   */
  targetAccountRole?: PlayerAccountRole | null
  /**
   * ISO дата на изтичане на VIP — попълва се само когато profile е
   * собственият профил на viewer-а (isOwnProfile). За чужди профили
   * оставаме само с публичния "VIP" бадж, без дата (виж т.13 от брифа).
   *
   * Tri-state, explicit (НЕ omitted-prop default): undefined = own VIP
   * статусът все още не е resolved от сървъра (render-ва "VIP · …" loading
   * placeholder — виж renderOwnProfileSummary); null = resolved, без активен
   * VIP ("VIP · 0 дни"); string = resolved, активен до тази дата. Root cause
   * на "VIP · 0 дни" flash бъга беше, че null означаваше и двете "not
   * loaded" и "loaded, inactive" едновременно.
   */
  ownVipActiveUntil?: string | null | undefined
  /**
   * "Дай VIP" inline grant форма — само за viewerIsFullAdmin, само за чужд
   * профил. vipGrantOpen превключва между trigger линка и разгънатото поле;
   * submitting/errorText управляват inline съобщението (без reload/затваряне
   * на popup-а).
   */
  vipGrantOpen?: boolean
  vipGrantSubmitting?: boolean
  vipGrantErrorText?: string | null
  /**
   * Заменя generic "Няма наличен профил" текста, когато profile е null и
   * !isLoading — ползва се за server-side access denial (напр. block),
   * при което искаме конкретна причина вместо generic fallback.
   */
  emptyMessage?: string | null
  /**
   * Admin moderation (BAN/УНИЩОЖИ) — само viewerIsFullAdmin, никога за
   * собствения профил (isOwnProfile). activeBan е null докато lazy-fetch-ът
   * (ensureProfilePopupActiveBanLoaded) не е resolved или профилът реално
   * няма активен бан — виж "Баннат до" бутона вместо "БАН" в
   * renderModerationControls по-долу.
   */
  activeBan?: ActiveProfileBanSnapshot | null
  /**
   * Активен Topics-section mute на разглеждания профил — само за viewer с
   * mute/unmute право (isTopicModeratorAuthSession). null = или все още не е
   * зареден, или профилът реално не е мютнат — в двата случая overlay-ът НЕ
   * се показва (виж ensureProfilePopupMuteStatusLoaded в
   * createLobbyFlowController.ts). Обикновен потребител никога не получава
   * mute lookup fetch изобщо (client gate), значи това поле остава null за
   * него независимо от реалния mute статус на target-а — profile popup-ът
   * изглежда напълно нормален.
   */
  targetMute?: TopicMuteSnapshot | null
  /**
   * Бутон "Мют" (налагане на мют директно от профила) — САМО за viewer с
   * роля admin или pika_team (UX gate; сървърът презаверява ролята и
   * защитените профили). Показва се само за чужд профил, когато mute
   * статусът е зареден и НЯМА активен мют (иначе — overlay-ят за активен мют).
   */
  viewerCanProfileMute?: boolean
  banPopupOpen?: boolean
  banPopupDaysDraft?: string
  banPopupReasonDraft?: string
  banPopupSubmitting?: boolean
  banPopupErrorText?: string | null
  unbanConfirmOpen?: boolean
  unbanSubmitting?: boolean
  deletePopupOpen?: boolean
  deletePopupReasonDraft?: string
  deletePopupSubmitting?: boolean
  deletePopupErrorText?: string | null
  /**
   * Admin hard-delete UX/reliability fix (production report) — ненулево
   * ЕДИНСТВЕНО когато последният hard-delete отговор е бил pending:true
   * (target профилът е бил реален участник в играеща се стая, физическото
   * изтриване е отложено до края на мача — виж submitAdminHardDelete в
   * createLobbyFlowController.ts). Показва се вместо/заедно с обичайното
   * "Изтрий окончателно" поведение, за да не изглежда операцията като
   * завършена.
   */
  deletePopupPendingNotice?: string | null
  /**
   * "Свързани профили" admin секция — само viewerIsFullAdmin && !isOwnProfile.
   * riskDetailRows е null докато не е fetched (виж
   * ensureProfilePopupRiskDetailLoaded в createLobbyFlowController.ts) —
   * секцията се показва само когато profile.riskDetected===true, но
   * "Провери отново" бутонът е винаги видим за всеки non-own profile (spec:
   * "profile може да е бил clean при първата проверка").
   */
  riskDetailOpen?: boolean
  riskDetailLoading?: boolean
  riskDetailRows?: AdminProfileLinkedProfileRow[] | null
  riskDetailErrorText?: string | null
  riskRecheckSubmitting?: boolean
  /**
   * Фаза 8 — активен кампаниен прогрес (карето под "Ранг") + последна
   * приключила кампания (горна навигация "Кампании") за РАЗГЛЕЖДАНИЯ
   * профил (собствен ИЛИ чужд). `null` = нищо за показване (flag off,
   * без активна и без предишна кампания, или все още не е зареден) —
   * попъпът изглежда точно като преди Фаза 8 в този случай (§11).
   */
  campaignSummary?: PlayerCampaignProfileSummary | null
  /** "Виж всички награди" (§4) — разгънат/свит state. */
  campaignAllRewardsExpanded?: boolean
  /** Горна навигация "Кампании" (§5) — показва/скрива последната приключила кампания. */
  campaignHistoryOpen?: boolean
}

export type PlayerAccountRole = 'player' | 'chat_admin' | 'pika_team' | 'top_chat_admin' | 'marketing' | 'subadmin' | 'admin'

/** Активен бан на разглеждания профил (само за viewerIsFullAdmin) — виж handleAdminProfileBanRequest GET в server/src/index.ts. */
export type ActiveProfileBanSnapshot = {
  banId: string
  bannedUntil: string
  reason: string
  remainingDays: number
}

export type PlayerProfileFriendshipAction = {
  profileId: string
  label: string
  disabled: boolean
  message: string | null
  giftFriendshipId?: string | null
  /**
   * Само за viewer с role='pika_team' — показва бутона "Подари жълтици"
   * дори когато giftFriendshipId е null (получателят НЕ е приятел).
   * Съдържа target profileId-то, подадено директно към
   * /api/friends/gift-coins/direct (виж isPikaTeamGiftFriendshipBypassAuthSession
   * в createLobbyFlowController.ts). Server-side authoritative gate:
   * isPikaTeamGiftFriendshipBypassSession в authStore.ts.
   */
  giftBypassProfileId?: string | null
}

// Активна за времето на един renderPlayerProfilePopup({ light: true }).
let isLightTheme = false

// Собственият профил в светлата тема (телефон) — декоративен hero, бутони
// за магазина и карти за ранга/статистиката. Активна за времето на един
// renderPlayerProfilePopup, само когато собственият профил е зареден.
let isOwnRichLayout = false

// Чужд профил в светлата тема (телефон) — същият hero, карти и галерия като
// собствения; вместо "+VIP"/"Редакция"/"Изтрий" — действията за чужд профил.
let isForeignRichLayout = false

const OWN_PROFILE_ASSETS = '/assets/lobby-mobile/profile'

// Тъмна стойност по подразбиране, светла — само при isLightTheme.
function themed(dark: string, light: string): string {
  return isLightTheme ? light : dark
}

// Lucide икони (stroke) за собствения профил.
function lucideIcon(paths: string, size: number, strokeWidth = 2): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:block;flex:0 0 auto;">${paths}</svg>`
}

const LUCIDE_X = '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
const LUCIDE_PLUS = '<path d="M5 12h14"/><path d="M12 5v14"/>'
const LUCIDE_CROWN = '<path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/><path d="M5 21h14"/>'
const LUCIDE_SQUARE_PEN = '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>'
const LUCIDE_TRASH = '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>'
const LUCIDE_CHART = '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>'
const LUCIDE_GAMEPAD = '<line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>'
const LUCIDE_TROPHY = '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>'
const LUCIDE_TARGET = '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>'

const LIGHT_TEXT = '#17233C'
const LIGHT_MUTED = '#667085'
const LIGHT_VIOLET = '#7950E8'
const LIGHT_BORDER = '#E4E7EC'
// Основните бутони в светлата тема: общият 3D стил (violet3dButton.ts) —
// класовете носят фона и релефа, затова inline стилът е без background.
const LIGHT_PRIMARY_3D_CLASS_ATTR = `class="lobby-violet-btn ${VIOLET_3D_BUTTON_CLASS}"`
const LIGHT_PRIMARY_BUTTON = 'border-color:transparent;color:#FFFFFF;'
const LIGHT_SECONDARY_BUTTON = 'background:#FFFFFF;border-color:#D0D5DD;color:#17233C;'
// Фонът на светлия профил (собствен и чужд, както и докато се зарежда):
// мек градиент — светъл горе, ясно виолетов долу. На телефон картата е на цял
// екран и е самият scroll контейнер, затова фонът стои неподвижен, докато
// съдържанието скролва. #F5F7FC остава като основен цвят под градиента.
const LIGHT_PROFILE_PAGE_BACKGROUND = 'linear-gradient(180deg, #F7F5FD 0%, #EFE9FE 35%, #D3C4FA 64%, #9F82EE 100%), #F5F7FC'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function formatSeatLabel(seat: Seat | null): string {
  if (seat === 'bottom') return 'Ти'
  if (seat === 'right') return 'Дясно'
  if (seat === 'top') return 'Горе'
  if (seat === 'left') return 'Ляво'
  return 'Играч'
}

function formatNullableText(
  value: string | number | null | undefined,
  fallback = '—'
): string {
  if (value === null || value === undefined) {
    return fallback
  }

  const text = String(value).trim()
  return text.length > 0 ? escapeHtml(text) : fallback
}

/** Споделена inline heart SVG — заменя ♥ text glyph-а навсякъде в този popup (бутон "Харесай" + "Харесан: N" статистика). currentColor вместо hardcoded fill, за да наследява color от wrapping елемента. */
function renderHeartIcon(sizePx: number): string {
  return `<svg width="${sizePx}" height="${sizePx}" viewBox="0 0 24 24" fill="currentColor" style="display:inline-block;flex:0 0 auto;vertical-align:-2px;color:#dc2626;"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`
}

/**
 * Outline gift-box SVG — заменя 🎁 emoji-то в action бутоните (профил
 * "Подарък" бутон, admin nav "Подаръци"). stroke="currentColor" вместо
 * hardcoded fill (за разлика от renderHeartIcon по-горе, който е умишлено
 * filled/hardcoded-red) — наследява текущия текстов цвят на бутона (тук
 * златния #fde68a), консистентно с renderTopicActionIcon outline stroke
 * pattern-а в renderTopicsScreen.ts.
 */
function renderGiftBoxIcon(sizePx: number): string {
  return `<svg width="${sizePx}" height="${sizePx}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;flex:0 0 auto;vertical-align:-3px;" aria-hidden="true" focusable="false"><rect x="3" y="8" width="18" height="4"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/></svg>`
}

function renderLevelBadge(level: number | null | undefined, size: 'sm' | 'md' = 'md'): string {
  if (typeof level !== 'number' || !Number.isFinite(level) || level < 1) return ''
  const sz = size === 'sm' ? '16px' : '20px'
  const fs = size === 'sm' ? '9px' : '11px'
  return `<div style="position:absolute;right:4px;bottom:4px;min-width:${sz};height:${sz};border-radius:999px;background:#000000;display:flex;align-items:center;justify-content:center;padding:0 3px;line-height:1;z-index:1;color:#ffffff;font-size:${fs};font-weight:700;">${Math.trunc(level)}</div>`
}

/**
 * Голяма, центрирана moderation overlay икона върху аватара — показва се
 * САМО когато target профилът има активен Topics-section mute И viewer-ът
 * има mute/unmute право (isTopicModeratorAuthSession, gate-нат от caller-а
 * в createLobbyFlowController.ts преди дори fetch-ване на targetMute, виж
 * ensureProfilePopupMuteStatusLoaded). Reuse-ва ТОЧНО СЪЩИЯ SVG "прекъснат
 * кръг" path и червен цвят (#ef4444) като renderTopicAuthorMuteIndicator в
 * renderTopicsScreen.ts (visual consistency, не нов иконен стил). Клик
 * отваря СЪЩИЯ unmute confirm popup (data-player-profile-mute-overlay ->
 * openProfileMuteOverlayPopup в контролера) — не създава втори moderation
 * popup. z-index над renderLevelBadge (corner badge, z-index:1) и над самия
 * avatar div — не променя размера/позицията на аватара самия (absolute,
 * извън document flow-а на avatar div-а).
 */
function renderProfileAvatarMuteOverlay(targetProfileId: string, targetDisplayName: string): string {
  return `
    <button
      type="button"
      data-player-profile-mute-overlay="${escapeHtml(targetProfileId)}"
      data-player-profile-mute-overlay-name="${escapeHtml(targetDisplayName)}"
      title="Активен mute – отвори информация"
      aria-label="${escapeHtml(targetDisplayName)} е временно заглушен — отвори информация за заглушаването"
      style="
        position:absolute;
        inset:0;
        z-index:2;
        display:flex;
        align-items:center;
        justify-content:center;
        border:0;
        margin:0;
        padding:0;
        border-radius:${themed('20px', '8px')};
        background:rgba(0,0,0,0.46);
        cursor:pointer;
        color:#fef2f2;
      "
    >
      <span
        style="
          width:56px;
          height:56px;
          border-radius:999px;
          background:rgba(239,68,68,0.94);
          box-shadow:0 6px 18px rgba(0,0,0,0.45), 0 0 0 3px rgba(255,255,255,0.16);
          display:flex;
          align-items:center;
          justify-content:center;
        "
      >
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
        </svg>
      </span>
    </button>
  `
}

function formatAverageRating(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—'
  }

  return escapeHtml(value.toFixed(2))
}

function formatInteger(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'вЂ”'
  }

  return escapeHtml(new Intl.NumberFormat('bg-BG').format(Math.trunc(value)))
}

function getRankLevel(profile: PlayerPublicProfileSnapshot): number | null {
  if (typeof profile.level !== 'number' || !Number.isFinite(profile.level)) {
    return null
  }

  return Math.max(1, Math.trunc(profile.level))
}

// Собствен профил (светъл, телефон): картата "Ранг" с щита — нивото е HTML
// текст върху декоративния щит; името, прогресът и оставащите игри вдясно.
function renderOwnRankCard(profile: PlayerPublicProfileSnapshot): string {
  const rankLevel = getRankLevel(profile)
  // По-дългите нива се смаляват, за да останат в лилавата вътрешност на щита.
  const rankLevelDigits = rankLevel === null ? 1 : String(rankLevel).length
  const rankLevelFontSize = rankLevelDigits >= 3 ? 16 : rankLevelDigits === 2 ? 20 : 24
  const ratio =
    typeof profile.rankProgressRatio === 'number' && Number.isFinite(profile.rankProgressRatio)
      ? Math.max(0, Math.min(1, profile.rankProgressRatio))
      : 0

  return `
    <div data-player-profile-rank-card="1" style="display:flex;align-items:center;gap:12px;border-radius:12px;background:#FFFFFF;border:1px solid ${LIGHT_VIOLET};padding:12px 14px 12px 10px;box-shadow:0 4px 14px rgba(34,30,80,0.06);">
      <div style="position:relative;width:72px;height:72px;flex:0 0 72px;">
        <img src="${OWN_PROFILE_ASSETS}/profile-rank-shield.webp" alt="" aria-hidden="true" width="72" height="72" style="width:100%;height:100%;display:block;pointer-events:none;user-select:none;">
        <span data-player-profile-rank-level="1" style="position:absolute;left:0;right:0;top:45%;transform:translateY(-50%);text-align:center;color:#FFFFFF;font-size:${rankLevelFontSize}px;font-weight:900;line-height:1;white-space:nowrap;text-shadow:0 2px 4px rgba(30,10,80,0.55);">${rankLevel ?? '—'}</span>
      </div>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:8px;">
          <div style="min-width:0;">
            <div style="font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:${LIGHT_VIOLET};">Ранг</div>
            <div style="margin-top:2px;font-size:18px;font-weight:900;color:${LIGHT_TEXT};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(profile.rankTitle ?? (rankLevel ? `Ранг ${rankLevel}` : 'Ранг'))}</div>
          </div>
          <div style="font-size:14px;font-weight:900;color:${LIGHT_TEXT};white-space:nowrap;">${formatInteger(profile.completedGamesCount)} / ${formatInteger(profile.nextRankGames)}</div>
        </div>
        <div style="margin-top:8px;height:10px;border-radius:999px;background:#EEF0F6;border:1px solid ${LIGHT_BORDER};overflow:hidden;">
          <div style="width:${(ratio * 100).toFixed(2)}%;height:100%;border-radius:999px;background:linear-gradient(90deg, #8961F0 0%, #7950E8 100%);"></div>
        </div>
        <div style="margin-top:6px;font-size:12px;font-weight:700;color:${LIGHT_MUTED};">Остават ${formatInteger(profile.gamesUntilNextRank)} игри до следващо ниво</div>
      </div>
    </div>
  `
}

// Собствен профил (светъл, телефон): "Статистика" — три еднакви карти.
function renderOwnGameStatsCards(profile: PlayerPublicProfileSnapshot, successRate: string): string {
  const card = (icon: string, label: string, value: string, valueColor = LIGHT_TEXT) => `
    <div data-player-profile-stat-card="1" style="min-width:0;border-radius:12px;background:#FFFFFF;border:1px solid ${LIGHT_VIOLET};box-shadow:0 4px 14px rgba(34,30,80,0.06);padding:12px 10px;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;">
      <span style="display:flex;align-items:center;gap:6px;min-width:0;">
        <span style="color:${LIGHT_VIOLET};display:flex;">${lucideIcon(icon, 20)}</span>
        <span style="font-size:13px;line-height:1.2;font-weight:700;color:${LIGHT_MUTED};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(label)}</span>
      </span>
      <span style="margin-top:auto;font-size:20px;line-height:1;font-weight:900;color:${valueColor};">${value}</span>
    </div>
  `

  return `
    <div data-player-profile-game-stats="1" style="display:flex;flex-direction:column;gap:10px;">
      <div style="display:flex;align-items:center;gap:8px;font-size:18px;font-weight:900;color:${LIGHT_TEXT};">
        <span style="color:${LIGHT_VIOLET};display:flex;">${lucideIcon(LUCIDE_CHART, 20, 2.5)}</span>
        Статистика
      </div>
      <div style="display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:8px;">
        ${card(LUCIDE_GAMEPAD, 'Игри', formatInteger(profile.completedGamesCount))}
        ${card(LUCIDE_TROPHY, 'Победи', formatInteger(profile.wonGamesCount))}
        ${card(LUCIDE_TARGET, 'Успех', escapeHtml(successRate), '#079455')}
      </div>
    </div>
  `
}

function renderRankProgress(profile: PlayerPublicProfileSnapshot): string {
  if (isOwnRichLayout || isForeignRichLayout) return renderOwnRankCard(profile)
  const rankLevel = getRankLevel(profile)
  const completedGames = profile.completedGamesCount
  const nextRankGames = profile.nextRankGames
  const ratio =
    typeof profile.rankProgressRatio === 'number' &&
    Number.isFinite(profile.rankProgressRatio)
      ? Math.max(0, Math.min(1, profile.rankProgressRatio))
      : 0

  return `
    <div
      style="
        border-radius:${themed('8px', '12px')};
        background:${themed('linear-gradient(180deg, rgba(22,22,22,0.98) 0%, rgba(8,8,8,0.99) 100%)', '#FFFFFF')};
        border:1px solid ${themed('rgba(212,165,32,0.42)', LIGHT_VIOLET)};
        padding:16px;
        box-shadow:${themed('inset 0 0 18px rgba(212,165,32,0.04)', '0 4px 14px rgba(34,30,80,0.06)')};
      "
    >
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;">
        <div style="display:flex;align-items:center;gap:10px;min-width:0;">
          <div
            style="
              width:42px;
              height:42px;
              border-radius:8px;
              border:1px solid ${themed('rgba(212,165,32,0.72)', '#D9CCFA')};
              background:${themed('rgba(212,165,32,0.10)', '#F4F0FF')};
              color:${themed('#d4a520', LIGHT_VIOLET)};
              display:flex;
              align-items:center;
              justify-content:center;
              font-size:18px;
              font-weight:900;
            "
          >
            ${rankLevel ?? 'вЂ”'}
          </div>
          <div style="min-width:0;">
            <div style="font-size:13px;font-weight:900;letter-spacing:0.12em;text-transform:uppercase;color:${themed('#d4a520', LIGHT_VIOLET)};">
              Ранг
            </div>
            <div style="margin-top:4px;font-size:18px;font-weight:900;color:${themed('#f8fafc', LIGHT_TEXT)};">
              ${escapeHtml(profile.rankTitle ?? (rankLevel ? `Ранг ${rankLevel}` : 'Ранг'))}
            </div>
          </div>
        </div>
        <div style="font-size:14px;font-weight:900;color:${themed('#f8fafc', LIGHT_TEXT)};white-space:nowrap;">
          ${formatInteger(completedGames)} / ${formatInteger(nextRankGames)}
        </div>
      </div>

      <div style="height:12px;border-radius:999px;background:${themed('#050505', '#EEF0F6')};border:1px solid ${themed('rgba(255,255,255,0.08)', LIGHT_BORDER)};overflow:hidden;">
        <div
          style="
            width:${(ratio * 100).toFixed(2)}%;
            height:100%;
            border-radius:999px;
            background:${themed('linear-gradient(90deg, #d4a520 0%, #f4c95b 100%)', 'linear-gradient(90deg, #8961F0 0%, #7950E8 100%)')};
            box-shadow:${themed('0 0 12px rgba(212,165,32,0.36)', 'none')};
          "
        ></div>
      </div>

      <div style="margin-top:9px;font-size:12px;font-weight:800;color:${themed('rgba(226,232,240,0.70)', LIGHT_MUTED)};">
        Остават ${formatInteger(profile.gamesUntilNextRank)} игри до следващо ниво
      </div>
    </div>
  `
}

function renderGameStats(profile: PlayerPublicProfileSnapshot): string {
  const completedGames = profile.completedGamesCount
  const wonGames = profile.wonGamesCount
  const successRate =
    typeof completedGames === 'number' &&
    Number.isFinite(completedGames) &&
    completedGames > 0 &&
    typeof wonGames === 'number' &&
    Number.isFinite(wonGames)
      ? `${Math.round((wonGames / completedGames) * 100)}%`
      : '—'

  if (isOwnRichLayout || isForeignRichLayout) return renderOwnGameStatsCards(profile, successRate)

  const statItem = (label: string, value: string, accent = themed('#f8fafc', LIGHT_TEXT)) => `
    <span style="white-space:nowrap;color:${themed('rgba(148,163,184,0.80)', LIGHT_MUTED)};font-size:13px;font-weight:400;">
      ${escapeHtml(label)}:&nbsp;<span style="color:${accent};font-weight:500;">${value}</span>
    </span>
  `

  const divider = `<span style="display:inline-block;width:1px;height:13px;background:${themed('rgba(212,165,32,0.35)', '#D0D5DD')};vertical-align:middle;flex:0 0 auto;"></span>`

  return `
    <div
      data-player-profile-game-stats="1"
      style="
        display:flex;
        align-items:center;
        gap:10px;
        flex-wrap:nowrap;
        overflow:hidden;
      "
    >
      ${statItem('Игри', formatInteger(completedGames))}
      ${divider}
      ${statItem('Победи', formatInteger(wonGames), themed('#fde68a', LIGHT_VIOLET))}
      ${divider}
      ${statItem('Успех', escapeHtml(successRate), themed('#86efac', '#079455'))}
    </div>
  `
}

function renderRatingInline(profile: PlayerPublicProfileSnapshot): string {
  return `
    <div
      data-player-profile-inline-rating="1"
      style="
        display:inline-flex;
        align-items:center;
        gap:8px;
        min-width:0;
        color:${themed('rgba(148,163,184,0.80)', LIGHT_MUTED)};
        font-size:13px;
        font-weight:400;
        white-space:nowrap;
      "
    >
      <span
        data-player-profile-inline-rating-divider="1"
        style="width:1px;height:18px;background:${themed('rgba(212,165,32,0.45)', '#D0D5DD')};display:inline-block;flex:0 0 auto;"
      ></span>
      <span style="overflow:hidden;text-overflow:ellipsis;">
        Оценка: <span style="color:${themed('#d4a520', LIGHT_TEXT)};font-weight:${themed('400', '700')};">${formatAverageRating(profile.averageRating)}</span>
        от <span style="color:${themed('#fde68a', LIGHT_TEXT)};font-weight:${themed('400', '700')};">${formatNullableText(profile.totalRatingsCount)}</span>
      </span>
    </div>
  `
}

function renderAvatar(profile: PlayerPublicProfileSnapshot | null, seat: Seat | null): string {
  const avatarUrl = profile?.avatarUrl?.trim() ?? ''
  const displayName = profile?.displayName?.trim() || formatSeatLabel(seat)
  const fallbackLetter = escapeHtml(displayName.charAt(0).toUpperCase())

  if (avatarUrl.length > 0) {
    return `
      <img
        src="${escapeHtml(avatarUrl)}"
        alt="${escapeHtml(displayName)}"
        draggable="false"
        style="
          width:100%;
          height:100%;
          object-fit:cover;
          display:block;
          border-radius:${themed('20px', '8px')};
          user-select:none;
          -webkit-user-drag:none;
        "
      />
    `
  }

  return `
    <div
      style="
        width:100%;
        height:100%;
        display:flex;
        align-items:center;
        justify-content:center;
        border-radius:${themed('20px', '8px')};
        background:linear-gradient(180deg, rgba(255,255,255,0.96) 0%, rgba(226,232,240,0.96) 100%);
        color:#16314f;
        font-size:42px;
        font-weight:900;
        letter-spacing:0.04em;
      "
    >
      ${fallbackLetter}
    </div>
  `
}

function renderGallery(profile: PlayerPublicProfileSnapshot | null): string {
  const images = [...(profile?.galleryImages ?? [])].sort(
    (left, right) => left.sortOrder - right.sortOrder
  )

  if (images.length === 0) {
    return `
      <div
        style="
          border-radius:${themed('16px', '12px')};
          border:1px dashed ${themed('rgba(148,163,184,0.30)', '#D0D5DD')};
          background:${themed('rgba(255,255,255,0.04)', '#FFFFFF')};
          min-height:96px;
          display:flex;
          align-items:center;
          justify-content:center;
          color:${themed('rgba(226,232,240,0.72)', LIGHT_MUTED)};
          font-size:14px;
          font-weight:700;
          text-align:center;
          padding:12px;
        "
      >
        Няма качени снимки
      </div>
    `
  }

  return `
    <div
      style="
        display:grid;
        grid-template-columns:repeat(3, minmax(0, 1fr));
        gap:10px;
      "
    >
      ${images
        .map((image) => {
          const safeUrl = image.imageUrl?.trim() ?? ''

          if (!safeUrl) {
            return ''
          }

          return `
            <div
              data-gallery-image-url="${escapeHtml(safeUrl)}"
              style="
                position:relative;
                border-radius:${themed('16px', '12px')};
                overflow:hidden;
                aspect-ratio:1/1;
                background:${themed('rgba(255,255,255,0.06)', '#F2F4F7')};
                border:1px solid ${themed('rgba(255,255,255,0.08)', LIGHT_BORDER)};
                cursor:pointer;
              "
            >
              <img
                src="${escapeHtml(safeUrl)}"
                alt="Снимка"
                draggable="false"
                style="
                  width:100%;
                  height:100%;
                  object-fit:cover;
                  display:block;
                  user-select:none;
                  -webkit-user-drag:none;
                "
              />
            </div>
          `
        })
        .join('')}
    </div>
  `
}

function renderLoadingContent(seat: Seat | null): string {
  return `
    <div
      style="
        display:flex;
        flex-direction:column;
        align-items:center;
        justify-content:center;
        gap:14px;
        min-height:260px;
        text-align:center;
        color:${themed('#f8fafc', LIGHT_TEXT)};
      "
    >
      <div
        style="
          width:52px;
          height:52px;
          border-radius:999px;
          border:4px solid ${themed('rgba(255,255,255,0.16)', '#EAECF0')};
          border-top-color:${themed('rgba(245,187,55,0.96)', LIGHT_VIOLET)};
          animation: belot-player-profile-spin 900ms linear infinite;
        "
      ></div>

      <div
        style="
          font-size:22px;
          font-weight:900;
        "
      >
        Зареждане на профил
      </div>

      <div
        style="
          font-size:15px;
          line-height:1.5;
          color:${themed('rgba(226,232,240,0.80)', LIGHT_MUTED)};
        "
      >
        ${escapeHtml(formatSeatLabel(seat))}
      </div>
    </div>
  `
}

function renderEmptyContent(seat: Seat | null, emptyMessage: string | null): string {
  if (emptyMessage !== null) {
    return `
      <div
        style="
          display:flex;
          flex-direction:column;
          align-items:center;
          justify-content:center;
          gap:14px;
          min-height:260px;
          text-align:center;
          color:${themed('#f8fafc', LIGHT_TEXT)};
        "
      >
        <div
          style="
            font-size:15px;
            line-height:1.5;
            color:${themed('rgba(226,232,240,0.92)', LIGHT_TEXT)};
            max-width:360px;
          "
        >
          ${escapeHtml(emptyMessage)}
        </div>
      </div>
    `
  }

  return `
    <div
      style="
        display:flex;
        flex-direction:column;
        align-items:center;
        justify-content:center;
        gap:14px;
        min-height:260px;
        text-align:center;
        color:${themed('#f8fafc', LIGHT_TEXT)};
      "
    >
      <div
        style="
          font-size:24px;
          font-weight:900;
        "
      >
        Няма наличен профил
      </div>

      <div
        style="
          font-size:15px;
          line-height:1.5;
          color:${themed('rgba(226,232,240,0.80)', LIGHT_MUTED)};
          max-width:360px;
        "
      >
        Не успяхме да заредим публичния профил за ${escapeHtml(formatSeatLabel(seat))}.
      </div>
    </div>
  `
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Оставащи VIP дни от authoritative expiration timestamp (active_until) —
 * НЕ dedicated DB поле. `Math.ceil` (не floor/round) избягва off-by-one:
 * ако остават напр. 3 часа до изтичане, това все още е "1 ден" за
 * потребителя, не "0 дни". Clamp-нато до минимум 0 — никога отрицателно
 * (изтекъл/липсващ VIP, включително потребител, който никога не е имал VIP).
 */
export function computeVipRemainingDays(vipActiveUntil: string | null | undefined, nowMs: number = Date.now()): number {
  if (!vipActiveUntil) {
    return 0
  }
  const activeUntilMs = new Date(vipActiveUntil).getTime()
  if (!Number.isFinite(activeUntilMs)) {
    return 0
  }
  return Math.max(0, Math.ceil((activeUntilMs - nowMs) / MS_PER_DAY))
}

function formatVipDaysWords(days: number): string {
  return `${days} ${days === 1 ? 'ден' : 'дни'}`
}

export function formatVipDaysLabel(days: number): string {
  return `VIP · ${formatVipDaysWords(days)}`
}

/**
 * Чужд профил: VIP бадж (само текст "VIP", непроменен визуален стил на
 * банерчето) + оставащи дни като ОТДЕЛЕН нормален текст вдясно от него — НЕ
 * вътре в pill-a. Целият ред е видим САМО ако VIP е активен (vipDays > 0);
 * изтекъл/липсващ VIP крие реда изцяло — за разлика от собствения профил,
 * чийто VIP ред е ВИНАГИ видим (виж renderOwnProfileSummary). Ползва СЪЩИЯ
 * computeVipRemainingDays/formatVipDaysWords helper като собствения профил —
 * няма второ, различно изчисление на оставащите дни.
 *
 * viewerIsFullAdmin управлява САМО дали текстът с оставащите дни се показва:
 * admin вижда "VIP · N дни" (нужно за "Дай VIP" flow-а — вижда текущия
 * остатък преди/след grant); всички други viewers (subadmin, pika_team,
 * top_chat_admin, chat_admin, player, guest) виждат само бадж-а "VIP", без
 * брой дни/expiration — не показваме на други потребители чуждия VIP срок.
 * vipActiveUntil остава в profile payload-а винаги (нужен за admin
 * изчислението тук) — само render permission-ът е ролево-зависим.
 */
function renderForeignVipRow(profile: PlayerPublicProfileSnapshot, viewerIsFullAdmin: boolean): string {
  const vipDays = computeVipRemainingDays(profile.vipActiveUntil)
  if (vipDays <= 0) {
    return ''
  }

  return `
    <div
      data-player-profile-foreign-vip-days="1"
      style="
        display:inline-flex;
        align-items:center;
        gap:8px;
        min-width:0;
        margin-top:6px;
      "
    >
      <span
        data-player-profile-vip-badge="1"
        style="
          display:inline-flex;
          align-items:center;
          padding:3px 10px;
          border-radius:999px;
          background:${themed('rgba(212,165,32,0.16)', '#F4F0FF')};
          border:1px solid ${themed('rgba(212,165,32,0.58)', '#D9CCFA')};
          color:${themed('#d4a520', '#6941C6')};
          font-size:11px;
          font-weight:900;
          letter-spacing:0.04em;
          text-transform:uppercase;
          white-space:nowrap;
          text-shadow:${themed('0 0 8px rgba(212,165,32,0.32)', 'none')};
        "
      >VIP</span>
      ${viewerIsFullAdmin ? `<span style="font-size:13px;font-weight:400;color:${themed('#f8fafc', LIGHT_TEXT)};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(formatVipDaysWords(vipDays))}</span>` : ''}
    </div>
  `
}

/**
 * Компактна собствена profile summary зона — баланс + VIP оставащи дни +
 * Редакция, стек от вертикални редове вдясно от avatar-а (mobile-first,
 * виж CLAUDE.md/task brief-а). VIP редът е ВИНАГИ видим за собствения
 * профил (дори без активен VIP → "VIP · 0 дни"), за да не мести layout-а
 * според VIP статус.
 *
 * ownVipActiveUntil е tri-state: undefined означава "все още не е resolved
 * от /api/vip/status" — показваме "VIP · …" placeholder (СЪЩИЯТ DOM ред/
 * data-attribute/стил, само текстът е различен, за да няма layout shift),
 * вместо computeVipRemainingDays(undefined), който би върнал невярно "0
 * дни" (root cause на flash бъга: null/undefined бяха неразличими).
 */
function renderOwnProfileSummary(profile: PlayerPublicProfileSnapshot, ownVipActiveUntil: string | null | undefined, canSelfDelete: boolean): string {
  const hasBalance = profile.yellowCoinsBalance !== null && profile.yellowCoinsBalance !== undefined
  const isVipStatusLoading = ownVipActiveUntil === undefined
  const vipDaysText = isVipStatusLoading ? '…' : formatVipDaysWords(computeVipRemainingDays(ownVipActiveUntil))

  return `
    <div data-player-profile-own-summary="1" style="display:flex;flex-direction:column;gap:5px;min-width:0;">
      ${hasBalance ? `
        <div
          data-player-profile-balance-own="1"
          style="
            display:inline-flex;
            align-items:center;
            gap:7px;
            min-width:0;
            color:${themed('#d4a520', '#B7791F')};
            font-size:20px;
            line-height:1;
            font-weight:900;
          "
        >
          <img src="/assets/lobby/icon-coin.png" alt="" style="width:22px;height:22px;display:block;object-fit:contain;flex:0 0 auto;">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(Number(profile.yellowCoinsBalance).toLocaleString('bg-BG'))}</span>
        </div>
      ` : ''}
      <div
        data-player-profile-own-vip-days="1"
        data-vip-status-loading="${isVipStatusLoading ? '1' : '0'}"
        style="font-size:13px;letter-spacing:0.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
      ><span style="color:${themed('#d4a520', '#6941C6')};font-weight:800;">VIP · </span><span style="color:${themed('#f8fafc', LIGHT_TEXT)};font-weight:400;">${escapeHtml(vipDaysText)}</span></div>
      <div data-player-profile-own-actions="1" style="display:flex;align-items:center;flex-wrap:wrap;column-gap:18px;row-gap:6px;margin-top:6px;">
        <span
          data-player-profile-edit="1"
          style="
            display:inline-flex;
            align-items:center;
            gap:7px;
            color:${themed('#f8fafc', '#6941C6')};
            font-size:15px;
            font-weight:400;
            cursor:pointer;
            white-space:nowrap;
            width:fit-content;
          "
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Редакция
        </span>
        ${canSelfDelete ? `
          <span
            data-player-profile-self-delete="1"
            role="button"
            tabindex="0"
            aria-label="Изтрий профила"
            style="
              display:inline-flex;
              align-items:center;
              gap:7px;
              color:${themed('#fca5a5', '#B42318')};
              font-size:15px;
              font-weight:400;
              cursor:pointer;
              white-space:nowrap;
              width:fit-content;
            "
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
            Изтрий
          </span>
        ` : ''}
      </div>
    </div>
  `
}

/**
 * Профил в светлата тема (телефон): декоративният header фон, лого,
 * заглавие и ×; аватар със значката за нивото, име, баланс и VIP ред;
 * отдолу ред с действия и компактен ред с рейтинг, оценка и харесвания.
 * Заменя заглавния ред и summary grid-а само в този режим. Декорът е под
 * текста; инфо колоната започва под асата/пиката (cqw = ширината на
 * hero-то, фонът е 3:1).
 *
 * own — собственият профил: зелен "+" (магазин → жълтици) до баланса,
 * VIP ред винаги видим, "+ВИП" / "Редакция" / "Изтрий" (самоизтриването).
 * foreign — чужд профил: VIP само при активен VIP (дните само за full
 * admin, както в renderForeignVipRow), значките "✓ Приятел" и mute върху
 * аватара, админ контролите и действията за чужд профил (готов HTML).
 */
type OwnProfileHeroOptions = {
  ownVipActiveUntil: string | null | undefined
  canSelfDelete: boolean
}

type ForeignProfileHeroOptions = {
  viewerIsFullAdmin: boolean
  isFriend: boolean
  targetMute: TopicMuteSnapshot | null | undefined
  adminControlsHtml: string
  actionsHtml: string
}

function renderProfileHero(
  profile: PlayerPublicProfileSnapshot,
  seat: Seat | null,
  own: OwnProfileHeroOptions | null,
  foreign: ForeignProfileHeroOptions | null,
): string {
  const displayName = profile.displayName?.trim() || formatSeatLabel(seat)
  const hasBalance = profile.yellowCoinsBalance !== null && profile.yellowCoinsBalance !== undefined
  const isVipStatusLoading = own !== null && own.ownVipActiveUntil === undefined
  const foreignVipDays = foreign !== null ? computeVipRemainingDays(profile.vipActiveUntil) : 0
  const vipDaysText = own !== null
    ? (isVipStatusLoading ? '…' : formatVipDaysWords(computeVipRemainingDays(own.ownVipActiveUntil)))
    : (foreign?.viewerIsFullAdmin ? formatVipDaysWords(foreignVipDays) : null)
  const canSelfDelete = own?.canSelfDelete ?? false
  const actionButton = 'height:40px;min-width:0;padding:0 6px;border-radius:8px;display:flex;align-items:center;justify-content:center;gap:5px;font-family:inherit;font-size:13px;font-weight:800;cursor:pointer;white-space:nowrap;box-sizing:border-box;'
  const divider = '<span aria-hidden="true" style="width:1px;height:14px;background:#D0D5DD;flex:0 0 auto;"></span>'
  const value = (text: string) => `<span style="color:${LIGHT_TEXT};font-weight:800;">${text}</span>`
  const vipRow = (attributes: string) => `
            <div ${attributes} style="display:flex;align-items:center;gap:6px;font-size:14px;white-space:nowrap;overflow:hidden;">
              <span style="color:#B7791F;display:flex;">${lucideIcon(LUCIDE_CROWN, 18, 2.2)}</span>
              <span${own === null ? ' data-player-profile-vip-badge="1"' : ''} style="color:#B7791F;font-weight:900;">VIP</span>
              ${vipDaysText !== null ? `<span style="color:${LIGHT_MUTED};overflow:hidden;text-overflow:ellipsis;">· ${escapeHtml(vipDaysText)}</span>` : ''}
            </div>`

  return `
    <div ${own !== null ? 'data-player-profile-own-hero="1"' : 'data-player-profile-foreign-hero="1"'} style="position:relative;container-type:inline-size;">
      <img src="${OWN_PROFILE_ASSETS}/profile-header-bg.webp" alt="" aria-hidden="true" width="1236" height="412" style="position:absolute;top:0;left:0;width:100%;height:auto;display:block;pointer-events:none;user-select:none;">

      <div style="position:relative;display:flex;align-items:center;gap:8px;height:48px;padding:0 10px 0 12px;box-sizing:border-box;">
        <div aria-hidden="true" style="display:flex;align-items:center;gap:3px;flex:0 0 auto;">
          <img src="/assets/lobby-mobile/pika-spade-gold-black.webp" alt="" width="25" height="28" style="height:28px;width:auto;display:block;">
          <img src="/assets/lobby-mobile/logo-pika-text.webp" alt="" width="69" height="23" style="height:23px;width:auto;display:block;">
        </div>
        <!-- Вляво до логото: асата във фона започват от средата на ширината. -->
        <div style="flex:1;min-width:0;padding-left:2px;color:#FFFFFF;font-size:clamp(12px, 3.5cqw, 14px);font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 3px rgba(20,10,60,0.6);">Профил</div>
        <button type="button" data-player-profile-popup-close="1" aria-label="Затвори" style="width:36px;height:36px;flex:0 0 auto;box-sizing:border-box;border:1px solid #E53935;border-radius:8px;background:#FFF1F1;color:#E53935;box-shadow:0 2px 8px rgba(20,10,60,0.25);display:flex;align-items:center;justify-content:center;padding:0;cursor:pointer;">${lucideIcon(LUCIDE_X, 20, 2.6)}</button>
      </div>

      <div style="position:relative;display:grid;grid-template-columns:88px minmax(0, 1fr);column-gap:12px;align-items:start;padding:0 16px;">
        <div data-player-profile-avatar="1" style="position:relative;width:88px;height:88px;margin-top:max(8px, calc(16.7cqw - 44px));">
          <div style="width:100%;height:100%;border-radius:8px;overflow:hidden;background:#FFFFFF;border:2px solid #FFFFFF;box-sizing:border-box;box-shadow:0 0 0 1px #D9CCFA, 0 6px 18px rgba(121,80,232,0.28);">
            ${renderAvatar(profile, seat)}
          </div>
          ${renderLevelBadge(profile.level)}
          ${foreign?.targetMute?.isMuted ? renderProfileAvatarMuteOverlay(profile.profileId ?? '', displayName) : ''}
          ${foreign?.isFriend ? `
            <div data-player-profile-friend-badge="1" style="position:absolute;bottom:-11px;left:50%;transform:translateX(-50%);z-index:2;background:linear-gradient(180deg,#22c55e 0%,#16a34a 100%);color:#fff;font-size:11px;font-weight:900;white-space:nowrap;padding:3px 10px;border-radius:999px;border:2px solid #FFFFFF;letter-spacing:0.3px;">✓ Приятел</div>
          ` : ''}
        </div>

        <div style="min-width:0;padding-top:max(0px, calc(29cqw - 48px));display:flex;flex-direction:column;gap:7px;">
          <div data-player-profile-title="1" style="font-size:22px;line-height:1.15;font-weight:900;color:${LIGHT_TEXT};overflow-wrap:anywhere;">${escapeHtml(displayName)}</div>
          <div ${own !== null ? 'data-player-profile-own-summary="1"' : 'data-player-profile-foreign-summary="1"'} style="display:flex;flex-direction:column;gap:7px;min-width:0;">
            ${hasBalance ? `
              <div style="display:flex;align-items:center;gap:8px;min-width:0;">
                <div ${own !== null ? 'data-player-profile-balance-own="1"' : 'data-player-profile-balance-foreign="1"'} style="display:inline-flex;align-items:center;gap:6px;min-width:0;color:#B7791F;font-size:20px;line-height:1;font-weight:900;">
                  <img src="/assets/lobby-mobile/icons/icon-balance-coin.webp" alt="" width="22" height="22" style="width:22px;height:22px;display:block;object-fit:contain;flex:0 0 auto;">
                  <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(Number(profile.yellowCoinsBalance).toLocaleString('bg-BG'))}</span>
                </div>
                ${own !== null ? `<button type="button" data-player-profile-shop-coins="1" aria-label="Купи жълтици" style="width:28px;height:28px;flex:0 0 auto;border:0;border-radius:8px;background:linear-gradient(180deg,#3CCB6A 0%,#1FA34A 100%);color:#FFFFFF;box-shadow:inset 0 1px 0 rgba(255,255,255,0.35), 0 3px 8px rgba(23,178,106,0.35);display:flex;align-items:center;justify-content:center;padding:0;cursor:pointer;">${lucideIcon(LUCIDE_PLUS, 18, 3)}</button>` : ''}
              </div>
            ` : ''}
            ${own !== null
              ? vipRow(`data-player-profile-own-vip-days="1" data-vip-status-loading="${isVipStatusLoading ? '1' : '0'}"`)
              : foreignVipDays > 0 ? vipRow('data-player-profile-foreign-vip-days="1"') : ''}
          </div>
        </div>
      </div>

      ${own !== null ? `
        <div data-player-profile-own-actions="1" style="position:relative;display:grid;grid-template-columns:repeat(${canSelfDelete ? 3 : 2}, minmax(0, 1fr));gap:8px;padding:14px 16px 0;">
          <button type="button" ${LIGHT_PRIMARY_3D_CLASS_ATTR} data-player-profile-shop-vip="1" style="${actionButton}border:0;color:#FFFFFF;">
            <span style="color:#FFD54A;display:flex;">${lucideIcon(LUCIDE_CROWN, 16, 2.4)}</span>+VIP
          </button>
          <button type="button" data-player-profile-edit="1" style="${actionButton}border:1px solid #D9CCFA;background:#FFFFFF;color:#6941C6;">
            ${lucideIcon(LUCIDE_SQUARE_PEN, 15, 2.4)}Редакция
          </button>
          ${canSelfDelete ? `
            <button type="button" data-player-profile-self-delete="1" aria-label="Изтрий профила" style="${actionButton}border:0;background:linear-gradient(180deg,#F04438 0%,#D92D20 100%);color:#FFFFFF;box-shadow:0 4px 10px rgba(217,45,32,0.25);">
              ${lucideIcon(LUCIDE_TRASH, 15, 2.4)}Изтрий
            </button>
          ` : ''}
        </div>
      ` : ''}
      ${foreign !== null && foreign.adminControlsHtml.trim() !== '' ? `
        <div data-player-profile-foreign-admin-controls="1" style="position:relative;display:flex;align-items:center;flex-wrap:wrap;gap:8px 14px;padding:${foreign.isFriend ? '20px' : '12px'} 16px 0;">
          ${foreign.adminControlsHtml}
        </div>
      ` : ''}
      ${foreign !== null && foreign.actionsHtml.trim() !== '' ? `
        <div data-player-profile-foreign-actions="1" style="position:relative;padding:${foreign.isFriend && foreign.adminControlsHtml.trim() === '' ? '20px' : '14px'} 16px 0;">
          ${foreign.actionsHtml}
        </div>
      ` : ''}

      <div data-player-profile-own-meta="1" style="position:relative;display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:4px 10px;padding:12px 16px 0;font-size:13px;color:${LIGHT_MUTED};">
        <span style="white-space:nowrap;">Рейтинг: ${value(formatNullableText(profile.skillRating))}</span>
        ${divider}
        <span style="white-space:nowrap;">Оценка: ${value(formatAverageRating(profile.averageRating))} от ${value(formatNullableText(profile.totalRatingsCount))}</span>
        ${typeof profile.likesCount === 'number' ? `
          ${divider}
          <span style="white-space:nowrap;">Харесан: ${value(profile.likesCount.toLocaleString('bg-BG'))}</span>
        ` : ''}
      </div>
    </div>
  `
}

// Светлият hero на чужд профил — със същите стойности, които
// renderProfileContent получава за стария изглед (виж renderPlayerProfilePopupHtml).
function renderForeignRichProfileHero(profile: PlayerPublicProfileSnapshot, options: RenderPlayerProfilePopupOptions): string {
  const displayName = profile.displayName?.trim() || formatSeatLabel(options.seat)
  const canEdit = options.canEdit ?? false
  const isOwnProfile = options.isOwnProfile ?? false
  const viewerIsFullAdmin = options.viewerIsFullAdmin ?? false
  const friendshipAction = options.friendshipAction ?? null

  return renderProfileHero(profile, options.seat, null, {
    viewerIsFullAdmin,
    isFriend: Boolean(friendshipAction?.giftFriendshipId),
    targetMute: options.targetMute ?? null,
    adminControlsHtml: renderForeignAdminTitleControls(profile.profileId, canEdit, options.isAdmin ?? false, isOwnProfile, viewerIsFullAdmin, options.targetAccountRole ?? null, options.vipGrantOpen ?? false),
    actionsHtml: !canEdit && !isOwnProfile
      ? renderForeignProfileActions(
          profile,
          displayName,
          friendshipAction,
          options.showPikaSupportChatButton ?? false,
          options.showTopicsPersonalMessageButton ?? false,
          options.giftItemRecipientProfileId ?? null,
          options.giftShopRecipientProfileId ?? null,
          isOwnProfile,
          options.viewerCanProfileMute ?? false,
          options.targetMute ?? null,
          viewerIsFullAdmin,
          options.activeBan ?? null,
        )
      : '',
  })
}

/**
 * Чужд профил: баланс + VIP ред (само ако е активен), стек от вертикални
 * редове вдясно от avatar-а — структурно огледално на renderOwnProfileSummary,
 * но: (1) НИКОГА "Редакция" тук (обикновен viewer не редактира чужд профил —
 * admin edit контролът си остава в title реда, непроменен), (2) VIP редът се
 * крие изцяло при неактивен/изтекъл/липсващ VIP, вместо да е винаги видим.
 */
function renderForeignProfileSummary(profile: PlayerPublicProfileSnapshot, viewerIsFullAdmin: boolean): string {
  const hasBalance = profile.yellowCoinsBalance !== null && profile.yellowCoinsBalance !== undefined
  const vipRow = renderForeignVipRow(profile, viewerIsFullAdmin)

  if (!hasBalance && !vipRow) {
    return ''
  }

  return `
    <div data-player-profile-foreign-summary="1" style="display:flex;flex-direction:column;gap:5px;min-width:0;">
      ${hasBalance ? `
        <div
          data-player-profile-balance-foreign="1"
          style="
            display:inline-flex;
            align-items:center;
            gap:7px;
            min-width:0;
            color:${themed('#d4a520', '#B7791F')};
            font-size:20px;
            line-height:1;
            font-weight:900;
          "
        >
          <img src="/assets/lobby/icon-coin.png" alt="" style="width:22px;height:22px;display:block;object-fit:contain;flex:0 0 auto;">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(Number(profile.yellowCoinsBalance).toLocaleString('bg-BG'))}</span>
        </div>
      ` : ''}
      ${vipRow}
    </div>
  `
}

function renderSubadminRoleControls(
  isOwnProfile: boolean,
  viewerIsFullAdmin: boolean,
  targetAccountRole: PlayerAccountRole | null,
): string {
  // Никога за собствен профил, никога за друг пълен admin (target === 'admin'),
  // никога ако ролята още не е заредена (null) — не показваме грешен бутон
  // докато чакаме отговора от /api/admin/profiles/:id/subadmin.
  if (isOwnProfile || !viewerIsFullAdmin || targetAccountRole === null || targetAccountRole === 'admin') {
    return ''
  }

  if (targetAccountRole === 'subadmin') {
    return `
      <span
        data-player-profile-subadmin-badge="1"
        style="
          display:inline-flex;
          align-items:center;
          padding:3px 10px;
          border-radius:999px;
          background:rgba(212,165,32,0.16);
          border:1px solid rgba(212,165,32,0.55);
          color:#d4a520;
          font-size:11px;
          font-weight:900;
          letter-spacing:0.04em;
          text-transform:uppercase;
          white-space:nowrap;
        "
      >Субадмин</span>
      <span
        data-player-profile-revoke-subadmin="1"
        style="
          display:inline-flex;
          align-items:center;
          gap:6px;
          color:#f87171;
          font-size:14px;
          font-weight:900;
          cursor:pointer;
          white-space:nowrap;
        "
      >Премахни субадмин</span>
    `
  }

  return `
    <span
      data-player-profile-grant-subadmin="1"
      style="
        display:inline-flex;
        align-items:center;
        gap:6px;
        color:#d4a520;
        font-size:14px;
        font-weight:900;
        cursor:pointer;
        white-space:nowrap;
      "
    >Направи субадмин</span>
  `
}

/**
 * Огледално на renderSubadminRoleControls, за chat_admin роля. Рендерирана
 * ЗАЕДНО с renderSubadminRoleControls (виж call site-а в renderProfileContent) —
 * така всяка от двете елевирани роли показва своя бадж+revoke, докато
 * ДРУГАТА показва своя grant линк, което естествено предлага директно
 * превключване между тях без допълнителна логика тук.
 */
function renderChatAdminRoleControls(
  isOwnProfile: boolean,
  viewerIsFullAdmin: boolean,
  targetAccountRole: PlayerAccountRole | null,
): string {
  if (isOwnProfile || !viewerIsFullAdmin || targetAccountRole === null || targetAccountRole === 'admin') {
    return ''
  }

  if (targetAccountRole === 'chat_admin') {
    return `
      <span
        data-player-profile-chat-admin-badge="1"
        style="
          display:inline-flex;
          align-items:center;
          padding:3px 10px;
          border-radius:999px;
          background:rgba(192,132,252,0.16);
          border:1px solid rgba(192,132,252,0.58);
          color:#c084fc;
          font-size:11px;
          font-weight:900;
          letter-spacing:0.04em;
          text-transform:uppercase;
          white-space:nowrap;
          text-shadow:0 0 10px rgba(192,132,252,0.36);
        "
      >Чат админ</span>
      <span
        data-player-profile-revoke-chat-admin="1"
        style="
          display:inline-flex;
          align-items:center;
          gap:6px;
          color:#f87171;
          font-size:14px;
          font-weight:900;
          cursor:pointer;
          white-space:nowrap;
        "
      >Премахни чат админ</span>
    `
  }

  return `
    <span
      data-player-profile-grant-chat-admin="1"
      style="
        display:inline-flex;
        align-items:center;
        gap:6px;
        color:#c084fc;
        font-size:14px;
        font-weight:900;
        cursor:pointer;
        white-space:nowrap;
        text-shadow:0 0 8px rgba(192,132,252,0.30);
      "
    >Направи чат админ</span>
  `
}

function renderPikaTeamRoleControls(
  isOwnProfile: boolean,
  viewerIsFullAdmin: boolean,
  targetAccountRole: PlayerAccountRole | null,
): string {
  if (isOwnProfile || !viewerIsFullAdmin || targetAccountRole === null || targetAccountRole === 'admin') {
    return ''
  }

  if (targetAccountRole === 'pika_team') {
    return `
      <span
        data-player-profile-pika-team-badge="1"
        style="
          display:inline-flex;
          align-items:center;
          padding:3px 10px;
          border-radius:999px;
          background:rgba(239,68,68,0.16);
          border:1px solid rgba(239,68,68,0.58);
          color:#ef4444;
          font-size:11px;
          font-weight:900;
          letter-spacing:0.04em;
          text-transform:uppercase;
          white-space:nowrap;
          text-shadow:0 0 8px rgba(239,68,68,0.32);
        "
      >Екип Pika.bg</span>
      <span
        data-player-profile-revoke-pika-team="1"
        style="
          display:inline-flex;
          align-items:center;
          gap:6px;
          color:#f87171;
          font-size:14px;
          font-weight:900;
          cursor:pointer;
          white-space:nowrap;
        "
      >Премахни Екип Pika.bg</span>
    `
  }

  return `
    <span
      data-player-profile-grant-pika-team="1"
      style="
        display:inline-flex;
        align-items:center;
        gap:6px;
        color:#ef4444;
        font-size:14px;
        font-weight:900;
        cursor:pointer;
        white-space:nowrap;
        text-shadow:0 0 8px rgba(239,68,68,0.26);
      "
    >Направи Екип Pika.bg</span>
  `
}

function renderTopChatAdminRoleControls(
  isOwnProfile: boolean,
  viewerIsFullAdmin: boolean,
  targetAccountRole: PlayerAccountRole | null,
): string {
  if (isOwnProfile || !viewerIsFullAdmin || targetAccountRole === null || targetAccountRole === 'admin') {
    return ''
  }

  if (targetAccountRole === 'top_chat_admin') {
    return `
      <span
        data-player-profile-top-chat-admin-badge="1"
        style="
          display:inline-flex;
          align-items:center;
          padding:3px 10px;
          border-radius:999px;
          background:rgba(192,132,252,0.16);
          border:1px solid rgba(192,132,252,0.58);
          color:#c084fc;
          font-size:11px;
          font-weight:900;
          letter-spacing:0.04em;
          text-transform:uppercase;
          white-space:nowrap;
          text-shadow:0 0 10px rgba(192,132,252,0.40);
        "
      >TOP чат админ</span>
      <span
        data-player-profile-revoke-top-chat-admin="1"
        style="
          display:inline-flex;
          align-items:center;
          gap:6px;
          color:#f87171;
          font-size:14px;
          font-weight:900;
          cursor:pointer;
          white-space:nowrap;
        "
      >Премахни TOP чат админ</span>
    `
  }

  return `
    <span
      data-player-profile-grant-top-chat-admin="1"
      style="
        display:inline-flex;
        align-items:center;
        gap:6px;
        color:#c084fc;
        font-size:14px;
        font-weight:900;
        cursor:pointer;
        white-space:nowrap;
        text-shadow:0 0 8px rgba(192,132,252,0.30);
      "
    >Направи TOP чат админ</span>
  `
}

/**
 * Огледално на renderTopChatAdminRoleControls, за marketing ("Маркетинг")
 * роля — само пълен admin вижда grant/revoke (server: isFullAdminSession на
 * /api/admin/profiles/:id/marketing).
 */
function renderMarketingRoleControls(
  isOwnProfile: boolean,
  viewerIsFullAdmin: boolean,
  targetAccountRole: PlayerAccountRole | null,
): string {
  if (isOwnProfile || !viewerIsFullAdmin || targetAccountRole === null || targetAccountRole === 'admin') {
    return ''
  }

  if (targetAccountRole === 'marketing') {
    return `
      <span
        data-player-profile-marketing-badge="1"
        style="
          display:inline-flex;
          align-items:center;
          padding:3px 10px;
          border-radius:999px;
          background:rgba(56,189,248,0.16);
          border:1px solid rgba(56,189,248,0.58);
          color:#38bdf8;
          font-size:11px;
          font-weight:900;
          letter-spacing:0.04em;
          text-transform:uppercase;
          white-space:nowrap;
        "
      >Маркетинг</span>
      <span
        data-player-profile-revoke-marketing="1"
        style="
          display:inline-flex;
          align-items:center;
          gap:6px;
          color:#f87171;
          font-size:14px;
          font-weight:900;
          cursor:pointer;
          white-space:nowrap;
        "
      >Премахни Маркетинг</span>
    `
  }

  return `
    <span
      data-player-profile-grant-marketing="1"
      style="
        display:inline-flex;
        align-items:center;
        gap:6px;
        color:#38bdf8;
        font-size:14px;
        font-weight:900;
        cursor:pointer;
        white-space:nowrap;
      "
    >Направи Маркетинг</span>
  `
}

/**
 * "Дай VIP" trigger линк — само viewerIsFullAdmin (role==='admin', НЕ
 * subadmin/pika_team/top_chat_admin/chat_admin), само чужд профил
 * (isOwnProfile===false), само с валиден profileId. Скрит докато формата
 * е отворена (viж renderVipGrantForm по-долу — взаимно изключващи се).
 */
function renderVipGrantTrigger(
  profileId: string | null,
  isOwnProfile: boolean,
  viewerIsFullAdmin: boolean,
  vipGrantOpen: boolean,
): string {
  if (isOwnProfile || !viewerIsFullAdmin || !profileId || vipGrantOpen) {
    return ''
  }

  return `
    <span
      data-player-profile-vip-grant-open="1"
      style="
        display:inline-flex;
        align-items:center;
        gap:6px;
        color:#d4a520;
        font-size:14px;
        font-weight:900;
        cursor:pointer;
        white-space:nowrap;
      "
    >Дай VIP</span>
  `
}

/**
 * Компактна inline "Дай VIP" форма — отваря се БЕЗ нов page/navigation flow,
 * директно в profile popup-а (виж task brief-а). Enter потвърждава (native
 * <form> submit), Отказ/X затварят само формата (не самия popup — виж
 * onVipGrantCancel в createLobbyFlowController.ts). Валидацията на
 * "цяло положително число" е в контролера (submitAdminVipGrant), не тук —
 * тази функция само рендерира текущото state (submitting/errorText).
 */
function renderVipGrantForm(
  profileId: string | null,
  isOwnProfile: boolean,
  viewerIsFullAdmin: boolean,
  vipGrantOpen: boolean,
  vipGrantSubmitting: boolean,
  vipGrantErrorText: string | null,
): string {
  if (isOwnProfile || !viewerIsFullAdmin || !profileId || !vipGrantOpen) {
    return ''
  }

  return `
    <form
      data-player-profile-vip-grant-form="1"
      style="
        display:flex;
        align-items:center;
        gap:8px;
        flex-wrap:wrap;
        padding:10px 12px;
        border-radius:8px;
        border:1px solid rgba(212,165,32,0.38);
        background:rgba(212,165,32,0.07);
      "
    >
      <label style="font-size:12px;font-weight:800;color:rgba(226,232,240,0.82);white-space:nowrap;">Брой дни:</label>
      <input
        type="number"
        inputmode="numeric"
        data-player-profile-vip-grant-input="1"
        ${vipGrantSubmitting ? 'disabled' : ''}
        style="
          width:76px;
          height:34px;
          border-radius:6px;
          border:1px solid rgba(212,165,32,0.45);
          background:#050505;
          color:#f8fafc;
          padding:0 8px;
          font-size:14px;
          font-weight:700;
          outline:none;
        "
      />
      <button
        type="submit"
        data-player-profile-vip-grant-submit="1"
        ${vipGrantSubmitting ? 'disabled' : ''}
        style="
          height:34px;
          padding:0 14px;
          border:0;
          border-radius:6px;
          background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);
          color:#080808;
          font-size:13px;
          font-weight:900;
          cursor:${vipGrantSubmitting ? 'default' : 'pointer'};
          opacity:${vipGrantSubmitting ? '0.62' : '1'};
        "
      >${vipGrantSubmitting ? 'Изпращане...' : 'Дай VIP'}</button>
      <button
        type="button"
        data-player-profile-vip-grant-cancel="1"
        ${vipGrantSubmitting ? 'disabled' : ''}
        style="
          height:34px;
          padding:0 14px;
          border:1px solid rgba(255,255,255,0.16);
          border-radius:6px;
          background:#080808;
          color:#f8fafc;
          font-size:13px;
          font-weight:900;
          cursor:pointer;
        "
      >Отказ</button>
      ${vipGrantErrorText ? `
        <div data-player-profile-vip-grant-error="1" style="width:100%;font-size:12px;font-weight:800;color:#fca5a5;">${escapeHtml(vipGrantErrorText)}</div>
      ` : ''}
    </form>
  `
}

function formatModerationDateTime(iso: string): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return '—'
  return date.toLocaleString('bg-BG', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * "БАН" / "Баннат до …" + "Изтрий профил" — само viewerIsFullAdmin, само
 * чужд профил (isOwnProfile===false, никога себе си — spec §2/§11). Когато
 * activeBan е null тригерите отварят banPopupOpen/deletePopupOpen формите
 * (renderBanPopup/renderDeletePopup по-долу); когато има активен бан,
 * "БАН" се заменя с read-only "Баннат до …" индикатор + "Премахни бан"
 * (renderUnbanControls) вместо да позволи duplicate active ban (spec §11).
 */
function renderProfileMuteActionButton(
  profileId: string | null,
  displayName: string,
  isOwnProfile: boolean,
  viewerCanProfileMute: boolean,
  targetMute: TopicMuteSnapshot | null | undefined,
): string {
  // Без зареден статус (null/undefined) бутон не се показва — не допускаме
  // "Мют" върху профил, който може вече да е заглушен.
  if (isOwnProfile || !viewerCanProfileMute || !profileId || !targetMute || targetMute.isMuted) {
    return ''
  }

  return `
    <button
      type="button"
      data-player-profile-mute-action="${escapeHtml(profileId)}"
      data-player-profile-mute-action-name="${escapeHtml(displayName)}"
      style="
        min-height:38px;
        padding:0 12px;
        border:1px solid rgba(239,68,68,0.60);
        border-radius:8px;
        background:rgba(239,68,68,0.12);
        color:#fecaca;
        font-size:13px;
        font-weight:900;
        cursor:pointer;
        ${isForeignRichLayout ? 'background:#FEF3F2;border-color:#F04438;color:#B42318;' : ''}
      "
    >
      Мют
    </button>
  `
}

function renderModerationControls(
  profileId: string | null,
  isOwnProfile: boolean,
  viewerIsFullAdmin: boolean,
  activeBan: ActiveProfileBanSnapshot | null | undefined,
): string {
  if (isOwnProfile || !viewerIsFullAdmin || !profileId) {
    return ''
  }

  if (activeBan) {
    return `
      <div
        data-player-profile-active-ban="1"
        style="
          display:inline-flex;
          align-items:center;
          gap:8px;
          min-height:38px;
          padding:0 12px;
          border:1px solid rgba(248,113,113,0.55);
          border-radius:8px;
          background:rgba(248,113,113,0.12);
          color:#fca5a5;
          font-size:13px;
          font-weight:800;
          white-space:nowrap;
        "
      >Баннат до: ${escapeHtml(formatModerationDateTime(activeBan.bannedUntil))}</div>
      <button
        type="button"
        data-player-profile-unban-open="${escapeHtml(profileId)}"
        style="
          min-height:38px;
          padding:0 12px;
          border:1px solid rgba(255,255,255,0.16);
          border-radius:8px;
          background:#080808;
          color:#f8fafc;
          font-size:13px;
          font-weight:900;
          cursor:pointer;
        "
      >Премахни бан</button>
    `
  }

  return `
    <button
      type="button"
      data-player-profile-ban-open="${escapeHtml(profileId)}"
      style="
        min-height:38px;
        padding:0 12px;
        border:1px solid rgba(248,113,113,0.60);
        border-radius:8px;
        background:linear-gradient(180deg, rgba(220,38,38,0.88) 0%, rgba(185,28,28,0.92) 100%);
        color:#fff1f2;
        font-size:13px;
        font-weight:900;
        cursor:pointer;
      "
    >БАН</button>
    <button
      type="button"
      data-player-profile-delete-open="${escapeHtml(profileId)}"
      style="
        min-height:38px;
        padding:0 12px;
        border:1px solid rgba(255,255,255,0.16);
        border-radius:8px;
        background:#080808;
        color:#fca5a5;
        font-size:13px;
        font-weight:900;
        cursor:pointer;
      "
    >Изтрий профил</button>
  `
}

/**
 * "Свързани профили" admin секция — само viewerIsFullAdmin, само чужд
 * профил (isOwnProfile===false). Показва detailed linked-profiles списък
 * (fetched on-demand при отваряне на popup-а — виж
 * ensureProfilePopupRiskDetailLoaded в createLobbyFlowController.ts), плюс
 * "Провери отново" бутон, винаги наличен за всеки non-own profile (профил
 * може да е бил "чист" при първата проверка — spec explicit изисква
 * бутонът да не е ограничен само до вече рискови профили).
 */
function renderRiskSection(
  profileId: string | null,
  isOwnProfile: boolean,
  viewerIsFullAdmin: boolean,
  riskDetailLoading: boolean,
  riskDetailRows: AdminProfileLinkedProfileRow[] | null | undefined,
  riskDetailErrorText: string | null,
  riskRecheckSubmitting: boolean,
): string {
  if (isOwnProfile || !viewerIsFullAdmin || !profileId) {
    return ''
  }

  const linkedRows = riskDetailRows ?? []

  let bodyHtml = ''
  if (riskDetailLoading) {
    bodyHtml = `<div style="font-size:12px;color:rgba(226,232,240,0.6);padding:6px 0;">Зареждане...</div>`
  } else if (riskDetailErrorText) {
    bodyHtml = `<div style="font-size:12px;color:#fca5a5;padding:6px 0;">${escapeHtml(riskDetailErrorText)}</div>`
  } else if (linkedRows.length > 0) {
    bodyHtml = linkedRows.map((row) => {
      const name = row.username?.trim() || row.displayName
      return `
        <div
          data-player-profile-risk-linked-profile="${escapeHtml(row.profileId)}"
          style="
            display:flex;align-items:center;justify-content:space-between;gap:10px;
            padding:8px 10px;border-radius:6px;background:rgba(239,68,68,0.08);
            border:1px solid rgba(239,68,68,0.22);cursor:pointer;
          "
        >
          <span style="font-size:13px;font-weight:800;color:#fca5a5;word-break:break-word;">${escapeHtml(name)}</span>
          <span style="font-size:11px;color:rgba(226,232,240,0.65);white-space:nowrap;">
            Общи посещения: ${row.sharedVisitorIdsCount}${row.sharedIpCount > 0 ? ` · Общи IP: ${row.sharedIpCount}` : ''}
          </span>
        </div>
      `
    }).join('')
  }

  return `
    <div
      data-player-profile-risk-section="1"
      style="
        display:flex;flex-direction:column;gap:8px;
        border-radius:${themed('10px', '12px')};border:1px solid rgba(239,68,68,0.3);
        background:rgba(239,68,68,0.05);padding:12px 14px;
      "
    >
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
        <div style="font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#ef4444;">
          Свързани профили
        </div>
        <button
          type="button"
          data-player-profile-risk-recheck="1"
          ${riskRecheckSubmitting ? 'disabled' : ''}
          style="
            min-height:28px;padding:0 10px;border:1px solid rgba(212,165,32,0.5);
            border-radius:${themed('6px', '8px')};background:#111;color:#d4a520;font-size:11px;font-weight:800;
            cursor:${riskRecheckSubmitting ? 'default' : 'pointer'};opacity:${riskRecheckSubmitting ? '0.6' : '1'};
          "
        >${riskRecheckSubmitting ? 'Изчакай…' : 'Провери отново'}</button>
      </div>
      ${linkedRows.length === 0 && !riskDetailLoading && !riskDetailErrorText
        ? `<div style="font-size:12px;color:rgba(226,232,240,0.55);">Няма открити свързани профили.</div>`
        : bodyHtml}
    </div>
  `
}

function renderModerationPopupShell(bodyHtml: string): string {
  return `
    <div
      data-player-profile-moderation-popup-backdrop="1"
      style="
        position:fixed;
        inset:0;
        z-index:12100;
        background:rgba(0,0,0,0.72);
        display:flex;
        align-items:center;
        justify-content:center;
        padding:24px;
      "
    >
      <div
        role="dialog"
        aria-modal="true"
        style="
          width:min(92vw, 440px);
          border-radius:12px;
          background:linear-gradient(180deg, rgba(32,32,32,0.98) 0%, rgba(8,8,8,0.99) 100%);
          border:2px solid rgba(212,165,32,0.55);
          box-shadow:0 30px 70px rgba(0,0,0,0.5);
          padding:22px;
        "
      >
        ${bodyHtml}
      </div>
    </div>
  `
}

function renderBanPopup(
  profileId: string | null,
  displayName: string,
  banPopupOpen: boolean,
  daysDraft: string,
  reasonDraft: string,
  submitting: boolean,
  errorText: string | null,
): string {
  if (!banPopupOpen || !profileId) return ''

  return renderModerationPopupShell(`
    <div style="font-size:18px;font-weight:900;color:#f8fafc;margin-bottom:14px;">
      Бан на: ${escapeHtml(displayName)}
    </div>
    <form data-player-profile-ban-form="1" style="display:flex;flex-direction:column;gap:14px;">
      <label style="display:flex;flex-direction:column;gap:6px;">
        <span style="font-size:13px;font-weight:800;color:rgba(226,232,240,0.85);">Срок на бана (дни)</span>
        <input
          type="number"
          inputmode="numeric"
          min="1"
          max="3650"
          step="1"
          data-player-profile-ban-days-input="1"
          value="${escapeHtml(daysDraft)}"
          ${submitting ? 'disabled' : ''}
          style="
            height:40px;
            border-radius:8px;
            border:1px solid rgba(212,165,32,0.45);
            background:#050505;
            color:#f8fafc;
            padding:0 12px;
            font-size:14px;
            font-weight:700;
            outline:none;
          "
        />
      </label>
      <label style="display:flex;flex-direction:column;gap:6px;">
        <span style="font-size:13px;font-weight:800;color:rgba(226,232,240,0.85);">Причина</span>
        <textarea
          data-player-profile-ban-reason-input="1"
          rows="3"
          maxlength="2000"
          ${submitting ? 'disabled' : ''}
          style="
            resize:vertical;
            min-height:72px;
            border-radius:8px;
            border:1px solid rgba(212,165,32,0.45);
            background:#050505;
            color:#f8fafc;
            padding:10px 12px;
            font-size:14px;
            font-weight:500;
            outline:none;
            font-family:inherit;
          "
        >${escapeHtml(reasonDraft)}</textarea>
      </label>
      ${errorText ? `<div data-player-profile-ban-error="1" style="font-size:12px;font-weight:800;color:#fca5a5;">${escapeHtml(errorText)}</div>` : ''}
      <div style="display:flex;gap:10px;margin-top:4px;">
        <button
          type="button"
          data-player-profile-ban-cancel="1"
          ${submitting ? 'disabled' : ''}
          style="
            flex:1;
            height:42px;
            border:1px solid rgba(255,255,255,0.16);
            border-radius:8px;
            background:#080808;
            color:#f8fafc;
            font-size:14px;
            font-weight:800;
            cursor:pointer;
          "
        >Отказ</button>
        <button
          type="submit"
          data-player-profile-ban-submit="1"
          ${submitting ? 'disabled' : ''}
          style="
            flex:1;
            height:42px;
            border:0;
            border-radius:8px;
            background:linear-gradient(180deg, rgba(220,38,38,0.92) 0%, rgba(185,28,28,0.95) 100%);
            color:#fff1f2;
            font-size:14px;
            font-weight:900;
            cursor:${submitting ? 'default' : 'pointer'};
            opacity:${submitting ? '0.65' : '1'};
          "
        >${submitting ? 'Изчакай…' : 'БАН'}</button>
      </div>
    </form>
  `)
}

function renderUnbanConfirmPopup(
  profileId: string | null,
  displayName: string,
  unbanConfirmOpen: boolean,
  submitting: boolean,
): string {
  if (!unbanConfirmOpen || !profileId) return ''

  return renderModerationPopupShell(`
    <div style="font-size:18px;font-weight:900;color:#f8fafc;margin-bottom:14px;">Премахни бан?</div>
    <div style="font-size:14px;color:rgba(226,232,240,0.80);line-height:1.5;margin-bottom:22px;">
      ${escapeHtml(displayName)} ще може отново да влиза в профила си.
    </div>
    <div style="display:flex;gap:10px;">
      <button
        type="button"
        data-player-profile-unban-cancel="1"
        ${submitting ? 'disabled' : ''}
        style="
          flex:1;
          height:42px;
          border:1px solid rgba(255,255,255,0.16);
          border-radius:8px;
          background:#080808;
          color:#f8fafc;
          font-size:14px;
          font-weight:800;
          cursor:pointer;
        "
      >Отказ</button>
      <button
        type="button"
        data-player-profile-unban-confirm="1"
        ${submitting ? 'disabled' : ''}
        style="
          flex:1;
          height:42px;
          border:0;
          border-radius:8px;
          background:linear-gradient(180deg, rgba(244,201,91,0.98) 0%, rgba(201,143,19,0.98) 100%);
          color:#080808;
          font-size:14px;
          font-weight:900;
          cursor:${submitting ? 'default' : 'pointer'};
          opacity:${submitting ? '0.7' : '1'};
        "
      >${submitting ? 'Изчакай…' : 'Премахни бан'}</button>
    </div>
  `)
}

function renderDeletePopup(
  profileId: string | null,
  displayName: string,
  deletePopupOpen: boolean,
  reasonDraft: string,
  submitting: boolean,
  errorText: string | null,
  /**
   * Admin hard-delete UX/reliability fix (production report) — non-null
   * ЕДИНСТВЕНО когато последният submit е получил pending:true (target
   * профилът е бил реален участник в играеща се стая, физическото
   * изтриване е отложено до края на мача). Submit бутонът се заключва
   * (отделно от submitting, за да "Отказ"/"Затвори" остане достъпен) и
   * показваме server-ското съобщение directно — НИКАКВО UI тук не бива да
   * изглежда като "готово, профилът е изтрит".
   */
  pendingNotice: string | null,
): string {
  if (!deletePopupOpen || !profileId) return ''

  // Заключва само submit бутона (не Cancel/Close) — pending статусът е
  // персистентен server-side до края на мача, за разлика от submitting
  // (кратко in-flight състояние); admin-ът трябва винаги да може да
  // затвори popup-а.
  const isSubmitLocked = submitting || pendingNotice !== null

  return renderModerationPopupShell(`
    <div style="font-size:18px;font-weight:900;color:#f8fafc;margin-bottom:14px;">Изтриване на профил</div>
    <div style="font-size:14px;color:rgba(226,232,240,0.85);line-height:1.55;margin-bottom:18px;">
      Сигурни ли сте, че искате да изтриете профил ${escapeHtml(displayName)}?<br/><br/>
      Профилът ще бъде изтрит окончателно, а потребителското име и имейл адресът ще бъдат освободени за нова регистрация.<br/><br/>
      <strong style="color:#fca5a5;">Това действие не може да бъде отменено.</strong>
    </div>
    <form data-player-profile-delete-form="1" style="display:flex;flex-direction:column;gap:14px;">
      <label style="display:flex;flex-direction:column;gap:6px;">
        <span style="font-size:13px;font-weight:800;color:rgba(226,232,240,0.85);">Причина за изтриване</span>
        <textarea
          data-player-profile-delete-reason-input="1"
          rows="3"
          maxlength="2000"
          ${submitting ? 'disabled' : ''}
          style="
            resize:vertical;
            min-height:72px;
            border-radius:8px;
            border:1px solid rgba(212,165,32,0.45);
            background:#050505;
            color:#f8fafc;
            padding:10px 12px;
            font-size:14px;
            font-weight:500;
            outline:none;
            font-family:inherit;
          "
        >${escapeHtml(reasonDraft)}</textarea>
      </label>
      ${errorText ? `<div data-player-profile-delete-error="1" style="font-size:12px;font-weight:800;color:#fca5a5;">${escapeHtml(errorText)}</div>` : ''}
      ${pendingNotice ? `<div data-player-profile-delete-pending-notice="1" style="font-size:12px;font-weight:800;color:#fbbf24;line-height:1.5;padding:10px 12px;border-radius:8px;border:1px solid rgba(251,191,36,0.35);background:rgba(251,191,36,0.08);">${escapeHtml(pendingNotice)}</div>` : ''}
      <div style="display:flex;gap:10px;margin-top:4px;">
        <button
          type="button"
          data-player-profile-delete-cancel="1"
          ${submitting ? 'disabled' : ''}
          style="
            flex:1;
            height:42px;
            border:1px solid rgba(255,255,255,0.16);
            border-radius:8px;
            background:#080808;
            color:#f8fafc;
            font-size:14px;
            font-weight:800;
            cursor:pointer;
          "
        >${pendingNotice ? 'Затвори' : 'Отказ'}</button>
        <button
          type="submit"
          data-player-profile-delete-submit="1"
          ${isSubmitLocked ? 'disabled' : ''}
          style="
            flex:1;
            height:42px;
            border:0;
            border-radius:8px;
            background:linear-gradient(180deg, rgba(220,38,38,0.92) 0%, rgba(185,28,28,0.95) 100%);
            color:#fff1f2;
            font-size:14px;
            font-weight:900;
            cursor:${isSubmitLocked ? 'default' : 'pointer'};
            opacity:${isSubmitLocked ? '0.65' : '1'};
          "
        >${submitting ? 'Изчакай…' : pendingNotice ? 'Насрочено за изтриване' : 'Изтрий окончателно'}</button>
      </div>
    </form>
  `)
}

// ══════════════ Фаза 8 — "Кампании" в профилния popup ══════════════
// §2/§3 (активно каре под "Ранг"), §4 ("Виж всички награди" expand в
// рамките на същия popup), §5/§6 (горна навигация "Кампании" -> последна
// приключила кампания). Всички стойности идват от сървъра
// (campaignCreditStore.ts::getProfileCampaignSummary) — нищо тук не е
// hardcoded количество/име, виж task spec §3 doc коментара в
// campaignCreditStore.ts за пълния "не бъркай достигнат праг с успешно
// предоставена награда" rationale.

function formatCampaignUnitsLabel(amount: number, singular: string, plural: string): string {
  const unitLabel = Math.abs(amount) === 1 ? singular : plural
  return `${new Intl.NumberFormat('bg-BG').format(amount)} ${escapeHtml(unitLabel)}`
}

/** Кратко описание на ЕДНА награда — reuse-вано И в компактния "следваща награда" ред (§3), И във всеки ред на "Виж всички награди" (§4). */
function renderCampaignRewardDescriptionHtml(reward: PlayerCampaignTierRewardView): string {
  if (reward.rewardType === 'yellow_coins') {
    return `
      <span style="display:inline-flex;align-items:center;gap:6px;white-space:nowrap;">
        <img src="/assets/lobby/icon-coin.png" alt="" style="width:16px;height:16px;display:block;object-fit:contain;flex:0 0 auto;" />
        ${escapeHtml(new Intl.NumberFormat('bg-BG').format(reward.amount))} жълтици
      </span>
    `
  }

  if (reward.rewardType === 'vip_days') {
    return `
      <span style="display:inline-flex;align-items:center;gap:6px;white-space:nowrap;color:#d4a520;font-weight:900;">
        ${escapeHtml(String(reward.days))} VIP ${reward.days === 1 ? 'ден' : 'дни'}
      </span>
    `
  }

  // gift_item — действителното име/изображение от каталога, когато е налично (§4); fallback текст иначе.
  const giftImageHtml = reward.imageUrl
    ? `<img src="${escapeHtml(reward.imageUrl)}" alt="" style="width:20px;height:20px;display:block;object-fit:contain;flex:0 0 auto;border-radius:4px;" />`
    : ''
  return `
    <span style="display:inline-flex;align-items:center;gap:6px;min-width:0;">
      ${giftImageHtml}
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(reward.name ?? 'Подарък')}</span>
    </span>
  `
}

function renderCampaignTierRewardStatusBadgeHtml(status: PlayerCampaignTierRewardEntry['status']): string {
  if (status === 'granted') {
    return `<span style="font-size:11px;font-weight:900;color:#86efac;white-space:nowrap;">Получена</span>`
  }
  if (status === 'pending') {
    return `<span style="font-size:11px;font-weight:900;color:#fbbf24;white-space:nowrap;">Очаква предоставяне</span>`
  }
  return `<span style="font-size:11px;font-weight:800;color:rgba(226,232,240,0.55);white-space:nowrap;">Заключена</span>`
}

/** Най-кратък вид на ЕДНА награда за първия ред на компактното каре: жълтици -> иконка + число, VIP -> "N VIP дни", подарък -> картинка + съкратено име. */
function renderCampaignRewardCompactHtml(reward: PlayerCampaignTierRewardView): string {
  if (reward.rewardType === 'yellow_coins') {
    return `
      <span style="display:inline-flex;align-items:center;gap:4px;white-space:nowrap;">
        <img src="/assets/lobby/icon-coin.png" alt="" style="width:15px;height:15px;display:block;object-fit:contain;flex:0 0 auto;" />
        ${escapeHtml(new Intl.NumberFormat('bg-BG', { useGrouping: 'always' }).format(reward.amount))}
      </span>
    `
  }
  if (reward.rewardType === 'vip_days') {
    return `<span style="white-space:nowrap;color:#d4a520;">${escapeHtml(String(reward.days))} VIP ${reward.days === 1 ? 'ден' : 'дни'}</span>`
  }
  const giftImageHtml = reward.imageUrl
    ? `<img src="${escapeHtml(reward.imageUrl)}" alt="" style="width:16px;height:16px;display:block;object-fit:contain;flex:0 0 auto;border-radius:3px;" />`
    : ''
  return `
    <span style="display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:110px;">
      ${giftImageHtml}
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(reward.name ?? 'Подарък')}</span>
    </span>
  `
}

/** Следващата награда в първия ред на карето под "Ранг" — първата награда на прага + "+N", ако има още (пълният списък е във "Виж всички награди"). */
function renderCampaignTierRewardsCompactHtml(tier: PlayerCampaignTierView): string {
  const [first, ...rest] = tier.rewards
  if (first === undefined) return ''
  return `
    <span data-player-profile-campaign-next-rewards="1" style="display:inline-flex;align-items:center;gap:6px;min-width:0;">
      ${renderCampaignRewardCompactHtml(first.reward)}
      ${rest.length > 0 ? `<span style="flex:0 0 auto;font-size:12px;color:#d4a520;">+${rest.length}</span>` : ''}
    </span>
  `
}

/** Един праг в "Виж всички награди" списъка (§4) — threshold + всички награди + статус на всяка. */
function renderCampaignAllRewardsTierRowHtml(tier: PlayerCampaignTierView, unitNameSingular: string, unitNamePlural: string): string {
  return `
    <div
      data-player-profile-campaign-tier-row="1"
      style="
        display:flex;
        flex-direction:column;
        gap:8px;
        padding:12px 14px;
        border-radius:10px;
        background:rgba(255,255,255,0.04);
        border:1px solid rgba(255,255,255,0.08);
      "
    >
      <div style="font-size:14px;font-weight:900;color:#d4a520;">
        ${formatCampaignUnitsLabel(tier.thresholdUnits, unitNameSingular, unitNamePlural)}
      </div>
      ${tier.rewards.map((entry) => `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
          <div style="font-size:13px;font-weight:700;color:#f8fafc;">${renderCampaignRewardDescriptionHtml(entry.reward)}</div>
          ${renderCampaignTierRewardStatusBadgeHtml(entry.status)}
        </div>
      `).join('')}
    </div>
  `
}

/** "Виж всички награди" — пълният, разгъваем списък (§4), toggle-нат от бутона в renderActiveCampaignCard. Скролва заедно с останалата част от popup-а (card-ът вече е overflow:auto), не отваря отделен модал. */
function renderCampaignAllRewardsPanelHtml(active: ActiveCampaignProfileProgress, expanded: boolean): string {
  if (!expanded) return ''

  return `
    <div
      data-player-profile-campaign-all-rewards-panel="1"
      style="
        display:flex;
        flex-direction:column;
        gap:10px;
        margin-top:4px;
      "
    >
      ${active.tiers.map((tier) => renderCampaignAllRewardsTierRowHtml(tier, active.unitNameSingular, active.unitNamePlural)).join('')}
    </div>
  `
}

/** Активната кампания — карето веднага под "Ранг" (§2/§3). */
function renderActiveCampaignCard(active: ActiveCampaignProfileProgress, allRewardsExpanded: boolean): string {
  const nextTier = active.nextIncompleteTier
  const progressThreshold = nextTier?.thresholdUnits ?? active.unitsTotal
  const ratio = progressThreshold > 0 ? Math.max(0, Math.min(1, active.unitsTotal / progressThreshold)) : 1
  const format = (value: number) => new Intl.NumberFormat('bg-BG').format(value)
  // Качената иконка на кампанията (динамична; липсваща/счупена -> просто не се показва).
  const unitIconHtml = (sizePx: number) => active.unitIconUrl
    ? `<img src="${escapeHtml(active.unitIconUrl)}" alt="" style="width:${sizePx}px;height:${sizePx}px;margin:-8px 0;display:block;object-fit:contain;flex:0 0 auto;" onerror="this.style.display='none'" />`
    : ''
  const hintText = `Всяка спечелена игра или покупка ви носи ${escapeHtml(active.unitNamePlural.toLocaleLowerCase('bg-BG'))}`

  // Компактен първи ред: име вляво; следващата награда + прогрес вдясно.
  // Всички прагове са напълно предоставени — §3: "Всички награди са получени!"
  const allCollected = nextTier === null
  const rightSideHtml = allCollected
    ? `<span data-player-profile-campaign-all-collected="1" style="color:#86efac;white-space:nowrap;">Всички награди са получени!</span>`
    : `
      ${renderCampaignTierRewardsCompactHtml(nextTier)}
      <span data-player-profile-campaign-progress="1" style="flex:0 0 auto;white-space:nowrap;color:${themed('#f8fafc', LIGHT_TEXT)};">${format(active.unitsTotal)}/${format(progressThreshold)}</span>
    `

  return `
    <div
      data-player-profile-campaign-card="1"
      style="
        border-radius:${themed('8px', '12px')};
        background:${themed('linear-gradient(180deg, rgba(22,22,22,0.98) 0%, rgba(8,8,8,0.99) 100%)', '#FFFFFF')};
        border:1px solid ${themed('rgba(212,165,32,0.42)', LIGHT_VIOLET)};
        padding:10px 12px;
        box-shadow:${themed('inset 0 0 18px rgba(212,165,32,0.04)', '0 4px 14px rgba(34,30,80,0.06)')};
      "
    >
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;min-width:0;">
        <span data-player-profile-campaign-title="1" style="flex:1 1 auto;min-width:0;display:inline-flex;align-items:center;gap:6px;font-size:15px;font-weight:900;color:${themed('#f8fafc', LIGHT_TEXT)};">
          <span title="${escapeHtml(active.campaignName)}" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Събирай</span>
          ${unitIconHtml(36)}
          ${allCollected ? `<span data-player-profile-campaign-total="1" style="flex:0 0 auto;white-space:nowrap;">${format(active.unitsTotal)}</span>` : ''}
        </span>
        <span style="display:inline-flex;align-items:center;gap:10px;flex:0 0 auto;font-size:13px;font-weight:900;color:${themed('#f8fafc', LIGHT_TEXT)};">
          ${rightSideHtml}
        </span>
      </div>

      <div style="height:12px;border-radius:999px;background:${themed('#050505', '#EEF0F6')};border:1px solid ${themed('rgba(255,255,255,0.08)', LIGHT_BORDER)};overflow:hidden;">
        <div
          style="
            width:${(ratio * 100).toFixed(2)}%;
            height:100%;
            border-radius:999px;
            background:${themed('linear-gradient(90deg, #d4a520 0%, #f4c95b 100%)', 'linear-gradient(90deg, #8961F0 0%, #7950E8 100%)')};
            box-shadow:${themed('0 0 12px rgba(212,165,32,0.36)', 'none')};
          "
        ></div>
      </div>

      <div data-player-profile-campaign-actions="1" style="display:flex;align-items:center;flex-wrap:wrap;justify-content:space-between;gap:6px 10px;margin-top:8px;min-width:0;">
        ${active.tiers.length > 0 ? `
          <button
            type="button"
            data-player-profile-campaign-view-all-rewards="1"
            style="
              flex:0 0 auto;
              min-height:30px;
              padding:0 12px;
              border:1px solid ${themed('rgba(212,165,32,0.45)', '#D9CCFA')};
              border-radius:8px;
              background:${themed('rgba(212,165,32,0.08)', '#F4F0FF')};
              color:${themed('#d4a520', LIGHT_VIOLET)};
              font-size:12px;
              font-weight:900;
              cursor:pointer;
            "
          >${allRewardsExpanded ? 'Скрий наградите' : allCollected ? 'Всички събрани награди' : 'Виж всички награди'}</button>
        ` : ''}
        <span data-player-profile-campaign-hint="1" style="margin-left:auto;max-width:100%;min-width:0;font-size:12px;font-weight:800;line-height:1.25;color:${themed('rgba(226,232,240,0.78)', LIGHT_MUTED)};text-align:right;">${hintText}</span>
      </div>

      ${renderCampaignAllRewardsPanelHtml(active, allRewardsExpanded)}
    </div>
  `
}

/** Горна навигация "Кампании" (§5) — компактна лента НАД заглавието "Профил на играч", изградена да поема бъдещи допълнителни бутони. */
function renderCampaignNavBarHtml(campaignSummary: PlayerCampaignProfileSummary | null | undefined): string {
  if (!campaignSummary) return ''

  return `
    <div
      data-player-profile-nav-bar="1"
      style="
        display:flex;
        align-items:center;
        gap:8px;
        margin-bottom:14px;
      "
    >
      <button
        type="button"
        data-player-profile-campaigns-nav="1"
        style="
          min-height:32px;
          padding:0 14px;
          border:1px solid ${themed('rgba(212,165,32,0.45)', '#D9CCFA')};
          border-radius:999px;
          background:${themed('rgba(212,165,32,0.10)', '#F4F0FF')};
          color:${themed('#d4a520', LIGHT_VIOLET)};
          font-size:12px;
          font-weight:900;
          cursor:pointer;
          white-space:nowrap;
        "
      >Кампании</button>
    </div>
  `
}

/** Панел на последната приключила/спряна кампания (§6/§7), показан след клик на "Кампании" от горната навигация. */
function renderLastFinishedCampaignPanelHtml(
  campaignSummary: PlayerCampaignProfileSummary | null | undefined,
  historyOpen: boolean,
): string {
  if (!campaignSummary || !historyOpen) return ''

  const lastFinished = campaignSummary.lastFinished

  const bodyHtml = lastFinished === null
    ? `<div style="font-size:13px;font-weight:700;color:${themed('rgba(226,232,240,0.70)', LIGHT_MUTED)};">Няма предишна приключила кампания.</div>`
    : `
      <div style="font-size:15px;font-weight:900;color:${themed('#f8fafc', LIGHT_TEXT)};">${escapeHtml(lastFinished.campaignName)}</div>
      <div style="margin-top:6px;font-size:13px;font-weight:700;color:${themed('rgba(226,232,240,0.80)', LIGHT_MUTED)};">
        Общо събрани: ${formatCampaignUnitsLabel(lastFinished.unitsTotal, lastFinished.unitNameSingular, lastFinished.unitNamePlural)}
      </div>
    `

  return `
    <div
      data-player-profile-campaign-history-panel="1"
      style="
        border-radius:${themed('10px', '12px')};
        background:${themed('rgba(255,255,255,0.04)', '#FFFFFF')};
        border:1px solid ${themed('rgba(255,255,255,0.08)', LIGHT_VIOLET)};
        padding:14px;
        margin-bottom:14px;
      "
    >
      ${bodyHtml}
    </div>
  `
}

// Админ контролите до името на чужд профил (Редакция за admin, роли, "Дай
// VIP") — общи за стария изглед и за светлия hero на чужд профил.
function renderForeignAdminTitleControls(
  profileId: string | null,
  canEdit: boolean,
  isAdmin: boolean,
  isOwnProfile: boolean,
  viewerIsFullAdmin: boolean,
  targetAccountRole: PlayerAccountRole | null,
  vipGrantOpen: boolean,
): string {
  return `
            ${(canEdit || isAdmin) && !isOwnProfile ? `
              <span
                data-player-profile-edit="1"
                style="
                  display:inline-flex;
                  align-items:center;
                  gap:7px;
                  color:${themed('#f8fafc', '#6941C6')};
                  font-size:16px;
                  font-weight:400;
                  cursor:pointer;
                  white-space:nowrap;
                  padding-bottom:1px;
                "
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                Редакция
              </span>
            ` : ''}
            ${renderSubadminRoleControls(isOwnProfile, viewerIsFullAdmin, targetAccountRole)}
            ${renderChatAdminRoleControls(isOwnProfile, viewerIsFullAdmin, targetAccountRole)}
            ${renderPikaTeamRoleControls(isOwnProfile, viewerIsFullAdmin, targetAccountRole)}
            ${renderTopChatAdminRoleControls(isOwnProfile, viewerIsFullAdmin, targetAccountRole)}
            ${renderMarketingRoleControls(isOwnProfile, viewerIsFullAdmin, targetAccountRole)}
            ${renderVipGrantTrigger(profileId, isOwnProfile, viewerIsFullAdmin, vipGrantOpen)}
  `
}

// Действията за чужд профил (харесване, приятелство, подаръци, блокиране,
// модерация) — общи за стария изглед и за светлия hero на чужд профил.
function renderForeignProfileActions(
  profile: PlayerPublicProfileSnapshot,
  displayName: string,
  friendshipAction: PlayerProfileFriendshipAction | null,
  showPikaSupportChatButton: boolean,
  showTopicsPersonalMessageButton: boolean,
  giftItemRecipientProfileId: string | null,
  giftShopRecipientProfileId: string | null,
  isOwnProfile: boolean,
  viewerCanProfileMute: boolean,
  targetMute: TopicMuteSnapshot | null | undefined,
  viewerIsFullAdmin: boolean,
  activeBan: ActiveProfileBanSnapshot | null | undefined,
): string {
  return `
            <div data-player-profile-actions="1" style="display:flex;flex-direction:column;align-items:flex-start;gap:8px;">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                ${showPikaSupportChatButton && profile.profileId ? `
                  <button
                    type="button"
                    data-player-profile-pika-support-chat="${escapeHtml(profile.profileId)}"
                    style="
                      min-height:38px;
                      padding:0 14px;
                      border:1px solid rgba(239,68,68,0.58);
                      border-radius:8px;
                      background:rgba(239,68,68,0.16);
                      color:#ef4444;
                      font-size:13px;
                      font-weight:900;
                      cursor:pointer;
                      display:flex;
                      align-items:center;
                      gap:6px;
                    "
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
                    Чат
                  </button>
                ` : ''}
                ${showTopicsPersonalMessageButton && profile.profileId ? `
                  <button
                    type="button"
                    data-player-profile-topics-personal-message="${escapeHtml(profile.profileId)}"
                    style="
                      min-height:38px;
                      padding:0 14px;
                      border:1px solid rgba(212,165,32,0.62);
                      border-radius:8px;
                      background:linear-gradient(180deg, rgba(244,201,91,0.98) 0%, rgba(201,143,19,0.98) 100%);
                      color:#080808;
                      font-size:13px;
                      font-weight:900;
                      cursor:pointer;
                      display:flex;
                      align-items:center;
                      gap:6px;
                    "
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                    Лично съобщение
                  </button>
                ` : ''}
                ${profile.profileId ? `
                  <button
                    type="button"
                    data-player-profile-like="${escapeHtml(profile.profileId)}"
                    ${profile.hasLikedByMe ? 'disabled' : ''}
                    style="
                      min-height:38px;
                      padding:0 14px;
                      border:1px solid rgba(212,165,32,0.62);
                      border-radius:8px;
                      background:${profile.hasLikedByMe ? 'rgba(212,165,32,0.12)' : 'linear-gradient(180deg, rgba(244,201,91,0.98) 0%, rgba(201,143,19,0.98) 100%)'};
                      color:${profile.hasLikedByMe ? '#f4c95b' : '#080808'};
                      font-size:13px;
                      font-weight:900;
                      cursor:${profile.hasLikedByMe ? 'default' : 'pointer'};
                      display:flex;
                      align-items:center;
                      gap:5px;
                      ${isLightTheme ? (profile.hasLikedByMe ? 'background:#F4F0FF;border-color:#D9CCFA;color:#6941C6;' : LIGHT_SECONDARY_BUTTON) : ''}
                    "
                  >
                    ${renderHeartIcon(14)}${profile.hasLikedByMe ? 'Харесан' : 'Харесай'}
                  </button>
                ` : ''}
                ${friendshipAction && !friendshipAction.giftFriendshipId ? `
                  <button
                    type="button"
                    data-player-profile-friend-request="${escapeHtml(friendshipAction.profileId)}"
                    ${friendshipAction.disabled ? 'disabled' : ''}
                    ${isLightTheme && !friendshipAction.disabled ? LIGHT_PRIMARY_3D_CLASS_ATTR : ''}
                    style="
                      min-height:38px;
                      padding:0 14px;
                      border:1px solid rgba(212,165,32,0.62);
                      border-radius:8px;
                      ${isLightTheme && !friendshipAction.disabled ? '' : `background:${friendshipAction.disabled ? 'rgba(255,255,255,0.07)' : 'linear-gradient(180deg, rgba(244,201,91,0.98) 0%, rgba(201,143,19,0.98) 100%)'};`}
                      color:${friendshipAction.disabled ? 'rgba(255,255,255,0.70)' : '#080808'};
                      font-size:13px;
                      font-weight:900;
                      cursor:${friendshipAction.disabled ? 'default' : 'pointer'};
                      ${isLightTheme ? (friendshipAction.disabled ? 'background:#F2F4F7;border-color:#E4E7EC;color:#98A2B3;' : LIGHT_PRIMARY_BUTTON) : ''}
                    "
                  >
                    ${escapeHtml(friendshipAction.label)}
                  </button>
                ` : ''}
                ${friendshipAction?.giftFriendshipId ? `
                    <button
                      type="button"
                      data-player-profile-gift-coins="${escapeHtml(friendshipAction.giftFriendshipId)}"
                      style="
                        min-height:38px;
                        padding:0 12px;
                        border:1px solid rgba(212,165,32,0.62);
                        border-radius:8px;
                        background:rgba(212,165,32,0.14);
                        color:#fde68a;
                        font-size:13px;
                        font-weight:900;
                        cursor:pointer;
                        ${isLightTheme ? LIGHT_SECONDARY_BUTTON : ''}
                      "
                    >
                      Подари жълтици
                    </button>
                  ` : ''}
                ${!friendshipAction?.giftFriendshipId && friendshipAction?.giftBypassProfileId ? `
                    <button
                      type="button"
                      data-player-profile-gift-coins-bypass="${escapeHtml(friendshipAction.giftBypassProfileId)}"
                      style="
                        min-height:38px;
                        padding:0 12px;
                        border:1px solid rgba(212,165,32,0.62);
                        border-radius:8px;
                        background:rgba(212,165,32,0.14);
                        color:#fde68a;
                        font-size:13px;
                        font-weight:900;
                        cursor:pointer;
                        ${isLightTheme ? LIGHT_SECONDARY_BUTTON : ''}
                      "
                    >
                      Подари жълтици
                    </button>
                  ` : ''}
                ${giftItemRecipientProfileId ? `
                    <button
                      type="button"
                      data-player-profile-gift-item="${escapeHtml(giftItemRecipientProfileId)}"
                      style="
                        min-height:38px;
                        padding:0 12px;
                        border:1px solid rgba(212,165,32,0.62);
                        border-radius:8px;
                        background:rgba(212,165,32,0.14);
                        color:#fde68a;
                        font-size:13px;
                        font-weight:900;
                        cursor:pointer;
                        ${isLightTheme ? LIGHT_SECONDARY_BUTTON : ''}
                        display:inline-flex;
                        align-items:center;
                        gap:6px;
                      "
                    >
                      ${renderGiftBoxIcon(17)}Подарък
                    </button>
                  ` : ''}
                ${giftShopRecipientProfileId ? `
                    <button
                      type="button"
                      data-player-profile-gift-shop="${escapeHtml(giftShopRecipientProfileId)}"
                      ${isLightTheme ? LIGHT_PRIMARY_3D_CLASS_ATTR : ''}
                      style="
                        min-height:38px;
                        padding:0 12px;
                        border:1px solid rgba(212,165,32,0.62);
                        border-radius:8px;
                        ${isLightTheme ? '' : 'background:linear-gradient(180deg, rgba(244,201,91,0.98) 0%, rgba(201,143,19,0.98) 100%);'}
                        color:#080808;
                        font-size:13px;
                        font-weight:900;
                        cursor:pointer;
                        ${isLightTheme ? LIGHT_PRIMARY_BUTTON : ''}
                        display:inline-flex;
                        align-items:center;
                        gap:6px;
                      "
                    >
                      ${renderGiftBoxIcon(17)}Подари авоари
                    </button>
                  ` : ''}
                ${profile.profileId && profile.isBlockedByMe !== null ? `
                  <button
                    type="button"
                    data-player-profile-block="${escapeHtml(profile.profileId)}"
                    style="
                      min-height:38px;
                      padding:0 12px;
                      border:1px solid rgba(248,113,113,0.60);
                      border-radius:8px;
                      background:${profile.isBlockedByMe
                        ? 'rgba(255,255,255,0.07)'
                        : 'linear-gradient(180deg, rgba(220,38,38,0.88) 0%, rgba(185,28,28,0.92) 100%)'};
                      color:${profile.isBlockedByMe ? 'rgba(255,255,255,0.50)' : '#fff1f2'};
                      font-size:13px;
                      font-weight:900;
                      cursor:pointer;
                      ${isLightTheme && profile.isBlockedByMe ? 'background:#FFFFFF;border-color:#FDA29B;color:#B42318;' : ''}
                    "
                  >
                    ${profile.isBlockedByMe ? 'Деблокирай' : 'Блокирай'}
                  </button>
                ` : ''}
                ${renderProfileMuteActionButton(profile.profileId, displayName, isOwnProfile, viewerCanProfileMute, targetMute)}
                ${renderModerationControls(profile.profileId, isOwnProfile, viewerIsFullAdmin, activeBan)}
              </div>
              ${friendshipAction?.message ? `
                <div style="font-size:12px;font-weight:800;color:${themed('#fde68a', LIGHT_MUTED)};line-height:1.35;">
                  ${escapeHtml(friendshipAction.message)}
                </div>
              ` : ''}
            </div>
  `
}

function renderProfileContent(
  profile: PlayerPublicProfileSnapshot,
  seat: Seat | null,
  canEdit: boolean,
  isOwnProfile: boolean,
  isAdmin: boolean,
  friendshipAction: PlayerProfileFriendshipAction | null,
  viewerIsFullAdmin: boolean,
  targetAccountRole: PlayerAccountRole | null,
  showPikaSupportChatButton: boolean,
  showTopicsPersonalMessageButton: boolean,
  ownVipActiveUntil: string | null | undefined,
  vipGrantOpen: boolean,
  vipGrantSubmitting: boolean,
  vipGrantErrorText: string | null,
  activeBan: ActiveProfileBanSnapshot | null | undefined,
  targetMute: TopicMuteSnapshot | null | undefined,
  viewerCanProfileMute: boolean,
  banPopupOpen: boolean,
  banPopupDaysDraft: string,
  banPopupReasonDraft: string,
  banPopupSubmitting: boolean,
  banPopupErrorText: string | null,
  unbanConfirmOpen: boolean,
  unbanSubmitting: boolean,
  deletePopupOpen: boolean,
  deletePopupReasonDraft: string,
  deletePopupSubmitting: boolean,
  deletePopupErrorText: string | null,
  deletePopupPendingNotice: string | null,
  riskDetailLoading: boolean,
  riskDetailRows: AdminProfileLinkedProfileRow[] | null | undefined,
  riskDetailErrorText: string | null,
  riskRecheckSubmitting: boolean,
  giftItemRecipientProfileId: string | null,
  giftShopRecipientProfileId: string | null,
  campaignSummary: PlayerCampaignProfileSummary | null | undefined,
  campaignAllRewardsExpanded: boolean,
  canSelfDelete: boolean,
): string {
  const displayName = profile.displayName?.trim() || formatSeatLabel(seat)

  return `
    <div
      style="
        display:flex;
        flex-direction:column;
        gap:18px;
      "
    >
      ${isOwnRichLayout || isForeignRichLayout ? `
        ${isForeignRichLayout ? renderVipGrantForm(profile.profileId, isOwnProfile, viewerIsFullAdmin, vipGrantOpen, vipGrantSubmitting, vipGrantErrorText) : ''}
        ${renderRankProgress(profile)}
        ${renderGameStats(profile)}
        ${campaignSummary?.active ? renderActiveCampaignCard(campaignSummary.active, campaignAllRewardsExpanded) : ''}
      ` : `
      <div
        data-player-profile-summary-grid="1"
        style="
          display:grid;
          grid-template-columns:124px minmax(0, 1fr);
          gap:18px;
          align-items:stretch;
        "
      >
        <div data-player-profile-avatar="1" style="position:relative;width:124px;height:124px;flex:0 0 124px;">
          <div
            style="
              width:100%;
              height:100%;
              border-radius:${themed('20px', '8px')};
              overflow:hidden;
              background:${themed('rgba(255,255,255,0.06)', '#FFFFFF')};
              border:1px solid ${themed('rgba(255,255,255,0.10)', LIGHT_BORDER)};
              box-shadow:${themed('0 14px 28px rgba(0,0,0,0.22)', '0 6px 18px rgba(34,30,80,0.10)')};
            "
          >
            ${renderAvatar(profile, seat)}
          </div>
          ${renderLevelBadge(profile.level)}
          ${targetMute?.isMuted ? renderProfileAvatarMuteOverlay(profile.profileId ?? '', displayName) : ''}
          ${friendshipAction?.giftFriendshipId ? `
            <div style="
              position:absolute;
              bottom:-11px;
              left:50%;
              transform:translateX(-50%);
              background:linear-gradient(180deg,#22c55e 0%,#16a34a 100%);
              color:#fff;
              font-size:11px;
              font-weight:900;
              white-space:nowrap;
              padding:3px 10px;
              border-radius:999px;
              border:2px solid ${themed('#0a0a0a', '#FFFFFF')};
              letter-spacing:0.3px;
            ">✓ Приятел</div>
          ` : ''}
        </div>

        <div
          data-player-profile-info="1"
          style="
            min-width:0;
            display:flex;
            flex-direction:column;
            gap:10px;
            padding-top:4px;
          "
        >
          <div data-player-profile-title="1" style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;width:100%;">
            <div
              style="
                font-size:22px;
                line-height:1.05;
                font-weight:900;
                color:${themed('#22c55e', LIGHT_TEXT)};
                word-break:break-word;
              "
            >
              ${escapeHtml(displayName)}
            </div>

            ${renderForeignAdminTitleControls(profile.profileId, canEdit, isAdmin, isOwnProfile, viewerIsFullAdmin, targetAccountRole, vipGrantOpen)}
          </div>

          ${renderVipGrantForm(profile.profileId, isOwnProfile, viewerIsFullAdmin, vipGrantOpen, vipGrantSubmitting, vipGrantErrorText)}

          ${isOwnProfile ? renderOwnProfileSummary(profile, ownVipActiveUntil, canSelfDelete) : renderForeignProfileSummary(profile, viewerIsFullAdmin)}

          <div data-player-profile-rating="1" style="display:flex;align-items:center;gap:6px;">
            <div style="font-size:13px;font-weight:400;color:${themed('rgba(148,163,184,0.80)', LIGHT_MUTED)};">Рейтинг:</div>
            <div style="font-size:13px;font-weight:${themed('400', '700')};color:${themed('#d4a520', LIGHT_TEXT)};">${formatNullableText(profile.skillRating)}</div>
            ${renderRatingInline(profile)}
          </div>

          ${!canEdit && !isOwnProfile ? renderForeignProfileActions(profile, displayName, friendshipAction, showPikaSupportChatButton, showTopicsPersonalMessageButton, giftItemRecipientProfileId, giftShopRecipientProfileId, isOwnProfile, viewerCanProfileMute, targetMute, viewerIsFullAdmin, activeBan) : ''}

          <div data-player-profile-stats="1" style="display:flex;align-items:center;margin-top:auto;padding-bottom:2px;">
            <div data-player-profile-stat="1" style="font-size:13px;color:${themed('rgba(255,255,255,0.55)', LIGHT_MUTED)};padding-right:12px;">
              Ниво: <span data-player-profile-stat-value="1" style="color:${themed('#fde68a', LIGHT_TEXT)};font-weight:700;">${formatNullableText(profile.level)}</span>
            </div>
            <div data-player-profile-stat-divider="1" style="width:1px;align-self:stretch;background:${themed('rgba(212,165,32,0.45)', '#D0D5DD')};"></div>
            <div data-player-profile-stat="1" style="font-size:13px;color:${themed('rgba(255,255,255,0.55)', LIGHT_MUTED)};padding:0 12px;">
              Ранг: <span data-player-profile-stat-value="1" style="color:${themed('#fde68a', LIGHT_TEXT)};font-weight:700;">${formatNullableText(profile.rankTitle)}</span>
            </div>
            ${typeof profile.likesCount === 'number' ? `
            <div data-player-profile-stat-divider="1" style="width:1px;align-self:stretch;background:${themed('rgba(212,165,32,0.45)', '#D0D5DD')};"></div>
            <div data-player-profile-stat="1" style="font-size:13px;color:${themed('rgba(255,255,255,0.55)', LIGHT_MUTED)};padding:0 12px;">
              ${renderHeartIcon(14)} Харесан: <span data-player-profile-stat-value="1" style="color:${themed('#fde68a', LIGHT_TEXT)};font-weight:700;">${profile.likesCount.toLocaleString('bg-BG')}</span>
            </div>
            ` : ''}
          </div>
        </div>
      </div>

      ${renderRankProgress(profile)}

      ${campaignSummary?.active ? renderActiveCampaignCard(campaignSummary.active, campaignAllRewardsExpanded) : ''}

      ${renderGameStats(profile)}
      `}

      <div
        data-player-profile-metric-grid="1"
        style="
          display:grid;
          grid-template-columns:1fr;
          gap:12px;
        "
      >
        <div
          data-player-profile-balance-card="1"
          data-player-profile-metric-card="1"
          hidden
          style="
            border-radius:16px;
            background:rgba(255,255,255,0.05);
            border:1px solid rgba(255,255,255,0.08);
            padding:14px;
          "
        >
          <div
            data-player-profile-metric-label="1"
            style="
              font-size:12px;
              font-weight:800;
              letter-spacing:0.12em;
              text-transform:uppercase;
              color:rgba(148,163,184,0.92);
              margin-bottom:8px;
            "
          >
            Жълтици
          </div>
          <div
            data-player-profile-metric-value="1"
            style="
              display:flex; align-items:center; gap:8px;
              font-size:26px;
              font-weight:900;
              color:#d4a520;
            "
          >
            <img src="/assets/lobby/icon-coin.png" alt="" style="width:26px; height:26px; display:block; object-fit:contain; flex-shrink:0;">
            ${profile.yellowCoinsBalance != null
              ? escapeHtml(Number(profile.yellowCoinsBalance).toLocaleString('bg-BG'))
              : '—'}
          </div>
        </div>

        <div
          data-player-profile-rating-card="1"
          data-player-profile-metric-card="1"
          hidden
          style="
            border-radius:16px;
            background:rgba(255,255,255,0.05);
            border:1px solid rgba(255,255,255,0.08);
            padding:14px;
          "
        >
          <div
            data-player-profile-metric-label="1"
            style="
              font-size:12px;
              font-weight:800;
              letter-spacing:0.12em;
              text-transform:uppercase;
              color:rgba(148,163,184,0.92);
              margin-bottom:8px;
            "
          >
            Средна оценка
          </div>
          <div
            data-player-profile-rating-value-row="1"
            style="
              display:flex;
              align-items:baseline;
              gap:8px;
              flex-wrap:wrap;
            "
          >
            <div
              data-player-profile-metric-value="1"
              style="
                font-size:26px;
                font-weight:900;
                color:#f8fafc;
              "
            >
              ${formatAverageRating(profile.averageRating)}
            </div>
            <div
              data-player-profile-rating-count="1"
              style="
                font-size:15px;
                color:rgba(226,232,240,0.72);
                font-weight:700;
              "
            >
              Оценки: ${formatNullableText(profile.totalRatingsCount)}
            </div>
          </div>
        </div>
      </div>

      <div
        style="
          display:flex;
          flex-direction:column;
          gap:10px;
        "
      >
        <div
          style="
            font-size:13px;
            font-weight:900;
            letter-spacing:0.12em;
            text-transform:uppercase;
            color:${themed('rgba(148,163,184,0.92)', LIGHT_MUTED)};
          "
        >
          Галерия
        </div>

        ${renderGallery(profile)}
      </div>

      ${renderRiskSection(profile.profileId, isOwnProfile, viewerIsFullAdmin, riskDetailLoading, riskDetailRows, riskDetailErrorText, riskRecheckSubmitting)}
    </div>
    ${renderBanPopup(profile.profileId, displayName, banPopupOpen, banPopupDaysDraft, banPopupReasonDraft, banPopupSubmitting, banPopupErrorText)}
    ${renderUnbanConfirmPopup(profile.profileId, displayName, unbanConfirmOpen, unbanSubmitting)}
    ${renderDeletePopup(profile.profileId, displayName, deletePopupOpen, deletePopupReasonDraft, deletePopupSubmitting, deletePopupErrorText, deletePopupPendingNotice)}
  `
}

export function renderPlayerProfilePopup(
  options: RenderPlayerProfilePopupOptions
): string {
  if (!options.isOpen) {
    return ''
  }

  isLightTheme = options.light === true
  isOwnRichLayout = isLightTheme && (options.isOwnProfile ?? false) && !options.isLoading && options.profile !== null
  isForeignRichLayout = isLightTheme && !(options.isOwnProfile ?? false) && !options.isLoading && options.profile !== null
  try {
    return renderPlayerProfilePopupHtml(options)
  } finally {
    isLightTheme = false
    isOwnRichLayout = false
    isForeignRichLayout = false
  }
}

function renderPlayerProfilePopupHtml(
  options: RenderPlayerProfilePopupOptions
): string {
  const popupBody = options.isLoading
    ? renderLoadingContent(options.seat)
    : options.profile
      ? renderProfileContent(
          options.profile,
          options.seat,
          options.canEdit ?? false,
          options.isOwnProfile ?? false,
          options.isAdmin ?? false,
          options.friendshipAction ?? null,
          options.viewerIsFullAdmin ?? false,
          options.targetAccountRole ?? null,
          options.showPikaSupportChatButton ?? false,
          options.showTopicsPersonalMessageButton ?? false,
          // НЕ "?? null" тук — undefined е explicit "not loaded yet" сигнал
          // (виж RenderPlayerProfilePopupOptions.ownVipActiveUntil doc-а).
          options.ownVipActiveUntil,
          options.vipGrantOpen ?? false,
          options.vipGrantSubmitting ?? false,
          options.vipGrantErrorText ?? null,
          options.activeBan ?? null,
          options.targetMute ?? null,
          options.viewerCanProfileMute ?? false,
          options.banPopupOpen ?? false,
          options.banPopupDaysDraft ?? '',
          options.banPopupReasonDraft ?? '',
          options.banPopupSubmitting ?? false,
          options.banPopupErrorText ?? null,
          options.unbanConfirmOpen ?? false,
          options.unbanSubmitting ?? false,
          options.deletePopupOpen ?? false,
          options.deletePopupReasonDraft ?? '',
          options.deletePopupSubmitting ?? false,
          options.deletePopupErrorText ?? null,
          options.deletePopupPendingNotice ?? null,
          options.riskDetailLoading ?? false,
          options.riskDetailRows ?? null,
          options.riskDetailErrorText ?? null,
          options.riskRecheckSubmitting ?? false,
          options.giftItemRecipientProfileId ?? null,
          options.giftShopRecipientProfileId ?? null,
          options.campaignSummary ?? null,
          options.campaignAllRewardsExpanded ?? false,
          (options.isOwnProfile ?? false) && (options.canSelfDelete ?? false),
        )
      : renderEmptyContent(options.seat, options.emptyMessage ?? null)

  return `
    <style>
      [data-player-profile-like]:not([disabled]):hover {
        filter: brightness(1.12);
        transform: translateY(-1px);
      }
      [data-player-profile-friend-request]:not([disabled]):hover {
        filter: brightness(1.12);
        transform: translateY(-1px);
      }
      [data-player-profile-block]:hover {
        filter: brightness(1.12);
        transform: translateY(-1px);
      }
      [data-player-profile-ban-open]:hover,
      [data-player-profile-delete-open]:hover,
      [data-player-profile-unban-open]:hover {
        filter: brightness(1.12);
        transform: translateY(-1px);
      }
      [data-player-profile-gift-coins]:hover,
      [data-player-profile-gift-coins-bypass]:hover,
      [data-player-profile-gift-item]:hover {
        background: rgba(212,165,32,0.28) !important;
        filter: brightness(1.1);
        transform: translateY(-1px);
      }
      [data-player-profile-pika-support-chat]:hover {
        background: rgba(239,68,68,0.28) !important;
        filter: brightness(1.1);
        transform: translateY(-1px);
      }
      [data-player-profile-topics-personal-message]:hover {
        filter: brightness(1.12);
        transform: translateY(-1px);
      }
      [data-player-profile-like],
      [data-player-profile-friend-request],
      [data-player-profile-block],
      [data-player-profile-ban-open],
      [data-player-profile-delete-open],
      [data-player-profile-unban-open],
      [data-player-profile-gift-coins],
      [data-player-profile-gift-coins-bypass],
      [data-player-profile-gift-item],
      [data-player-profile-pika-support-chat],
      [data-player-profile-topics-personal-message] {
        transition: filter 120ms ease, transform 120ms ease, background 120ms ease, border-color 120ms ease;
      }

      @keyframes belot-player-profile-fade-in {
        0% {
          opacity:0;
          transform:translateY(12px) scale(0.98);
        }
        100% {
          opacity:1;
          transform:translateY(0) scale(1);
        }
      }

      @keyframes belot-player-profile-backdrop-in {
        0% { opacity:0; }
        100% { opacity:1; }
      }

      @keyframes belot-player-profile-spin {
        100% {
          transform:rotate(360deg);
        }
      }

      @media (max-width: 640px) {
        [data-player-profile-summary-grid="1"] {
          grid-template-columns:124px minmax(0, 1fr) !important;
          gap:14px !important;
        }

        [data-player-profile-avatar="1"] {
          grid-column:1;
          grid-row:1 / span 3;
          order:1;
          justify-self:start !important;
        }

        [data-player-profile-info="1"] {
          display:contents !important;
        }

        [data-player-profile-stats="1"] {
          order:6;
          grid-column:1 / -1;
          display:grid !important;
          grid-template-columns:repeat(3, minmax(0, 1fr));
          gap:0;
          width:100%;
          margin-top:0 !important;
          padding:2px 0 0 !important;
        }

        [data-player-profile-title="1"] {
          order:2;
          grid-column:2;
        }

        [data-player-profile-own-summary="1"],
        [data-player-profile-foreign-summary="1"] {
          order:3;
          grid-column:2;
        }

        [data-player-profile-rating="1"] {
          order:4;
          grid-column:1 / -1;
          flex-wrap:nowrap;
        }

        [data-player-profile-inline-rating="1"] {
          width:100%;
          gap:6px !important;
          font-size:12px !important;
        }

        [data-player-profile-inline-rating-divider="1"] {
          display:inline-block !important;
        }

        [data-player-profile-actions="1"] {
          order:5;
          grid-column:1 / -1;
        }

        [data-player-profile-actions="1"] > div:first-child {
          width:100%;
          display:grid !important;
          grid-template-columns:repeat(3, 1fr);
          gap:6px;
        }

        [data-player-profile-actions="1"] button,
        [data-player-profile-active-ban="1"] {
          width:100% !important;
          min-width:0 !important;
          min-height:34px !important;
          padding:0 6px !important;
          font-size:11px !important;
          gap:4px !important;
          justify-content:center;
        }

        [data-player-profile-actions="1"] button svg {
          width:13px !important;
          height:13px !important;
          flex-shrink:0;
        }

        [data-player-profile-stat="1"] {
          padding:0 3px !important;
          text-align:center;
          font-size:11px !important;
          min-width:0;
          overflow:hidden;
          white-space:nowrap;
          text-overflow:ellipsis;
        }

        [data-player-profile-stat-value="1"] {
          display:inline;
          margin-top:0;
          overflow:hidden;
          text-overflow:ellipsis;
          white-space:nowrap;
        }

        [data-player-profile-stat="1"] > span:not([data-player-profile-stat-value]) {
          font-size:14px !important;
        }

        [data-player-profile-stat-divider="1"] {
          display:none !important;
        }

        [data-player-profile-metric-grid="1"] {
          display:none !important;
        }

        [data-player-profile-game-stats="1"] {
          gap:7px !important;
        }

        [data-player-profile-metric-card="1"] {
          border-radius:10px !important;
          padding:10px !important;
          min-height:74px;
          display:flex;
          flex-direction:column;
          justify-content:center;
        }

        [data-player-profile-metric-label="1"] {
          font-size:10px !important;
          line-height:1.15 !important;
          letter-spacing:0.08em !important;
          margin-bottom:6px !important;
        }

        [data-player-profile-metric-value="1"] {
          font-size:20px !important;
          line-height:1 !important;
          gap:5px !important;
          flex-wrap:nowrap !important;
          white-space:nowrap;
        }

        [data-player-profile-metric-value="1"] img {
          width:21px !important;
          height:21px !important;
        }

        [data-player-profile-rating-value-row="1"] {
          display:grid !important;
          gap:5px !important;
          align-items:start !important;
        }

        [data-player-profile-rating-count="1"] {
          font-size:12px !important;
          line-height:1.1 !important;
        }

        [data-player-profile-popup-card="1"] {
          position:fixed !important;
          inset:0 !important;
          width:100% !important;
          max-height:100% !important;
          height:100% !important;
          border-radius:0 !important;
          border-left:none !important;
          border-right:none !important;
          border-top:none !important;
          border-bottom:none !important;
        }

        [data-player-profile-campaign-actions="1"] {
          flex-direction:column-reverse !important;
          align-items:flex-start !important;
        }

        [data-player-profile-campaign-all-collected="1"] {
          display:none !important;
        }

        [data-player-profile-campaign-hint="1"] {
          margin-left:0 !important;
          text-align:left !important;
          font-weight:500 !important;
          font-size:clamp(10px, 3.2vw, 12px) !important;
          white-space:nowrap !important;
          max-width:100% !important;
          overflow:hidden !important;
          text-overflow:ellipsis !important;
        }

        [data-player-profile-nav-bar="1"] {
          margin-bottom:10px !important;
        }
      }
    </style>

    ${isLightTheme ? `
      <style>
        [data-player-profile-light="1"] [data-player-profile-gift-coins]:hover,
        [data-player-profile-light="1"] [data-player-profile-gift-coins-bypass]:hover,
        [data-player-profile-light="1"] [data-player-profile-gift-item]:hover {
          background: #F4F0FF !important;
        }
        /* Чужд профил (светъл hero): бутоните са с размерите на тези от
           собствения профил и се подреждат на редове според ширината си. */
        [data-player-profile-foreign-actions="1"] [data-player-profile-actions="1"] {
          align-items:stretch !important;
        }
        [data-player-profile-foreign-actions="1"] [data-player-profile-actions="1"] > div:first-child {
          display:flex !important;
          flex-wrap:wrap !important;
          justify-content:center;
          gap:8px !important;
          width:100%;
        }
        /* "Блокирай" не се разтяга — сам на ред остава компактен и центриран. */
        [data-player-profile-foreign-actions="1"] [data-player-profile-actions="1"] button[data-player-profile-block] {
          flex:0 0 auto;
        }
        [data-player-profile-foreign-actions="1"] [data-player-profile-actions="1"] button {
          flex:1 1 auto;
          width:auto !important;
          height:40px;
          min-height:40px !important;
          padding:0 10px !important;
          border-radius:8px !important;
          display:inline-flex !important;
          align-items:center;
          justify-content:center;
          gap:5px !important;
          font-family:inherit;
          font-size:13px !important;
          font-weight:800 !important;
          white-space:nowrap;
          box-sizing:border-box;
        }
        [data-player-profile-foreign-actions="1"] [data-player-profile-actions="1"] button svg {
          width:15px !important;
          height:15px !important;
        }
      </style>
    ` : ''}
    <div
      data-player-profile-popup-root="1"${isLightTheme ? '\n      data-player-profile-light="1"' : ''}
      style="
        position:fixed;
        inset:0;
        z-index:12000;
        pointer-events:auto;
      "
    >
      <div
        data-player-profile-popup-backdrop="1"
        style="
          position:absolute;
          inset:0;
          background:${themed('rgba(0, 0, 0, 0.72)', 'rgba(20,20,43,0.45)')};
          -webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);
          animation:${options.skipAnimation ? 'none' : 'belot-player-profile-backdrop-in 140ms ease both'};
        "
      ></div>

      <div
        style="
          position:absolute;
          inset:0;
          display:flex;
          align-items:center;
          justify-content:center;
          padding:24px;
        "
      >
        <div
          data-player-profile-popup-card="1"
          role="dialog"
          aria-modal="true"
          aria-label="Профил на играч"
          class="gold-scrollbar"
          style="
            position:relative;
            box-sizing:border-box;
            width:min(92vw, 760px);
            max-height:min(88vh, 860px);
            overflow:auto;
            border-radius:${themed('8px', '12px')};
            background:${themed('linear-gradient(180deg, rgba(32,32,32,0.98) 0%, rgba(8,8,8,0.99) 100%)', LIGHT_PROFILE_PAGE_BACKGROUND)};
            border:${themed('2px solid rgba(212,165,32,0.72)', '1px solid #E4E7EC')};
            box-shadow:${themed('0 34px 80px rgba(0,0,0,0.42)', '0 20px 48px rgba(23,35,60,0.18)')};
            ${isLightTheme ? "font-family:system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;color:#17233C;" : ''}
            padding:${isOwnRichLayout || isForeignRichLayout ? '0' : '24px 24px 22px'};
            animation:${options.skipAnimation ? 'none' : 'belot-player-profile-fade-in 160ms ease both'};
          "
        >
          ${(isOwnRichLayout || isForeignRichLayout) && options.profile ? `
            <div ${isOwnRichLayout ? 'data-player-profile-own-layout="1"' : 'data-player-profile-foreign-layout="1"'} style="display:flex;flex-direction:column;min-height:100%;">
              ${isOwnRichLayout
                ? renderProfileHero(options.profile, options.seat, { ownVipActiveUntil: options.ownVipActiveUntil, canSelfDelete: (options.isOwnProfile ?? false) && (options.canSelfDelete ?? false) }, null)
                : renderForeignRichProfileHero(options.profile, options)}
              <div style="padding:16px 16px 20px;">
                ${renderCampaignNavBarHtml(options.campaignSummary)}
                ${renderLastFinishedCampaignPanelHtml(options.campaignSummary, options.campaignHistoryOpen ?? false)}
                ${popupBody}
              </div>
              <img data-player-profile-own-footer="1" src="${OWN_PROFILE_ASSETS}/profile-footer-waves.webp" alt="" aria-hidden="true" width="1236" height="156" style="display:block;width:100%;height:auto;margin-top:auto;flex:0 0 auto;pointer-events:none;user-select:none;">
            </div>
          ` : `
          ${renderCampaignNavBarHtml(options.campaignSummary)}

          <div
            style="
              display:flex;
              align-items:center;
              justify-content:space-between;
              gap:16px;
              margin-bottom:18px;
            "
          >
            <div
              style="
                min-width:0;
                display:flex;
                flex-direction:column;
                gap:6px;
              "
            >
              <div
                style="
                  font-size:13px;
                  font-weight:800;
                  letter-spacing:0.14em;
                  text-transform:uppercase;
                  color:${themed('rgba(148,163,184,0.92)', LIGHT_MUTED)};
                "
              >
                Профил на играч
              </div>

            </div>

            <button
              type="button"
              data-player-profile-popup-close="1"
              aria-label="Затвори"
              style="
                width:42px;
                height:42px;
                border:${themed('none', '1px solid #E53935')};
                ${isLightTheme ? 'box-sizing:border-box;' : ''}
                border-radius:${themed('999px', '8px')};
                background:${themed('rgba(255,255,255,0.08)', '#FFF1F1')};
                color:${themed('#f8fafc', '#E53935')};
                font-size:22px;
                font-weight:900;
                cursor:pointer;
                flex:0 0 auto;
              "
            >
              ×
            </button>
          </div>

          ${renderLastFinishedCampaignPanelHtml(options.campaignSummary, options.campaignHistoryOpen ?? false)}

          ${popupBody}
          `}
        </div>
      </div>
    </div>
  `
}
