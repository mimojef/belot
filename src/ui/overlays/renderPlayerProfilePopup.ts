import type {
  PlayerPublicProfileSnapshot,
  Seat,
} from '../../app/network/createGameServerClient'

export type RenderPlayerProfilePopupOptions = {
  isOpen: boolean
  seat: Seat | null
  profile: PlayerPublicProfileSnapshot | null
  isLoading?: boolean
  canEdit?: boolean
  isOwnProfile?: boolean
  isAdmin?: boolean
  friendshipAction?: PlayerProfileFriendshipAction | null
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
   */
  ownVipActiveUntil?: string | null
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
}

export type PlayerAccountRole = 'player' | 'chat_admin' | 'pika_team' | 'top_chat_admin' | 'subadmin' | 'admin'

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

function renderLevelBadge(level: number | null | undefined, size: 'sm' | 'md' = 'md'): string {
  if (typeof level !== 'number' || !Number.isFinite(level) || level < 1) return ''
  const sz = size === 'sm' ? '16px' : '20px'
  const fs = size === 'sm' ? '9px' : '11px'
  return `<div style="position:absolute;right:4px;bottom:4px;min-width:${sz};height:${sz};border-radius:999px;background:#000000;display:flex;align-items:center;justify-content:center;padding:0 3px;line-height:1;z-index:1;color:#ffffff;font-size:${fs};font-weight:700;">${Math.trunc(level)}</div>`
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

function renderRankProgress(profile: PlayerPublicProfileSnapshot): string {
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
        border-radius:8px;
        background:linear-gradient(180deg, rgba(22,22,22,0.98) 0%, rgba(8,8,8,0.99) 100%);
        border:1px solid rgba(212,165,32,0.42);
        padding:16px;
        box-shadow:inset 0 0 18px rgba(212,165,32,0.04);
      "
    >
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;">
        <div style="display:flex;align-items:center;gap:10px;min-width:0;">
          <div
            style="
              width:42px;
              height:42px;
              border-radius:8px;
              border:1px solid rgba(212,165,32,0.72);
              background:rgba(212,165,32,0.10);
              color:#d4a520;
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
            <div style="font-size:13px;font-weight:900;letter-spacing:0.12em;text-transform:uppercase;color:#d4a520;">
              Ранг
            </div>
            <div style="margin-top:4px;font-size:18px;font-weight:900;color:#f8fafc;">
              ${escapeHtml(profile.rankTitle ?? (rankLevel ? `Ранг ${rankLevel}` : 'Ранг'))}
            </div>
          </div>
        </div>
        <div style="font-size:14px;font-weight:900;color:#f8fafc;white-space:nowrap;">
          ${formatInteger(completedGames)} / ${formatInteger(nextRankGames)}
        </div>
      </div>

      <div style="height:12px;border-radius:999px;background:#050505;border:1px solid rgba(255,255,255,0.08);overflow:hidden;">
        <div
          style="
            width:${(ratio * 100).toFixed(2)}%;
            height:100%;
            border-radius:999px;
            background:linear-gradient(90deg, #d4a520 0%, #f4c95b 100%);
            box-shadow:0 0 12px rgba(212,165,32,0.36);
          "
        ></div>
      </div>

      <div style="margin-top:9px;font-size:12px;font-weight:800;color:rgba(226,232,240,0.70);">
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

  const statItem = (label: string, value: string, accent = '#f8fafc') => `
    <span style="white-space:nowrap;color:rgba(148,163,184,0.80);font-size:13px;font-weight:400;">
      ${escapeHtml(label)}:&nbsp;<span style="color:${accent};font-weight:500;">${value}</span>
    </span>
  `

  const divider = `<span style="display:inline-block;width:1px;height:13px;background:rgba(212,165,32,0.35);vertical-align:middle;flex:0 0 auto;"></span>`

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
      ${statItem('Победи', formatInteger(wonGames), '#fde68a')}
      ${divider}
      ${statItem('Успех', escapeHtml(successRate), '#86efac')}
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
        color:rgba(148,163,184,0.80);
        font-size:13px;
        font-weight:400;
        white-space:nowrap;
      "
    >
      <span
        data-player-profile-inline-rating-divider="1"
        style="width:1px;height:18px;background:rgba(212,165,32,0.45);display:inline-block;flex:0 0 auto;"
      ></span>
      <span style="overflow:hidden;text-overflow:ellipsis;">
        Оценка: <span style="color:#d4a520;font-weight:400;">${formatAverageRating(profile.averageRating)}</span>
        от <span style="color:#fde68a;font-weight:400;">${formatNullableText(profile.totalRatingsCount)}</span>
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
          border-radius:20px;
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
        border-radius:20px;
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
          border-radius:16px;
          border:1px dashed rgba(148,163,184,0.30);
          background:rgba(255,255,255,0.04);
          min-height:96px;
          display:flex;
          align-items:center;
          justify-content:center;
          color:rgba(226,232,240,0.72);
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
                border-radius:16px;
                overflow:hidden;
                aspect-ratio:1/1;
                background:rgba(255,255,255,0.06);
                border:1px solid rgba(255,255,255,0.08);
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
        color:#f8fafc;
      "
    >
      <div
        style="
          width:52px;
          height:52px;
          border-radius:999px;
          border:4px solid rgba(255,255,255,0.16);
          border-top-color:rgba(245,187,55,0.96);
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
          color:rgba(226,232,240,0.80);
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
          color:#f8fafc;
        "
      >
        <div
          style="
            font-size:15px;
            line-height:1.5;
            color:rgba(226,232,240,0.92);
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
        color:#f8fafc;
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
          color:rgba(226,232,240,0.80);
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
          background:rgba(212,165,32,0.16);
          border:1px solid rgba(212,165,32,0.58);
          color:#d4a520;
          font-size:11px;
          font-weight:900;
          letter-spacing:0.04em;
          text-transform:uppercase;
          white-space:nowrap;
          text-shadow:0 0 8px rgba(212,165,32,0.32);
        "
      >VIP</span>
      ${viewerIsFullAdmin ? `<span style="font-size:13px;font-weight:400;color:#f8fafc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(formatVipDaysWords(vipDays))}</span>` : ''}
    </div>
  `
}

/**
 * Компактна собствена profile summary зона — баланс + VIP оставащи дни +
 * Редакция, стек от вертикални редове вдясно от avatar-а (mobile-first,
 * виж CLAUDE.md/task brief-а). VIP редът е ВИНАГИ видим за собствения
 * профил (дори без активен VIP → "VIP · 0 дни"), за да не мести layout-а
 * според VIP статус.
 */
function renderOwnProfileSummary(profile: PlayerPublicProfileSnapshot, ownVipActiveUntil: string | null): string {
  const hasBalance = profile.yellowCoinsBalance !== null && profile.yellowCoinsBalance !== undefined
  const vipDays = computeVipRemainingDays(ownVipActiveUntil)

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
            color:#d4a520;
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
        style="font-size:13px;letter-spacing:0.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
      ><span style="color:#d4a520;font-weight:800;">VIP · </span><span style="color:#f8fafc;font-weight:400;">${escapeHtml(formatVipDaysWords(vipDays))}</span></div>
      <span
        data-player-profile-edit="1"
        style="
          display:inline-flex;
          align-items:center;
          gap:7px;
          color:#f8fafc;
          font-size:15px;
          font-weight:400;
          cursor:pointer;
          white-space:nowrap;
          width:fit-content;
          margin-top:6px;
        "
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        Редакция
      </span>
    </div>
  `
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
            color:#d4a520;
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
  ownVipActiveUntil: string | null,
  vipGrantOpen: boolean,
  vipGrantSubmitting: boolean,
  vipGrantErrorText: string | null,
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
              border-radius:20px;
              overflow:hidden;
              background:rgba(255,255,255,0.06);
              border:1px solid rgba(255,255,255,0.10);
              box-shadow:0 14px 28px rgba(0,0,0,0.22);
            "
          >
            ${renderAvatar(profile, seat)}
          </div>
          ${renderLevelBadge(profile.level)}
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
              border:2px solid #0a0a0a;
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
                color:#22c55e;
                word-break:break-word;
              "
            >
              ${escapeHtml(displayName)}
            </div>

            ${(canEdit || isAdmin) && !isOwnProfile ? `
              <span
                data-player-profile-edit="1"
                style="
                  display:inline-flex;
                  align-items:center;
                  gap:7px;
                  color:#f8fafc;
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
            ${renderVipGrantTrigger(profile.profileId, isOwnProfile, viewerIsFullAdmin, vipGrantOpen)}
          </div>

          ${renderVipGrantForm(profile.profileId, isOwnProfile, viewerIsFullAdmin, vipGrantOpen, vipGrantSubmitting, vipGrantErrorText)}

          ${isOwnProfile ? renderOwnProfileSummary(profile, ownVipActiveUntil) : renderForeignProfileSummary(profile, viewerIsFullAdmin)}

          <div data-player-profile-rating="1" style="display:flex;align-items:center;gap:6px;">
            <div style="font-size:13px;font-weight:400;color:rgba(148,163,184,0.80);">Рейтинг:</div>
            <div style="font-size:13px;font-weight:400;color:#d4a520;">${formatNullableText(profile.skillRating)}</div>
            ${renderRatingInline(profile)}
          </div>

          ${!canEdit && !isOwnProfile ? `
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
                    style="
                      min-height:38px;
                      padding:0 14px;
                      border:1px solid rgba(212,165,32,0.62);
                      border-radius:8px;
                      background:${friendshipAction.disabled ? 'rgba(255,255,255,0.07)' : 'linear-gradient(180deg, rgba(244,201,91,0.98) 0%, rgba(201,143,19,0.98) 100%)'};
                      color:${friendshipAction.disabled ? 'rgba(255,255,255,0.70)' : '#080808'};
                      font-size:13px;
                      font-weight:900;
                      cursor:${friendshipAction.disabled ? 'default' : 'pointer'};
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
                      "
                    >
                      Подари жълтици
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
                    "
                  >
                    ${profile.isBlockedByMe ? 'Деблокирай' : 'Блокирай'}
                  </button>
                ` : ''}
              </div>
              ${friendshipAction?.message ? `
                <div style="font-size:12px;font-weight:800;color:#fde68a;line-height:1.35;">
                  ${escapeHtml(friendshipAction.message)}
                </div>
              ` : ''}
            </div>
          ` : ''}

          <div data-player-profile-stats="1" style="display:flex;align-items:center;margin-top:auto;padding-bottom:2px;">
            <div data-player-profile-stat="1" style="font-size:13px;color:rgba(255,255,255,0.55);padding-right:12px;">
              Ниво: <span data-player-profile-stat-value="1" style="color:#fde68a;font-weight:700;">${formatNullableText(profile.level)}</span>
            </div>
            <div data-player-profile-stat-divider="1" style="width:1px;align-self:stretch;background:rgba(212,165,32,0.45);"></div>
            <div data-player-profile-stat="1" style="font-size:13px;color:rgba(255,255,255,0.55);padding:0 12px;">
              Ранг: <span data-player-profile-stat-value="1" style="color:#fde68a;font-weight:700;">${formatNullableText(profile.rankTitle)}</span>
            </div>
            ${typeof profile.likesCount === 'number' ? `
            <div data-player-profile-stat-divider="1" style="width:1px;align-self:stretch;background:rgba(212,165,32,0.45);"></div>
            <div data-player-profile-stat="1" style="font-size:13px;color:rgba(255,255,255,0.55);padding:0 12px;">
              ${renderHeartIcon(14)} Харесан: <span data-player-profile-stat-value="1" style="color:#fde68a;font-weight:700;">${profile.likesCount.toLocaleString('bg-BG')}</span>
            </div>
            ` : ''}
          </div>
        </div>
      </div>

      ${renderRankProgress(profile)}

      ${renderGameStats(profile)}

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
            color:rgba(148,163,184,0.92);
          "
        >
          Галерия
        </div>

        ${renderGallery(profile)}
      </div>
    </div>
  `
}

export function renderPlayerProfilePopup(
  options: RenderPlayerProfilePopupOptions
): string {
  if (!options.isOpen) {
    return ''
  }

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
          options.ownVipActiveUntil ?? null,
          options.vipGrantOpen ?? false,
          options.vipGrantSubmitting ?? false,
          options.vipGrantErrorText ?? null,
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
      [data-player-profile-gift-coins]:hover,
      [data-player-profile-gift-coins-bypass]:hover {
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
      [data-player-profile-gift-coins],
      [data-player-profile-gift-coins-bypass],
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
          flex-wrap:nowrap !important;
        }

        [data-player-profile-actions="1"] button {
          flex:1 !important;
          min-width:0 !important;
          padding:0 8px !important;
          font-size:12px !important;
          justify-content:center;
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
      }
    </style>

    <div
      data-player-profile-popup-root="1"
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
          background:rgba(0, 0, 0, 0.72);
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
            border-radius:8px;
            background:linear-gradient(180deg, rgba(32,32,32,0.98) 0%, rgba(8,8,8,0.99) 100%);
            border:2px solid rgba(212,165,32,0.72);
            box-shadow:0 34px 80px rgba(0,0,0,0.42);
            padding:24px 24px 22px;
            animation:${options.skipAnimation ? 'none' : 'belot-player-profile-fade-in 160ms ease both'};
          "
        >
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
                  color:rgba(148,163,184,0.92);
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
                border:none;
                border-radius:999px;
                background:rgba(255,255,255,0.08);
                color:#f8fafc;
                font-size:22px;
                font-weight:900;
                cursor:pointer;
                flex:0 0 auto;
              "
            >
              ×
            </button>
          </div>

          ${popupBody}
        </div>
      </div>
    </div>
  `
}
