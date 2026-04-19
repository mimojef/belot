import type {
  PlayerPublicProfileSnapshot,
  Seat,
} from '../../app/network/createGameServerClient'

export type RenderPlayerProfilePopupOptions = {
  isOpen: boolean
  seat: Seat | null
  profile: PlayerPublicProfileSnapshot | null
  isLoading?: boolean
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

function formatAverageRating(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—'
  }

  return escapeHtml(value.toFixed(2))
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
              style="
                position:relative;
                border-radius:16px;
                overflow:hidden;
                aspect-ratio:1/1;
                background:rgba(255,255,255,0.06);
                border:1px solid rgba(255,255,255,0.08);
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

function renderEmptyContent(seat: Seat | null): string {
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

function renderProfileContent(profile: PlayerPublicProfileSnapshot, seat: Seat | null): string {
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
        style="
          display:grid;
          grid-template-columns:124px minmax(0, 1fr);
          gap:18px;
          align-items:start;
        "
      >
        <div
          style="
            width:124px;
            height:124px;
            border-radius:20px;
            overflow:hidden;
            background:rgba(255,255,255,0.06);
            border:1px solid rgba(255,255,255,0.10);
            box-shadow:0 14px 28px rgba(0,0,0,0.22);
          "
        >
          ${renderAvatar(profile, seat)}
        </div>

        <div
          style="
            min-width:0;
            display:flex;
            flex-direction:column;
            gap:10px;
            padding-top:4px;
          "
        >
          <div
            style="
              font-size:30px;
              line-height:1.05;
              font-weight:900;
              color:#f8fafc;
              word-break:break-word;
            "
          >
            ${escapeHtml(displayName)}
          </div>

          <div
            style="
              display:flex;
              flex-wrap:wrap;
              gap:8px;
            "
          >
            <div
              style="
                display:inline-flex;
                align-items:center;
                min-height:32px;
                padding:0 12px;
                border-radius:999px;
                background:rgba(245,187,55,0.16);
                border:1px solid rgba(245,187,55,0.24);
                color:#fde68a;
                font-size:13px;
                font-weight:900;
                letter-spacing:0.03em;
              "
            >
              Ниво: ${formatNullableText(profile.level)}
            </div>

            <div
              style="
                display:inline-flex;
                align-items:center;
                min-height:32px;
                padding:0 12px;
                border-radius:999px;
                background:rgba(59,130,246,0.16);
                border:1px solid rgba(59,130,246,0.24);
                color:#bfdbfe;
                font-size:13px;
                font-weight:900;
                letter-spacing:0.03em;
              "
            >
              Ранг: ${formatNullableText(profile.rankTitle)}
            </div>
          </div>
        </div>
      </div>

      <div
        style="
          display:grid;
          grid-template-columns:repeat(2, minmax(0, 1fr));
          gap:12px;
        "
      >
        <div
          style="
            border-radius:16px;
            background:rgba(255,255,255,0.05);
            border:1px solid rgba(255,255,255,0.08);
            padding:14px;
          "
        >
          <div
            style="
              font-size:12px;
              font-weight:800;
              letter-spacing:0.12em;
              text-transform:uppercase;
              color:rgba(148,163,184,0.92);
              margin-bottom:8px;
            "
          >
            Рейтинг
          </div>
          <div
            style="
              font-size:26px;
              font-weight:900;
              color:#f8fafc;
            "
          >
            ${formatNullableText(profile.skillRating)}
          </div>
        </div>

        <div
          style="
            border-radius:16px;
            background:rgba(255,255,255,0.05);
            border:1px solid rgba(255,255,255,0.08);
            padding:14px;
          "
        >
          <div
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
            style="
              font-size:26px;
              font-weight:900;
              color:#f8fafc;
            "
          >
            ${formatAverageRating(profile.averageRating)}
          </div>
          <div
            style="
              margin-top:6px;
              font-size:12px;
              color:rgba(226,232,240,0.72);
              font-weight:700;
            "
          >
            Оценки: ${formatNullableText(profile.totalRatingsCount)}
          </div>
        </div>

        <div
          style="
            border-radius:16px;
            background:rgba(255,255,255,0.05);
            border:1px solid rgba(255,255,255,0.08);
            padding:14px;
          "
        >
          <div
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
            style="
              font-size:26px;
              font-weight:900;
              color:#f8fafc;
            "
          >
            ${formatNullableText(profile.yellowCoinsBalance)}
          </div>
        </div>

        <div
          style="
            border-radius:16px;
            background:rgba(255,255,255,0.05);
            border:1px solid rgba(255,255,255,0.08);
            padding:14px;
          "
        >
          <div
            style="
              font-size:12px;
              font-weight:800;
              letter-spacing:0.12em;
              text-transform:uppercase;
              color:rgba(148,163,184,0.92);
              margin-bottom:8px;
            "
          >
            Профил
          </div>
          <div
            style="
              font-size:14px;
              font-weight:800;
              color:#f8fafc;
              line-height:1.4;
              word-break:break-word;
            "
          >
            ${formatNullableText(profile.profileId)}
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
      ? renderProfileContent(options.profile, options.seat)
      : renderEmptyContent(options.seat)

  const safeTitle = escapeHtml(
    options.profile?.displayName?.trim() || formatSeatLabel(options.seat)
  )

  return `
    <style>
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

      @keyframes belot-player-profile-spin {
        100% {
          transform:rotate(360deg);
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
          background:rgba(2, 6, 23, 0.68);
          backdrop-filter:blur(4px);
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
          style="
            position:relative;
            width:min(92vw, 760px);
            max-height:min(88vh, 860px);
            overflow:auto;
            border-radius:28px;
            background:linear-gradient(180deg, rgba(9, 20, 38, 0.98) 0%, rgba(13, 29, 52, 0.98) 100%);
            border:1px solid rgba(255,255,255,0.12);
            box-shadow:0 34px 80px rgba(0,0,0,0.42);
            padding:24px 24px 22px;
            animation:belot-player-profile-fade-in 160ms ease forwards;
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

              <div
                style="
                  font-size:26px;
                  font-weight:900;
                  line-height:1.08;
                  color:#f8fafc;
                  word-break:break-word;
                "
              >
                ${safeTitle}
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